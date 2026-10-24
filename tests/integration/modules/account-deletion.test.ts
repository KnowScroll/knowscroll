import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELETED_ACCOUNT_LABEL } from '@knowscroll/contracts';
import { eraseCurrentAccount, exportCurrentPerson, personalStores } from '@knowscroll/backend/erasure-registry';
import type { IdentitySettings } from '@knowscroll/backend/infrastructure/config';
import { checkErasureInventory } from '@knowscroll/backend/infrastructure/erasure';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { deleteAccountQueue } from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  dataExportFor,
  deleteAccountFor,
  identityUseCases,
  recordingPolicyFor,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { makeAttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { heartbeatRecorder, socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { everyStoreSeeder } from '../support/every-store.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { befriend, pairRevision, seedContent, seedFriend, talkCases } from '../support/talk.js';
import { visitCases } from '../support/visit-world.js';

/**
 * Account deletion (#246, D-043) against a real PostgreSQL 16 database: the fence, the erasure of
 * every registered store (read from the registry, not from a list in this test), idempotence, a
 * crash in the middle, accounting that holds the universe, and what a deleted account can no
 * longer do. Evidence label: CI fixture accounts and authored erasure fixtures, real database, no
 * provider calls.
 */
const settings: IdentitySettings = {
  publicOrigin: 'https://app.ci.invalid',
  secureCookies: true,
  mail: { sender: 'fixture', outboxFile: undefined },
  operatorSignIn: undefined,
  nativeSignInBinding: false,
};

/** Stores a fresh person is not expected to fill: accounting identities of unfinished model work. */
const NOT_SEEDED = new Set([
  'identity.clear_liabilities',
  'identity.account_deletions',
  // Keyed by the friendship, not by an account: it outlives the deleted person for the one who remains.
  'social.conversations',
  // Reached only through its message, which has an author column of its own: the thread tests prove it goes.
  'social.message_snippets',
]);

type EraseAccountData = Parameters<typeof deleteAccountFor>[2]['eraseAccountData'];

describe('account deletion (real database)', () => {
  let database: TestDatabase<Database>;
  let boss: ReturnType<typeof createBoss>;
  let seeder: Awaited<ReturnType<typeof everyStoreSeeder>>;
  const mail: { to: string; link: string }[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('account_deletion');
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    seeder = await everyStoreSeeder(database);
  });
  afterAll(async () => {
    await seeder.close();
    await boss.stop({ graceful: false });
    await database.drop();
  });

  const identity = () =>
    identityUseCases({
      db: database.db,
      settings,
      lockTimeoutMs: 5_000,
      logEvent: () => undefined,
      mailSender: (message) => {
        mail.push(message);
        return Promise.resolve({ kind: 'sent' });
      },
    });
  const deleting = (eraseAccountData: EraseAccountData = eraseCurrentAccount) =>
    deleteAccountFor(database.db, boss, { eraseAccountData, lockTimeoutMs: 5_000 });
  const enteredScope = (person: FixturePerson) =>
    makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, () => Promise.resolve('entered'));

  async function emailOf(accountId: string): Promise<string> {
    const row = await database.db
      .selectFrom('identity.email_addresses')
      .select('address')
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    return row.address;
  }

  /** Asks for a sign-in link for `address` and returns its token, as mailed. */
  async function requestLink(address: string): Promise<string> {
    const requested = await identity().requestSignIn({ email: address });
    if (requested.kind !== 'requested') throw new Error('sign-in not requested');
    await requested.delivery;
    return new URL(mail.at(-1)?.link ?? '').hash.replace(/^#token=/, '');
  }

  /** A real sign-in by mailed link for an existing account's address: a web session with a label. */
  async function signIn(accountId: string, deviceLabel = 'Chrome on macOS') {
    const token = await requestLink(await emailOf(accountId));
    const result = await identity().redeemSignIn({ token, commandId: randomUUID(), client: 'web', deviceLabel });
    if (result.kind !== 'signed_in') throw new Error('sign-in refused');
    return result.session;
  }

  function socialFor() {
    const access = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5_000 });
    return socialUseCases({
      withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      fenceOwn: access.fenceOwnAccount,
      fencePair: access.fenceAccountPair,
    });
  }

  async function claimProfile(person: FixturePerson, handle: string) {
    const social = socialFor();
    const set = await social.setProfile(person.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle,
      displayName: `Name of ${handle}`,
    });
    if (set.kind !== 'ok') throw new Error('profile refused');
    const read = await social.readProfile(person.authority);
    if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('profile unreadable');
    return read.value.person;
  }

  async function countWhere(table: string, column: string, value: string): Promise<number> {
    const result = await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.table(table)} where ${sql.ref(column)}::text = ${value}`.execute(
      database.db,
    );
    return result.rows[0]?.n ?? 0;
  }

  /** Row counts of every store the registry declares for one account: the registry decides what to look at. */
  async function footprint(person: FixturePerson, address: string, personId?: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const add = (store: string, rows: number) => (counts[store] = (counts[store] ?? 0) + rows);
    for (const declaration of personalStores) {
      for (const table of declaration.tables)
        add(
          `${table.schema}.${table.table}`,
          await countWhere(`${table.schema}.${table.table}`, table.ownerColumn, person.universeId),
        );
      for (const table of declaration.accountTables ?? [])
        for (const column of table.ownerColumn.split(','))
          add(
            `${table.schema}.${table.table}`,
            await countWhere(
              `${table.schema}.${table.table}`,
              column,
              column === 'address' ? address : person.accountId,
            ),
          );
      for (const column of declaration.accountColumns ?? []) {
        // A person column holds the sharing person id, not the account id.
        const value = column.column.endsWith('person_id') ? personId : person.accountId;
        if (value !== undefined)
          add(
            `${column.schema}.${column.table}`,
            await countWhere(`${column.schema}.${column.table}`, column.column, value),
          );
      }
      for (const store of declaration.nonRowStores.filter((candidate) => candidate.name.startsWith('pgboss/'))) {
        const queue = store.name.slice('pgboss/'.length);
        const named = await sql<{ n: number }>`select count(*)::int as n from pgboss.job
          where name in (${queue}, ${`${queue}.dead`})
            and (data ->> 'universeId' = ${person.universeId} or data ->> 'accountId' = ${person.accountId})`.execute(
          database.db,
        );
        add(store.name, named.rows[0]?.n ?? 0);
      }
    }
    return counts;
  }

  /** A person who paused recording and then cleared: fills the Clear and recording receipts. */
  async function clearedPerson(): Promise<FixturePerson> {
    const person = await recordingPerson(database);
    const paused = await recordingPolicyFor(database.db, { lockTimeoutMs: 5_000 }).set(person.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: 1,
      on: false,
    });
    expect(paused.kind).toBe('ok');
    await clearRecordingPerson(database, boss, person);
    return { ...person, authority: { ...person.authority, privacyEpoch: 2 } };
  }

  let scenarioThreadId = '';
  /** Authored erasure-only rows: a member's unanswered draft, and a branch they started with their own words. */
  async function seedScenarioRows(person: FixturePerson, threadId: string) {
    const now = new Date();
    await database.db
      .insertInto('scenarios.drafts')
      .values({
        draft_id: randomUUID(),
        thread_id: threadId,
        requester_account_id: person.accountId,
        requester_universe_id: person.universeId,
        privacy_epoch: 1,
        kind: 'what_if',
        origin_kind: 'root',
        parent_revision: 1,
        request_text: 'Authored erasure-only words of a draft',
        state: 'thinking',
        created_at: now,
        expires_at: new Date(now.getTime() + 3_600_000),
      })
      .execute();
    await database.db
      .insertInto('scenarios.nodes')
      .values({
        node_id: randomUUID(),
        thread_id: threadId,
        kind: 'what_if',
        origin_kind: 'root',
        started_by_account_id: person.accountId,
        title: 'Authored erasure-only branch',
        changes: JSON.stringify([{ subject: 'Fixture', statement: 'An authored erasure-only premise' }]),
        kept: '[]',
        assumptions: JSON.stringify([{ subject: 'Fixture', statement: 'An authored erasure-only premise' }]),
        hypothetical: true,
        semantic_key: 'a'.repeat(64),
        status: 'preparing',
        revision: 1,
        asset_id: randomUUID(),
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  const deletionJobs = async (deletionId: string) =>
    (
      await sql<{ n: number }>`select count(*)::int as n from pgboss.job
        where name = ${deleteAccountQueue.name} and data ->> 'deletionId' = ${deletionId}`.execute(database.db)
    ).rows[0]?.n;

  it('erases every registered personal store of the account and nothing of anyone else', async () => {
    {
      const erased = await recordingPerson(database);
      const kept = await recordingPerson(database);
      const cleared = await clearedPerson();
      const friend = await seedPerson(database.db);
      await seeder.seed(erased);
      await seeder.seed(kept);

      // Account-lifetime records, each through the real path or a labelled fixture row.
      await signIn(erased.accountId);
      await signIn(kept.accountId);
      await signIn(cleared.accountId);
      const address = await emailOf(erased.accountId);
      const clearedAddress = await emailOf(cleared.accountId);
      const staleLink = await requestLink(address);
      const erasedPerson = await claimProfile(erased, 'deleted.person');
      const friendPerson = await claimProfile(friend, 'staying.friend');
      const social = socialFor();
      expect(
        (
          await social.command(erased.authority, 'request', {
            version: 'sharing.v1',
            commandId: randomUUID(),
            expectedPeerPersonId: friendPerson.personId,
            expectedPairRevision: 0,
            target: { kind: 'handle', handle: 'staying.friend' },
          })
        ).kind,
      ).toBe('ok');
      await social.createInvite(erased.authority, {
        version: 'sharing.v1',
        commandId: randomUUID(),
        expectedInviteRevision: 0,
      });
      // Talk: a friend, a conversation with a message each way and a shared link.
      const talk = talkCases(database.db);
      const buddy = await seedFriend(database.db, talk.friends);
      const erasedAsFriend = { ...erased, person: erasedPerson };
      await befriend(talk.friends, erasedAsFriend, buddy);
      // What the person lets friends see: the real preference and heartbeat, and a labelled audience
      // row (choosing a friend needs a readable Geography, which an erasure fixture does not hold).
      const visits = visitCases(database.db);
      expect(
        (
          await visits.visibility.setPresencePreference(erased.authority, {
            version: 'sharing.v1',
            commandId: randomUUID(),
            expectedPresencePreferenceRevision: 1,
            preference: 'online',
          })
        ).kind,
      ).toBe('ok');
      await heartbeatRecorder(database.db)(erased.accountId);
      await database.db
        .insertInto('social.visibility_audience')
        .values({ owner_account_id: erased.accountId, friend_account_id: buddy.accountId })
        .execute();
      const started = await talk.talk.conversations.start(erased.authority, {
        version: 'direct-conversation.v1',
        commandId: randomUUID(),
        peerPersonId: buddy.person.personId,
        expectedPairRevision: await pairRevision(talk.friends, erasedAsFriend, buddy),
      });
      if (started.kind !== 'ok') throw new Error('conversation not started');
      const talkContent = await seedContent(database.db);
      expect(
        (
          await talk.talk.conversations.send(erased.authority, {
            version: 'direct-conversation.v1',
            commandId: randomUUID(),
            conversation: started.value.conversation,
            body: { kind: 'text', text: 'a message from the person who will delete their account' },
          })
        ).kind,
      ).toBe('ok');
      // A content thread the person started, with the friend invited into it.
      const startedThread = await talk.threads.create(erased.authority, {
        version: 'content-thread.v1',
        commandId: randomUUID(),
        root: { assetId: talkContent.assetId, assetRevision: 1 },
        friendPersonIds: [buddy.person.personId],
        name: 'a thread the person who will delete their account started',
      });
      expect(startedThread.kind).toBe('ok');
      if (startedThread.kind !== 'ok') throw new Error('thread not started');
      // What they asked of the Scenario Planner there: a draft (theirs alone) and a branch (the thread's).
      scenarioThreadId = startedThread.value.thread.threadId;
      await seedScenarioRows(erased, scenarioThreadId);
      expect(
        (
          await talk.talk.shares.create(erased.authority, {
            version: 'content-share.v1',
            commandId: randomUUID(),
            target: { assetId: talkContent.assetId, assetRevision: 1 },
            audience: { kind: 'public_metadata' },
          })
        ).kind,
      ).toBe('ok');
      await database.db
        .insertInto('receipts.shared_commands')
        .values({
          scope_kind: 'fixture',
          scope_id: randomUUID(),
          actor_account_id: erased.accountId,
          operation: 'fixture.shared',
          command_id: randomUUID(),
          request_hash: 'a'.repeat(64),
        })
        .execute();
      const exports = dataExportFor(database.db, boss, { gather: exportCurrentPerson, lockTimeoutMs: 5_000 });
      expect((await exports.request(erased.authority, { exportId: randomUUID() })).kind).toBe('accepted');
      expect(await countWhere('ops.operator_sign_ins', 'account_id', erased.accountId)).toBe(1);
      expect(await countWhere('social.roster_entries', 'owner_account_id', friend.accountId)).toBe(1);

      const before = await footprint(erased, address, erasedPerson.personId);
      const clearedBefore = await footprint(cleared, clearedAddress);
      // The test must have put something in every store it later finds empty.
      for (const [store, rows] of Object.entries(before)) {
        if (NOT_SEEDED.has(store) || store.startsWith('pgboss/')) continue;
        expect(rows + (clearedBefore[store] ?? 0), `${store} was never filled by this test`).toBeGreaterThan(0);
      }

      // The fence.
      const receiptId = randomUUID();
      const use = deleting();
      expect(await use.request(erased.authority, { receiptId })).toMatchObject({ kind: 'accepted', receiptId });
      expect(
        await database.db
          .selectFrom('identity.universes as universe')
          .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
          .select(['universe.status as universeStatus', 'universe.privacy_epoch', 'account.status as accountStatus'])
          .where('universe.id', '=', erased.universeId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ universeStatus: 'deleting', accountStatus: 'deleting', privacy_epoch: 2 });
      expect(await countWhere('identity.sessions', 'account_id', erased.accountId)).toBe(0);
      expect(await deletionJobs(receiptId)).toBe(1);
      expect(await use.readReceipt(receiptId)).toBe('in_progress');
      expect((await enteredScope(erased)).kind).toBe('refused');

      // The erasure.
      expect(await use.process({ v: 1, deletionId: receiptId })).toBe('completed');

      // Registry-driven: every declared store of the account is empty, and the roots are gone.
      expect(
        Object.entries(await footprint(erased, address, erasedPerson.personId)).filter(([, rows]) => rows > 0),
        'stores that still hold the deleted account',
      ).toEqual([]);
      expect(await countWhere('identity.accounts', 'id', erased.accountId)).toBe(0);
      expect(await countWhere('identity.universes', 'id', erased.universeId)).toBe(0);
      // The friend keeps the thread they were invited to, now naming nobody.
      const buddyThreads = await talk.threads.inbox(buddy.authority, {
        version: 'content-thread.v1',
        readId: randomUUID(),
        limit: 10,
      });
      expect(
        buddyThreads.kind === 'ok' &&
          buddyThreads.value.items.map((item) => item.people.map((person) => person.displayName)),
      ).toEqual([[DELETED_ACCOUNT_LABEL]]);
      // The branch they started stays for the thread, with its title and premises and without their authorship; their draft is gone.
      expect(
        await database.db
          .selectFrom('scenarios.nodes')
          .select(['started_by_account_id', 'title', 'changes'])
          .where('thread_id', '=', scenarioThreadId)
          .execute(),
      ).toEqual([
        {
          started_by_account_id: null,
          title: 'Authored erasure-only branch',
          changes: [{ subject: 'Fixture', statement: 'An authored erasure-only premise' }],
        },
      ]);
      expect(await countWhere('scenarios.drafts', 'thread_id', scenarioThreadId)).toBe(0);
      expect(
        await database.db
          .selectFrom('identity.account_deletions')
          .selectAll()
          .where('id', '=', receiptId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ state: 'completed', account_id: null, scope_id: null, failure_code: null });
      expect(await use.readReceipt(receiptId)).toBe('completed');
      // The operator audit keeps its row, anonymously.
      expect(
        (await database.db.selectFrom('ops.operator_sign_ins').select('id').where('account_id', 'is', null).execute())
          .length,
      ).toBeGreaterThan(0);

      // An old link cannot bring the account back; the address is free for a new, empty account.
      expect(await identity().redeemSignIn({ token: staleLink, commandId: randomUUID(), client: 'web' })).toEqual({
        kind: 'refused',
        reason: 'link_invalid',
      });
      const fresh = await identity().redeemSignIn({
        token: await requestLink(address),
        commandId: randomUUID(),
        client: 'web',
      });
      if (fresh.kind !== 'signed_in') throw new Error('a new account should be allowed for a freed address');
      expect(fresh.outcome.accountCreated).toBe(true);
      expect(fresh.outcome.accountId).not.toBe(erased.accountId);
      expect(fresh.outcome.universeId).not.toBe(erased.universeId);

      // Other people are untouched.
      expect(await countWhere('social.roster_entries', 'owner_account_id', friend.accountId)).toBe(0);
      expect(await countWhere('social.profiles', 'account_id', friend.accountId)).toBe(1);
      expect(await countWhere('identity.accounts', 'id', kept.accountId)).toBe(1);
      expect(await countWhere('experience.exposures', 'universe_id', kept.universeId)).toBeGreaterThan(0);
      expect(await countWhere('identity.sessions', 'account_id', kept.accountId)).toBe(1);
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);

      // A person who cleared first is deleted just as completely, Clear receipts included.
      expect(await countWhere('identity.clear_operations', 'account_id', cleared.accountId)).toBe(1);
      const clearedReceipt = randomUUID();
      expect((await use.request(cleared.authority, { receiptId: clearedReceipt })).kind).toBe('accepted');
      expect(await use.process({ v: 1, deletionId: clearedReceipt })).toBe('completed');
      expect(
        Object.entries(await footprint(cleared, clearedAddress)).filter(([, rows]) => rows > 0),
        'stores that still hold the deleted account that cleared first',
      ).toEqual([]);
    }
  });

  it('is idempotent, and a crash in the middle loses nothing and resurrects nothing', async () => {
    {
      const person = await recordingPerson(database);
      await seeder.seed(person);
      await signIn(person.accountId);
      const address = await emailOf(person.accountId);
      const before = await footprint(person, address);
      const receiptId = randomUUID();
      let crashes = 1;
      const crashingAfterErasing: EraseAccountData = async (scope) => {
        const reports = await eraseCurrentAccount(scope);
        if (crashes-- > 0) throw new Error('CI crash after every eraser ran');
        return reports;
      };
      const use = deleting(crashingAfterErasing);
      expect((await use.request(person.authority, { receiptId })).kind).toBe('accepted');

      await expect(use.process({ v: 1, deletionId: receiptId })).rejects.toThrow('CI crash');
      // Rolled back as one: nothing was removed, the account is still fenced, the operation still pending.
      expect(await footprint(person, address)).toEqual({
        ...before,
        'identity.sessions': 0,
        'identity.account_deletions': 1,
        'pgboss/identity.delete-account': 0,
      });
      expect(await use.readReceipt(receiptId)).toBe('in_progress');

      // Redelivery finishes it; delivering again afterwards finds nothing to do.
      expect(await use.process({ v: 1, deletionId: receiptId })).toBe('completed');
      expect(await use.process({ v: 1, deletionId: receiptId })).toBe('gone');
      expect(await countWhere('identity.accounts', 'id', person.accountId)).toBe(0);

      // A stale worker, or a request made before the deletion, finds no universe to act on.
      expect(await enteredScope(person)).toEqual({ kind: 'refused', refusal: { kind: 'universe_missing' } });
      await expect(
        database.db
          .insertInto('experience.sessions')
          .values({
            universe_id: person.universeId,
            privacy_epoch: 1,
            id: randomUUID(),
            intent: JSON.stringify({}),
            intent_revision: 1,
            capabilities: JSON.stringify({}),
          })
          .execute(),
      ).rejects.toThrow();
      expect(await use.request(person.authority, { receiptId: randomUUID() })).toEqual({
        kind: 'refused',
        reason: 'unavailable',
      });
      const exports = dataExportFor(database.db, boss, { gather: exportCurrentPerson, lockTimeoutMs: 5_000 });
      expect(await exports.request(person.authority, { exportId: randomUUID() })).toEqual({
        kind: 'refused',
        reason: 'scope_refused',
      });
    }
  });

  it('accepts one request, refuses a concurrent second, and refuses a reused receipt', async () => {
    const person = await recordingPerson(database);
    const other = await recordingPerson(database);
    const use = deleting();
    const results = await Promise.all([
      use.request(person.authority, { receiptId: randomUUID() }),
      use.request(person.authority, { receiptId: randomUUID() }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['accepted', 'refused']);
    expect(await countWhere('identity.account_deletions', 'account_id', person.accountId)).toBe(1);
    // Another person cannot take over the first person's receipt id.
    const accepted = results.find((result) => result.kind === 'accepted');
    if (accepted?.kind !== 'accepted') throw new Error('one request should be accepted');
    expect(await use.request(other.authority, { receiptId: accepted.receiptId })).toEqual({
      kind: 'refused',
      reason: 'receipt_in_use',
    });
    expect(
      await database.db
        .selectFrom('identity.accounts')
        .select('status')
        .where('id', '=', other.accountId)
        .executeTakeFirst(),
    ).toEqual({ status: 'active' });
  });

  it('drops the account’s live sockets when the request commits, and sends nothing when it is refused', async () => {
    const person = await recordingPerson(database);
    const listener = await database.pool.connect();
    const notices: unknown[] = [];
    let done: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => (done = resolve));
    listener.on('notification', (event) => {
      if (event.channel === 'ks_access_revoked') notices.push(JSON.parse(event.payload ?? '{}'));
      if (event.channel === 'ci_barrier') done();
    });
    try {
      await listener.query('listen ks_access_revoked');
      await listener.query('listen ci_barrier');
      const use = deleting();
      const refused = await use.request({ ...person.authority, privacyEpoch: 9 }, { receiptId: randomUUID() });
      expect(refused).toEqual({ kind: 'refused', reason: 'epoch_changed' });
      expect((await use.request(person.authority, { receiptId: randomUUID() })).kind).toBe('accepted');
      await sql`select pg_notify('ci_barrier', 'done')`.execute(database.db);
      await barrier;
      expect(notices).toEqual([{ v: 1, accountId: person.accountId }]);
    } finally {
      await listener.query('unlisten *');
      listener.removeAllListeners('notification');
      listener.release();
    }
  });

  it('refuses a sign-in with an old link while the account is being deleted', async () => {
    const person = await recordingPerson(database);
    const link = await requestLink(await emailOf(person.accountId));
    const receiptId = randomUUID();
    const use = deleting();
    expect((await use.request(person.authority, { receiptId })).kind).toBe('accepted');
    expect(await identity().redeemSignIn({ token: link, commandId: randomUUID(), client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'account_unavailable',
    });
    expect(await use.process({ v: 1, deletionId: receiptId })).toBe('completed');
  });

  it('keeps the universe while accounting holds it, erases the rest, and finishes once it settles', async () => {
    const person = await recordingPerson(database);
    await signIn(person.accountId);
    const ledger = makeAttemptLedger(database.db);
    const attemptId = randomUUID();
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, async (scope) => {
      const runId = randomUUID();
      await ledger.admitRun(scope, {
        id: runId,
        ownerModule: 'fixture',
        purpose: 'fixture',
        roleId: 'fixture.deletion',
        roleVersion: 'v1',
        policyVersion: 'fixture.v1',
        provider: 'fixture',
        model: 'fixture',
        contextBundleRef: 'fixture.bundle:deletion',
        contextRefs: ['fixture:item'],
      });
      const requestBody = new TextEncoder().encode('{"fixture":"deletion"}');
      await ledger.reserve(scope, {
        id: attemptId,
        runId,
        step: 'primary',
        provider: 'fixture',
        model: 'fixture',
        roleId: 'fixture.deletion',
        roleVersion: 'v1',
        promptVersion: 'hp-fixture',
        requestHash: createHash('sha256').update(requestBody).digest('hex'),
        requestBody,
        maxOutputTokens: 16,
        reservedTokens: 37,
        requestRetentionSeconds: 3_600,
      });
      await ledger.commitDispatch(scope, attemptId, {
        dispatchId: randomUUID(),
        dispatchedBy: 'ci-fixture',
        quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
      });
    });
    const receiptId = randomUUID();
    const use = deleting();
    expect((await use.request(person.authority, { receiptId })).kind).toBe('accepted');

    expect(await use.process({ v: 1, deletionId: receiptId })).toBe('waiting_for_accounting');
    // Personal rows are gone already; only the accounting rows still name the (fenced) universe.
    expect(await countWhere('identity.email_addresses', 'account_id', person.accountId)).toBe(0);
    expect(await countWhere('reasoning.protected_requests', 'universe_id', person.universeId)).toBe(0);
    expect(await countWhere('reasoning.external_attempts', 'universe_id', person.universeId)).toBe(1);
    expect(await countWhere('identity.universes', 'id', person.universeId)).toBe(1);
    expect(await use.readReceipt(receiptId)).toBe('in_progress');
    expect(
      await database.db
        .selectFrom('identity.account_deletions')
        .select(['attempts', 'failure_code'])
        .where('id', '=', receiptId)
        .executeTakeFirst(),
    ).toEqual({ attempts: 1, failure_code: 'waiting_for_accounting' });

    // Reconciliation settles the attempt; the next delivery completes the deletion.
    await ledger.sweepStaleDispatched(0, 10);
    expect(await ledger.writeOff(attemptId, 'ci fixture settlement', 'ci')).toMatchObject({ kind: 'written_off' });
    expect(await use.process({ v: 1, deletionId: receiptId })).toBe('completed');
    expect(await countWhere('identity.universes', 'id', person.universeId)).toBe(0);
    expect(await countWhere('reasoning.external_attempts', 'universe_id', person.universeId)).toBe(0);
  });

  it('hands pending deletions back to the queue when due, marks a failed one, and retries on request', async () => {
    const person = await recordingPerson(database);
    const receiptId = randomUUID();
    const use = deleting();
    expect((await use.request(person.authority, { receiptId })).kind).toBe('accepted');
    expect(await deletionJobs(receiptId)).toBe(1);

    // Not due for ten minutes: recovery leaves it alone. Due: it is queued once and pushed out.
    expect(await use.recover()).toEqual({ requeued: 0 });
    await sql`update identity.account_deletions set next_attempt_at = now() - interval '1 minute' where id = ${receiptId}::uuid`.execute(
      database.db,
    );
    expect(await use.recover()).toEqual({ requeued: 1 });
    expect(await use.recover()).toEqual({ requeued: 0 });
    expect(await deletionJobs(receiptId)).toBe(2);

    // After the last failed delivery the receipt asks for a retry; a retry queues the same work again.
    await use.fail({ v: 1, deletionId: receiptId });
    expect(await use.readReceipt(receiptId)).toBe('needs_retry');
    expect(await use.retry(receiptId)).toEqual({ kind: 'queued' });
    expect(await use.readReceipt(receiptId)).toBe('in_progress');
    expect(await deletionJobs(receiptId)).toBe(3);
    expect(await use.retry(randomUUID())).toEqual({ kind: 'not_found' });
    expect(await use.readReceipt(randomUUID())).toBeUndefined();

    expect(await use.process({ v: 1, deletionId: receiptId })).toBe('completed');
    expect(await use.retry(receiptId)).toEqual({ kind: 'completed' });
    expect(await use.recover()).toEqual({ requeued: 0 });
  });
});
