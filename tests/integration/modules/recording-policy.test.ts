import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  recordingPolicyFor,
  makeRecordingPolicy,
  recordingStore,
  accountAccessUseCases,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { gate } from '../support/fixture-model.js';
/** Actions-only disposable SQL/real lock fixtures. No installed Pause/control or provider. */
describe('Identity account-lifetime recording policy', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recording_policy');
  });
  afterEach(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const cases = () => recordingPolicyFor(db(), { lockTimeoutMs: 5000 });
  const body = (generation = 1, on = false, epoch = 1) => ({
    version: 'recording-policy.v1' as const,
    commandId: randomUUID(),
    expectedPrivacyEpoch: epoch,
    expectedRecordingGeneration: generation,
    on,
  });
  const root = (p: FixturePerson) =>
    db().selectFrom('identity.universes').selectAll().where('id', '=', p.universeId).executeTakeFirstOrThrow();
  const commands = () => db().selectFrom('identity.recording_commands').selectAll().orderBy('command_id').execute();
  const read = (p: FixturePerson, commandId?: string) =>
    cases().read(p.authority, {
      version: 'recording-policy.v1',
      readId: randomUUID(),
      target: commandId ? { kind: 'command', commandId } : { kind: 'current' },
    });
  it('serializes CAS, exactly replays lost ACK after newer toggle, and binds canonical original body', async () => {
    const p = await seedPerson(db()),
      a = body(),
      b = body();
    const results = await Promise.all([cases().set(p.authority, a), cases().set(p.authority, b)]);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'refused')).toEqual([{ kind: 'refused', code: 'stale_policy' }]);
    const accepted = results[0]?.kind === 'ok' ? a : b;
    const first = results.find((r) => r.kind === 'ok');
    expect(await root(p)).toMatchObject({ recording_on: false, recording_generation: 2, revision: 1 });
    expect(await cases().set(p.authority, body(2, true))).toMatchObject({
      kind: 'ok',
      value: { receipt: { fromGeneration: 2, toGeneration: 3, changed: true } },
    });
    const before = await root(p),
      receipts = await commands();
    const retry = await cases().set(p.authority, {
      on: accepted.on,
      expectedRecordingGeneration: accepted.expectedRecordingGeneration,
      expectedPrivacyEpoch: accepted.expectedPrivacyEpoch,
      commandId: accepted.commandId,
      version: accepted.version,
    });
    expect(retry).toEqual(first?.kind === 'ok' ? { ...first, value: { ...first.value, replayed: true } } : undefined);
    expect(await cases().set(p.authority, { ...accepted, on: true })).toEqual({
      kind: 'refused',
      code: 'command_key_reused',
    });
    expect(await cases().set(p.authority, { ...accepted, expectedPrivacyEpoch: 2 })).toEqual({
      kind: 'refused',
      code: 'command_key_reused',
    });
    expect(await root(p)).toEqual(before);
    expect(await commands()).toEqual(receipts);
    expect(receipts).toHaveLength(2);
    expect(receipts.find((r) => r.command_id === accepted.commandId)).toMatchObject({
      request_body: accepted,
      scope_id: p.universeId,
      account_id: p.accountId,
      outcome_version: 1,
    });
  });
  it('commits one receipt/revision for simultaneous exact original retries', async () => {
    const p = await seedPerson(db()),
      input = body();
    const replies = await Promise.all([cases().set(p.authority, input), cases().set(p.authority, input)]);
    expect(replies.map((r) => (r.kind === 'ok' ? r.value.replayed : undefined)).sort()).toEqual([false, true]);
    expect(await commands()).toHaveLength(1);
    expect(await root(p)).toMatchObject({ recording_on: false, recording_generation: 2, revision: 1 });
  });
  it('orders accepted no-op receipts once and returns pure correlated current/command snapshots', async () => {
    const p = await seedPerson(db()),
      input = body(1, true);
    expect(await cases().set(p.authority, input)).toMatchObject({
      kind: 'ok',
      value: { replayed: false, receipt: { changed: false, fromGeneration: 1, toGeneration: 1 } },
    });
    const before = await root(p),
      receipts = await commands();
    expect(before).toMatchObject({ recording_on: true, recording_generation: 1, revision: 1 });
    expect(await read(p)).toMatchObject({
      kind: 'ok',
      value: {
        scope: { accountId: p.accountId, privacyEpoch: 1 },
        revision: 1,
        target: { kind: 'current' },
        policy: { on: true, generation: 1 },
      },
    });
    expect(await read(p, input.commandId)).toMatchObject({
      kind: 'ok',
      value: { status: 'recorded', receipt: { commandId: input.commandId } },
    });
    expect(await read(p, randomUUID())).toMatchObject({ kind: 'ok', value: { status: 'not_recorded' } });
    expect(await cases().set(p.authority, input)).toMatchObject({ kind: 'ok', value: { replayed: true } });
    expect(await root(p)).toEqual(before);
    expect(await commands()).toEqual(receipts);
    const peer = await seedPerson(db());
    expect(await read(peer, input.commandId)).toMatchObject({ kind: 'ok', value: { status: 'not_recorded' } });
    expect(
      await cases().read(
        { ...p.authority, actor: peer.authority.actor },
        { version: 'recording-policy.v1', readId: randomUUID(), target: { kind: 'current' } },
      ),
    ).toMatchObject({ kind: 'scope_refused', refusal: { kind: 'account_mismatch' } });
  });
  it('recovers both UUID-casing command-read aliases while preserving exact original body and receipt spelling', async () => {
    const p = await seedPerson(db());
    for (const upperOriginal of [false, true]) {
      const canonical = randomUUID().slice(0, -1) + 'a';
      const original = upperOriginal ? canonical.toUpperCase() : canonical;
      const alias = upperOriginal ? canonical : canonical.toUpperCase();
      const input = { ...body(1, true), commandId: original };
      expect(await cases().set(p.authority, input)).toMatchObject({
        kind: 'ok',
        value: { receipt: { commandId: original } },
      });
      const query = {
        version: 'recording-policy.v1',
        readId: randomUUID(),
        target: { kind: 'command', commandId: alias },
      };
      expect(await cases().read(p.authority, query)).toMatchObject({
        kind: 'ok',
        value: { ...query, status: 'recorded', receipt: { commandId: original } },
      });
      expect(await cases().set(p.authority, { ...input, commandId: alias })).toEqual({
        kind: 'refused',
        code: 'command_key_reused',
      });
      expect((await commands()).find((r) => r.command_id === canonical)).toMatchObject({ request_body: input });
    }
    expect(await read(p, randomUUID())).toMatchObject({ kind: 'ok', value: { status: 'not_recorded' } });
  });
  it('rejects stale epoch/generation and rolls back a receipt plus root change on failure', async () => {
    const p = await seedPerson(db()),
      before = await root(p);
    expect(await cases().set(p.authority, body(1, false, 2))).toEqual({ kind: 'refused', code: 'stale_policy' });
    expect(await cases().set(p.authority, body(3, false))).toEqual({ kind: 'refused', code: 'stale_policy' });
    const fail = makeRecordingPolicy({
      withScope: makeWithPersonalScope(db(), { lockTimeoutMs: 5000 }),
      fenceOwn: accountAccessUseCases({ db: db(), lockTimeoutMs: 5000 }).fenceOwnAccount,
      store: {
        ...recordingStore,
        async accept(...args) {
          await recordingStore.accept(...args);
          throw new Error('fixture_after_receipt');
        },
      },
      hash: (q) => requestHash('privacy.recording-set', q),
      now: () => new Date(),
    });
    await expect(fail.set(p.authority, body())).rejects.toThrow('fixture_after_receipt');
    expect(await root(p)).toEqual(before);
    expect(await commands()).toEqual([]);
  });
  it('enforces initial/parity/monotone/no-wrap SQL and immutable receipt/root binding', async () => {
    const p = await seedPerson(db());
    await expect(
      db().updateTable('identity.universes').set({ recording_generation: 3 }).where('id', '=', p.universeId).execute(),
    ).rejects.toThrow('recording_monotone_transition');
    await expect(
      db().updateTable('identity.universes').set({ recording_on: false }).where('id', '=', p.universeId).execute(),
    ).rejects.toThrow();
    const input = body();
    await cases().set(p.authority, input);
    await expect(
      db()
        .updateTable('identity.universes')
        .set({ recording_on: true, recording_generation: 1 })
        .where('id', '=', p.universeId)
        .execute(),
    ).rejects.toThrow('recording_monotone_transition');
    await expect(
      db().updateTable('identity.recording_commands').set({ recorded_at: new Date() }).execute(),
    ).rejects.toThrow('recording_receipt_immutable');
    const original = (await commands())[0]!;
    const peer = await seedPerson(db()),
      wrongCommand = randomUUID();
    await expect(
      db()
        .insertInto('identity.recording_commands')
        .values({
          ...original,
          command_id: wrongCommand,
          request_body: { ...input, commandId: wrongCommand },
          account_id: peer.accountId,
        })
        .execute(),
    ).rejects.toThrow('recording_receipt_binding');
    await expect(
      db()
        .insertInto('identity.universes')
        .values({ id: randomUUID(), account_id: peer.accountId, recording_generation: 3, recording_on: true })
        .execute(),
    ).rejects.toThrow('recording_initial_policy');
    // Disposable fixture seeds an otherwise unreachable int32 boundary, then reinstates the guard.
    await db()
      .transaction()
      .execute(async (trx) => {
        await sql`alter table identity.universes disable trigger recording_policy_guard`.execute(trx);
        await trx
          .updateTable('identity.universes')
          .set({ recording_generation: 2147483647, recording_on: true })
          .where('id', '=', p.universeId)
          .execute();
        await sql`alter table identity.universes enable trigger recording_policy_guard`.execute(trx);
      });
    expect(await cases().set(p.authority, body(2147483647, true))).toMatchObject({
      kind: 'ok',
      value: { receipt: { changed: false, fromGeneration: 2147483647, toGeneration: 2147483647 } },
    });
    const before = await root(p),
      rows = await commands();
    expect(await cases().set(p.authority, body(2147483647, false))).toEqual({
      kind: 'refused',
      code: 'generation_exhausted',
    });
    await expect(
      db()
        .updateTable('identity.universes')
        .set({ recording_on: false, recording_generation: 2 })
        .where('id', '=', p.universeId)
        .execute(),
    ).rejects.toThrow('recording_monotone_transition');
    expect(await root(p)).toEqual(before);
    expect(await commands()).toEqual(rows);
  });
  it('rechecks current epoch after a deterministic root wait before any historical receipt lookup', async () => {
    const p = await seedPerson(db()),
      input = body();
    await cases().set(p.authority, input);
    const applicationName = `recording-wait-${randomUUID()}`;
    const other = createDatabase<Database>(
      { ...database.settings, applicationName },
      { onIdleClientError: () => undefined },
    );
    const held = gate(),
      release = gate();
    let holderPid = 0,
      lookups = 0;
    const holding = makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
      const own = await accountAccessUseCases({ db: db(), lockTimeoutMs: 5000 }).fenceOwnAccount(scope);
      if (own.kind !== 'active') throw new Error('Fixture gate');
      const trx = transactionOf(scope);
      holderPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
      held.open();
      await release.promise;
      await trx.updateTable('identity.universes').set({ privacy_epoch: 2 }).where('id', '=', p.universeId).execute();
    });
    let pending: ReturnType<ReturnType<typeof makeRecordingPolicy>['set']> | undefined;
    try {
      await held.promise;
      const retryCases = makeRecordingPolicy({
        withScope: makeWithPersonalScope(other.db, { lockTimeoutMs: 5000 }),
        fenceOwn: accountAccessUseCases({ db: other.db, lockTimeoutMs: 5000 }).fenceOwnAccount,
        store: {
          ...recordingStore,
          command(...args) {
            lookups++;
            return recordingStore.command(...args);
          },
        },
        hash: (q) => requestHash('privacy.recording-set', q),
        now: () => new Date(),
      });
      pending = retryCases.set(p.authority, input);
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const r = await sql<{
          blocked: boolean;
        }>`select exists(select 1 from pg_stat_activity a where a.application_name=${applicationName} and ${holderPid}=any(pg_blocking_pids(a.pid))) as blocked`.execute(
          db(),
        );
        if (r.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      release.open();
      await holding;
      expect(await pending).toMatchObject({
        kind: 'scope_refused',
        refusal: { kind: 'epoch_changed', currentEpoch: 2 },
      });
      expect(lookups).toBe(0);
      expect(await commands()).toHaveLength(1);
      const fresh = { ...p.authority, privacyEpoch: 2 };
      expect(await cases().set(fresh, input)).toMatchObject({
        kind: 'ok',
        value: { replayed: true, receipt: { requestedPrivacyEpoch: 1, toGeneration: 2 } },
      });
      expect(await root(p)).toMatchObject({ recording_on: false, recording_generation: 2, revision: 1 });
    } finally {
      release.open();
      await Promise.allSettled([holding, ...(pending ? [pending] : [])]);
      await other.close();
    }
  });
});
