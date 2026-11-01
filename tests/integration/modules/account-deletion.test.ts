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
import { openToEveryone } from '../support/audience.js';
import { PLANETS, setScout } from '../support/rooms-feed.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { reportCases } from '../support/feedback.js';
import { everyStoreSeeder } from '../support/every-store.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { befriend, pairRevision, seedContent, seedFriend, talkCases } from '../support/talk.js';
import { visitCases } from '../support/visit-world.js';
import {
  joinRoom,
  makeModerator,
  markUseful,
  roomWorld,
  say,
  seedRoom,
  setPresence,
  startPoll,
  startTopic,
  unwrap,
  votePoll,
  ask,
} from '../support/rooms.js';

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
  // The same, for a room's snippet: `rooms-erasure.test.ts` proves it goes.
  'rooms.message_snippets',
  // Reached only through its discussion, which has a starter column of its own: `rooms-sky.test.ts` proves it stays.
  'rooms.debates',
  // Keyed by the thread, which names no person: it is kept with the thread, and the test below proves it stays.
  'social.thread_call_reveals',
]);

type EraseAccountData = Parameters<typeof deleteAccountFor>[2]['eraseAccountData'];

/** An abuse report about a person, as the client sends it from a conversation or a visit. */
const abuseAboutPerson = (about: { readonly person: { readonly personId: string } }) => ({
  commandId: randomUUID(),
  category: 'harassment' as const,
  target: { kind: 'person' as const, personId: about.person.personId },
});

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
      const ownMessage = unwrap(
        await talk.talk.conversations.send(erased.authority, {
          version: 'direct-conversation.v1',
          commandId: randomUUID(),
          conversation: started.value.conversation,
          body: { kind: 'text', text: 'a message from the person who will delete their account' },
        }),
      );
      // The friend answers it with a reply, each reacts to the other's message, and a reaction sits on the person's own.
      const buddyStarted = unwrap(
        await talk.talk.conversations.start(buddy.authority, {
          version: 'direct-conversation.v1',
          commandId: randomUUID(),
          peerPersonId: erasedPerson.personId,
          expectedPairRevision: await pairRevision(talk.friends, buddy, erasedAsFriend),
        }),
      );
      const buddyMessage = unwrap(
        await talk.talk.conversations.send(buddy.authority, {
          version: 'direct-conversation.v1',
          commandId: randomUUID(),
          conversation: buddyStarted.conversation,
          body: { kind: 'text', text: 'a reply from the friend' },
          replyTo: ownMessage.messageId,
        }),
      );
      for (const [reactor, conversation, messageId] of [
        [erased, started.value.conversation, buddyMessage.messageId],
        [buddy, buddyStarted.conversation, ownMessage.messageId],
      ] as const)
        unwrap(
          await talk.talk.conversations.react(reactor.authority, {
            version: 'direct-conversation.v1',
            commandId: randomUUID(),
            conversation,
            messageId,
            kind: 'spark',
            present: true,
          }),
        );
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
      // Where they told the thread they are (D-065). The thread is a single Reel, which the command would refuse a
      // place on, so this is a labelled fixture row; `social-places.test.ts` proves the real path.
      await database.db
        .insertInto('social.thread_places')
        .values({ thread_id: scenarioThreadId, account_id: erased.accountId, part: 1, state: 'on', day: '2026-10-24' })
        .execute();
      // What they locked on a thread's call (D-156): a labelled fixture row for the same reason; `social-calls.test.ts`
      // proves the real path.
      await database.db
        .insertInto('social.thread_calls')
        .values({
          thread_id: scenarioThreadId,
          account_id: erased.accountId,
          asset_id: talkContent.assetId,
          revision: 1,
          stop_id: 'call-one',
          option: 1,
          day: '2026-10-24',
        })
        .execute();
      // That the call revealed for the thread (D-155): thread state with no person and no pick.
      await database.db
        .insertInto('social.thread_call_reveals')
        .values({ thread_id: scenarioThreadId, asset_id: talkContent.assetId, revision: 1, stop_id: 'call-one' })
        .execute();
      await seedScenarioRows(erased, scenarioThreadId);
      // A room: the person joined, started a discussion, wrote in it, invited their friend and asked an inhabitant.
      const rooms = await roomWorld(
        database,
        { now: new Date('2026-10-24T08:00:00Z') },
        { starsPerDay: 20, scoutsEnabled: true },
      );
      try {
        const room = await seedRoom(rooms);
        unwrap(await joinRoom(rooms, erasedAsFriend, room.roomId));
        // They have the room open: a presence lease.
        unwrap(await setPresence(rooms, erasedAsFriend, room.roomId));
        const discussionId = await startTopic(rooms, erasedAsFriend, room.roomId, 'A discussion the person started');
        unwrap(await say(rooms, erasedAsFriend, room.roomId, discussionId, 'words in a room by the deleted person'));
        unwrap(
          await rooms.rooms.invite(erased.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            friendPersonId: buddy.person.personId,
          }),
        );
        unwrap(await ask(rooms, erasedAsFriend, room.roomId, discussionId));
        // They found someone else's words useful, and someone found theirs useful.
        const stayer = await seedFriend(rooms.db, rooms.friends);
        unwrap(await joinRoom(rooms, stayer, room.roomId));
        const others = unwrap(await say(rooms, stayer, room.roomId, discussionId, 'words by someone who stays'));
        unwrap(await markUseful(rooms, erasedAsFriend, room.roomId, discussionId, others.messageId));
        // A poll the person started as the room's moderator, and their own vote in it.
        await makeModerator(rooms, room.slug, erasedAsFriend);
        const poll = unwrap(await startPoll(rooms, erasedAsFriend, room.roomId));
        unwrap(await votePoll(rooms, erasedAsFriend, room.roomId, poll.activityId, 'o1'));
        // The sky: a debate they started and voted on, a tap on a Spot the flaw (a labelled fixture item), seven stars from
        // answers the person who stays wrote and they found useful, and their vote on the constellation's name.
        const debate = unwrap(
          await rooms.rooms.create(erasedAsFriend.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            start: {
              kind: 'topic',
              title: 'A debate',
              tag: 'debate',
              debate: { sides: ['Yes', 'No'], closesInHours: 24 },
            },
          }),
        );
        unwrap(
          await rooms.rooms.voteDebate(erasedAsFriend.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            discussionId: debate.discussionId,
            side: 'a',
          }),
        );
        const ritualId = randomUUID();
        await rooms.db
          .insertInto('rooms.rituals')
          .values({
            ritual_id: ritualId,
            room_id: room.roomId,
            day: '2026-10-24',
            kind: 'flaw',
            payload: JSON.stringify({
              sentences: ['One sentence.', 'Another sentence that was altered.', 'A third sentence.'],
              flawIndex: 1,
              original: 'Another sentence that was not altered.',
              source: {
                assetId: randomUUID(),
                assetRevision: 1,
                blockId: 'b1',
                start: 0,
                end: 80,
                quoteHash: 'a'.repeat(64),
              },
            }),
            payload_version: 'ritual.v1',
            state: 'approved',
            made_by: 'template',
            created_at: new Date('2026-10-24T07:00:00Z'),
            decided_at: new Date('2026-10-24T07:30:00Z'),
            decided_by: 'cli:ci',
          })
          .execute();
        unwrap(
          await rooms.rooms.solveFlaw(erasedAsFriend.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            ritualId,
            sentence: 1,
            recordingGeneration: 1,
          }),
        );
        const todayChannel = await rooms.db
          .selectFrom('rooms.discussions')
          .select('discussion_id')
          .where('room_id', '=', room.roomId)
          .where('kind', '=', 'today')
          .executeTakeFirstOrThrow();
        for (let index = 0; index < 7; index++) {
          const answer = unwrap(
            await say(rooms, stayer, room.roomId, todayChannel.discussion_id, `An answer ${String(index)}`),
          );
          unwrap(await markUseful(rooms, erasedAsFriend, room.roomId, todayChannel.discussion_id, answer.messageId));
        }
        unwrap(
          await rooms.rooms.nameConstellation(erasedAsFriend.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            constellation: 1,
            candidate: 1,
          }),
        );
        // A Launch they started with the person who stays, and the first question they answered: a place and an answer.
        await rooms.db
          .insertInto('rooms.rituals')
          .values({
            ritual_id: randomUUID(),
            room_id: room.roomId,
            day: '2026-10-24',
            kind: 'launch',
            payload: JSON.stringify({
              questions: Array.from({ length: 5 }, (_, index) => ({
                prompt: `Fixture question ${String(index + 1)}?`,
                options: ['First option', 'Second option'],
                answer: 0,
                explain: 'Because the fixture says so.',
                source: { assetId: talkContent.assetId, assetRevision: 1, stopId: `s${String(index + 1)}` },
              })),
            }),
            payload_version: 'ritual.v1',
            state: 'approved',
            made_by: 'template',
            created_at: new Date('2026-10-24T07:00:00Z'),
            decided_at: new Date('2026-10-24T07:30:00Z'),
            decided_by: 'cli:ci',
          })
          .execute();
        unwrap(await setPresence(rooms, stayer, room.roomId));
        unwrap(await setPresence(rooms, erasedAsFriend, room.roomId));
        const launch = unwrap(
          await rooms.rooms.startLaunch(erasedAsFriend.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            recordingGeneration: 1,
          }),
        );
        if (launch.outcome !== 'accepted') throw new Error('the Launch did not start');
        rooms.clock.now = new Date(rooms.clock.now.getTime() + launch.startsInMs + 500);
        unwrap(
          await rooms.rooms.answerLaunch(erasedAsFriend.authority, {
            version: 'rooms.v1',
            commandId: randomUUID(),
            roomId: room.roomId,
            launchId: launch.launchId,
            round: 1,
            choice: 0,
            recordingGeneration: 1,
          }),
        );
        // What the room remembers, in words the person chose as its moderator, and the audit of that edit (D-247): labelled
        // fixture rows; `rooms-memory.test.ts` proves the real path and that the edit stays when the account goes.
        await rooms.db
          .insertInto('rooms.room_memory')
          .values({
            room_id: room.roomId,
            state: 'ready',
            source: 'moderator',
            body: 'A fixture memory a moderator wrote.',
            edited_by_account_id: erased.accountId,
            edited_at: rooms.clock.now,
            updated_at: rooms.clock.now,
          })
          .execute();
        // A scout the person sent into the room, by their own choice of the room's topics (D-259, D-260).
        unwrap(await setScout(rooms, erasedAsFriend, room.roomId, { interests: [PLANETS[0]!] }));
        await rooms.db
          .insertInto('rooms.memory_edits')
          .values({
            edit_id: randomUUID(),
            room_id: room.roomId,
            by_account_id: erased.accountId,
            action: 'replace',
            body_sha256: 'a'.repeat(64),
            at: rooms.clock.now,
          })
          .execute();
      } finally {
        await rooms.close();
      }
      // Reports: one the person sent, and one a friend sent about them.
      const reports = reportCases(database.db);
      expect(
        (await reports.reportAbuse(erased.authority, abuseAboutPerson(buddy))).kind,
        'a report the person sent',
      ).toBe('received');
      expect(
        (await reports.reportAbuse(buddy.authority, abuseAboutPerson(erasedAsFriend))).kind,
        'a report about the person',
      ).toBe('received');
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
      const exports = dataExportFor(database.db, boss, {
        gather: (scope, person) => exportCurrentPerson(scope, person, openToEveryone),
        lockTimeoutMs: 5_000,
      });
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
      // The record that a call revealed stays with the thread, and the pick of the person who made it is gone.
      expect(await countWhere('social.thread_call_reveals', 'thread_id', scenarioThreadId)).toBe(1);
      expect(await countWhere('social.thread_calls', 'thread_id', scenarioThreadId)).toBe(0);
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
      const exports = dataExportFor(database.db, boss, {
        gather: (scope, person) => exportCurrentPerson(scope, person, openToEveryone),
        lockTimeoutMs: 5_000,
      });
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

  it('keeps the Universe first-open flag through export and Clear, reads it in the export, and deletes it with the account (D-114)', async () => {
    const person = await recordingPerson(database);
    const flag = () =>
      database.db
        .selectFrom('identity.accounts')
        .select('universe_first_opened_at')
        .where('id', '=', person.accountId)
        .executeTakeFirst();
    const exported = async (authority: FixturePerson['authority']) => {
      const file = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(authority, (scope) =>
        exportCurrentPerson(scope, { accountId: person.accountId }, openToEveryone),
      );
      if (file.kind !== 'entered') throw new Error('CI export refused');
      return (file.value.sections['identity'] as { account: { universeOpeningShown: boolean } }).account
        .universeOpeningShown;
    };
    expect(await exported(person.authority)).toBe(false);

    expect(await identity().claimFirstOpen({ accountId: person.accountId })).toEqual({ claimed: true });
    const claimedAt = (await flag())?.universe_first_opened_at;
    expect(claimedAt).toBeInstanceOf(Date);
    // The export says it was shown, in words, and never when.
    expect(await exported(person.authority)).toBe(true);

    // Clear removes the exploration, not the account's lifetime flag: it is still set, at the same moment, and still read.
    await clearRecordingPerson(database, boss, person);
    expect((await flag())?.universe_first_opened_at).toEqual(claimedAt);
    const afterClear = { ...person.authority, privacyEpoch: 2 };
    expect(await exported(afterClear)).toBe(true);
    expect(await identity().claimFirstOpen({ accountId: person.accountId })).toEqual({ claimed: false });

    // Deleting the account deletes the row that held it.
    const use = deleting();
    const receiptId = randomUUID();
    expect((await use.request(afterClear, { receiptId })).kind).toBe('accepted');
    expect(await use.process({ v: 1, deletionId: receiptId })).toBe('completed');
    expect(await flag()).toBeUndefined();
  });
});
