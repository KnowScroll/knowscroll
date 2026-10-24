import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportCurrentPerson, personalStores } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { buildDataExportQueue } from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  dataExportFor,
  identitySweepUseCase,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { everyStoreSeeder } from '../support/every-store.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import type { FixturePerson } from '../support/fixtures.js';

/**
 * Personal data export (#246, D-043) against a real PostgreSQL 16 database: one person's own
 * sections only, never another person's data or any identifier, a link that works once, and the
 * ways an export ends. Evidence label: CI fixture accounts and authored fixtures, real database.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
type Gather = Parameters<typeof dataExportFor>[2]['gather'];

describe('personal data export (real database)', () => {
  let database: TestDatabase<Database>;
  let boss: ReturnType<typeof createBoss>;
  let seeder: Awaited<ReturnType<typeof everyStoreSeeder>>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('data_export');
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    seeder = await everyStoreSeeder(database);
  });
  afterAll(async () => {
    await seeder.close();
    await boss.stop({ graceful: false });
    await database.drop();
  });

  const exporting = (gather: Gather = exportCurrentPerson) =>
    dataExportFor(database.db, boss, { gather, lockTimeoutMs: 5_000 });
  const social = () => {
    const access = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5_000 });
    return socialUseCases({
      withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      fenceOwn: access.fenceOwnAccount,
      fencePair: access.fenceAccountPair,
    });
  };

  async function claim(person: FixturePerson, handle: string, displayName: string) {
    const cases = social();
    await cases.setProfile(person.authority, {
      version: 'sharing.v1',
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle,
      displayName,
    });
    const read = await cases.readProfile(person.authority);
    if (read.kind !== 'ok' || read.value.status !== 'claimed') throw new Error('profile unreadable');
    return read.value.person;
  }

  async function ask(person: FixturePerson, text: string) {
    await database.db
      .insertInto('supply.requests')
      .values({
        universe_id: person.universeId,
        privacy_epoch: 1,
        id: randomUUID(),
        command: {
          version: 'content-request.v1',
          intent: { kind: 'topic', subject: { kind: 'text', text }, format: 'scroll' },
        },
        state: 'unavailable',
        request_revision: 1,
        revision: 1,
        decision: 'refuse',
        reason: 'unsupported_request',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  }

  /** Requests, builds and downloads one export; returns the parsed file. */
  async function exportOf(person: FixturePerson, use = exporting()) {
    const exportId = randomUUID();
    const accepted = await use.request(person.authority, { exportId });
    if (accepted.kind !== 'accepted') throw new Error('export refused');
    expect(await use.build({ v: 1, exportId })).toBe('built');
    const link = await use.mintLink(person.authority, { exportId });
    if (link.kind !== 'link') throw new Error('no link');
    const file = await use.consume(link.token);
    if (file.kind !== 'file') throw new Error('no file');
    return { exportId, text: new TextDecoder().decode(file.bytes), token: link.token };
  }

  it("holds the caller's own sections, and nobody else's data and no identifier", async () => {
    const owner = await recordingPerson(database);
    const friend = await recordingPerson(database);
    await seeder.seed(owner);
    await seeder.seed(friend);
    await claim(owner, 'export.owner', 'Owner Display');
    const friendPerson = await claim(friend, 'export.friend', 'Friend Display');
    await ask(owner, 'owner asks about tides');
    await ask(friend, 'friend asks about secrets');
    expect(
      (
        await social().command(owner.authority, 'request', {
          version: 'sharing.v1',
          commandId: randomUUID(),
          expectedPeerPersonId: friendPerson.personId,
          expectedPairRevision: 0,
          target: { kind: 'handle', handle: 'export.friend' },
        })
      ).kind,
    ).toBe('ok');

    const { text } = await exportOf(owner);
    const file = JSON.parse(text) as { version: string; sections: Record<string, Record<string, unknown>> };

    // Every module is in the file, even when its section is empty.
    expect(file.version).toBe('knowscroll-export.v1');
    expect(Object.keys(file.sections).sort()).toEqual(personalStores.map((declaration) => declaration.module).sort());
    expect(file.sections['identity']).toMatchObject({ account: { recordingOn: true } });
    expect(file.sections['social']).toMatchObject({
      profile: { handle: 'export.owner', displayName: 'Owner Display' },
      connections: { friends: 0, requestsSent: 1, requestsReceived: 0, blocked: 0 },
    });
    expect(file.sections['supply']).toMatchObject({
      requests: { items: [{ kind: 'topic', text: 'owner asks about tides', format: 'scroll' }] },
    });
    const experience = file.sections['experience'] as {
      encounters: { items: unknown[] };
      reactions: { items: unknown[] };
    };
    expect(experience.encounters.items.length).toBeGreaterThan(0);
    expect(experience.reactions.items.length).toBeGreaterThan(0);

    // Nothing of the friend, and no identifier of anyone, including the owner's own.
    for (const forbidden of [
      'export.friend',
      'Friend Display',
      'friend asks about secrets',
      friend.accountId,
      friend.universeId,
      friendPerson.personId,
      owner.accountId,
      owner.universeId,
    ])
      expect(text).not.toContain(forbidden);
    // The only text that may look like an identifier is the person's own address (a fixture UUID).
    const withoutAddress = text.replaceAll(
      String((file.sections['identity'] as { account: { email: string } }).account.email),
      '',
    );
    expect(withoutAddress).not.toMatch(UUID);
    expect(withoutAddress).not.toMatch(/[0-9a-f]{64}/);
    expect(withoutAddress).not.toMatch(/ksl_|kss_|kse_/);
  });

  it('is idempotent by id, keeps one in flight, refuses another person’s id, and keeps five', async () => {
    const person = await recordingPerson(database);
    const other = await recordingPerson(database);
    const use = exporting();
    const exportId = randomUUID();
    const first = await use.request(person.authority, { exportId });
    expect(first).toMatchObject({ kind: 'accepted', export: { id: exportId, state: 'preparing' } });
    expect(await use.request(person.authority, { exportId })).toEqual(first);
    // Another id while one is preparing answers with the one in flight, and queues nothing more.
    const second = await use.request(person.authority, { exportId: randomUUID() });
    expect(second).toMatchObject({ kind: 'accepted', export: { id: exportId } });
    expect(
      (
        await sql<{ n: number }>`select count(*)::int as n from pgboss.job
          where name = ${buildDataExportQueue.name} and data ->> 'exportId' = ${exportId}`.execute(database.db)
      ).rows[0]?.n,
    ).toBe(1);
    expect(await use.request(other.authority, { exportId })).toEqual({ kind: 'refused', reason: 'id_in_use' });
    expect(await use.mintLink(other.authority, { exportId })).toEqual({ kind: 'refused', reason: 'not_found' });
    expect(await use.mintLink(person.authority, { exportId })).toEqual({ kind: 'refused', reason: 'not_ready' });

    // Only the newest five are kept.
    expect(await use.build({ v: 1, exportId })).toBe('built');
    for (let n = 0; n < 6; n += 1) {
      const next = randomUUID();
      expect((await use.request(person.authority, { exportId: next })).kind).toBe('accepted');
      expect(await use.build({ v: 1, exportId: next })).toBe('built');
    }
    const listed = await use.list(person.authority);
    if (listed.kind !== 'ok') throw new Error('list refused');
    expect(listed.exports).toHaveLength(5);
    expect(listed.exports.every((entry) => entry.state === 'ready' && entry.expiresAt !== null)).toBe(true);
    expect(listed.exports.map((entry) => entry.id)).not.toContain(exportId);
  });

  it('hands the file over once, within a minute, to a live account only', async () => {
    const person = await recordingPerson(database);
    const use = exporting();
    const { exportId, token } = await exportOf(person, use);
    // Used: the file is gone from the store, the receipt remains.
    expect(await use.consume(token)).toEqual({ kind: 'gone' });
    expect(
      await database.db
        .selectFrom('identity.data_exports')
        .select(['state', 'link_hash'])
        .where('id', '=', exportId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'downloaded', link_hash: null });
    expect(await use.mintLink(person.authority, { exportId })).toEqual({ kind: 'refused', reason: 'not_ready' });

    // A link has a minute to live and cannot be guessed.
    const again = await exportOf(person, use);
    expect(again.token).toMatch(/^kse_[A-Za-z0-9_-]{43}$/);
    const second = randomUUID();
    await use.request(person.authority, { exportId: second });
    await use.build({ v: 1, exportId: second });
    const link = await use.mintLink(person.authority, { exportId: second });
    if (link.kind !== 'link') throw new Error('no link');
    await sql`update identity.data_exports set link_expires_at = now() - interval '1 second' where id = ${second}::uuid`.execute(
      database.db,
    );
    expect(await use.consume(link.token)).toEqual({ kind: 'gone' });
    expect(await use.consume('kse_' + 'A'.repeat(43))).toEqual({ kind: 'gone' });
    // The stored form is a hash, never the token.
    const stored = await database.db
      .selectFrom('identity.data_exports')
      .select('link_hash')
      .where('id', '=', second)
      .executeTakeFirstOrThrow();
    expect(stored.link_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.link_hash).not.toContain(link.token);
  });

  it('ends a ready export at its expiry, fails a stuck build, and drops old receipts', async () => {
    const person = await recordingPerson(database);
    const use = exporting();
    const readyId = randomUUID();
    await use.request(person.authority, { exportId: readyId });
    await use.build({ v: 1, exportId: readyId });
    await sql`update identity.data_exports set expires_at = now() - interval '1 minute', ready_at = now() - interval '8 days' where id = ${readyId}::uuid`.execute(
      database.db,
    );
    // Before the sweep reaches it, an expired export already reads as expired and gives no link.
    const read = await use.list(person.authority);
    expect(read.kind === 'ok' && read.exports.find((entry) => entry.id === readyId)?.state).toBe('expired');
    expect(await use.mintLink(person.authority, { exportId: readyId })).toEqual({
      kind: 'refused',
      reason: 'not_ready',
    });

    const stuckId = randomUUID();
    await use.request(person.authority, { exportId: stuckId });
    await sql`update identity.data_exports set requested_at = now() - interval '31 minutes' where id = ${stuckId}::uuid`.execute(
      database.db,
    );
    const oldId = randomUUID();
    await database.db
      .insertInto('identity.data_exports')
      .values({
        id: oldId,
        account_id: person.accountId,
        state: 'failed',
        requested_at: sql<Date>`now() - interval '31 days'`,
      })
      .execute();

    const swept = await identitySweepUseCase(database.db)();
    expect(swept.exports).toBeGreaterThanOrEqual(3);
    const states = Object.fromEntries(
      (
        await database.db
          .selectFrom('identity.data_exports')
          .select(['id', 'state', 'payload'])
          .where('account_id', '=', person.accountId)
          .execute()
      ).map((row) => [row.id, [row.state, row.payload === null]]),
    );
    expect(states[readyId]).toEqual(['expired', true]);
    expect(states[stuckId]).toEqual(['failed', true]);
    expect(states[oldId]).toBeUndefined();
  });

  it('fails an export that is too large, and builds nothing for one that is not preparing', async () => {
    const person = await recordingPerson(database);
    const huge: Gather = () => Promise.resolve({ filler: 'x'.repeat(9 * 1024 * 1024) });
    const use = exporting(huge);
    const exportId = randomUUID();
    await use.request(person.authority, { exportId });
    expect(await use.build({ v: 1, exportId })).toBe('too_large');
    const listed = await use.list(person.authority);
    expect(listed.kind === 'ok' && listed.exports[0]?.state).toBe('failed');
    expect(await use.build({ v: 1, exportId })).toBe('skipped');
    expect(await use.build({ v: 1, exportId: randomUUID() })).toBe('skipped');
    // The last failed delivery shows the receipt as failed; a later request can start again.
    const next = randomUUID();
    await use.request(person.authority, { exportId: next });
    await use.fail({ v: 1, exportId: next });
    expect(
      await database.db.selectFrom('identity.data_exports').select('state').where('id', '=', next).executeTakeFirst(),
    ).toEqual({ state: 'failed' });
  });

  it('is removed by Clear, which exists to remove the history an export copies', async () => {
    const person = await recordingPerson(database);
    const use = exporting();
    const { exportId } = await exportOf(person, use);
    const second = randomUUID();
    await use.request(person.authority, { exportId: second });
    await clearRecordingPerson(database, boss, person);
    expect(
      await database.db
        .selectFrom('identity.data_exports')
        .select('id')
        .where('account_id', '=', person.accountId)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await sql<{ n: number }>`select count(*)::int as n from pgboss.job
          where name = ${buildDataExportQueue.name} and data ->> 'exportId' in (${exportId}, ${second})`.execute(
          database.db,
        )
      ).rows[0]?.n,
    ).toBe(0);
    // The queued build for the removed export finds nothing and builds nothing.
    expect(await use.build({ v: 1, exportId: second })).toBe('skipped');
  });
});
