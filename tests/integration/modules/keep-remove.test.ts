/** Real PostgreSQL + pg-boss source fixtures only; no runtime/private owner data. */
import { randomUUID } from 'node:crypto';
import { PostgresQueryCompiler, sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  createDatabase,
  makeWithPersonalScope,
  transactionOf,
  withTransaction,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { ScopeNoticeRelay, type ScopeNotice } from '@knowscroll/backend/infrastructure/notices';
import { findPersonalReceipt, requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { applyActionEvidenceQueue, projectEncounterActivityQueue } from '@knowscroll/backend/modules/evidence';
import { KEEP_REMOVAL_OPERATION, KEEP_REMOVAL_OUTCOME_VERSION } from '@knowscroll/backend/modules/experience';
import {
  keepRemovalUseCase,
  keepStore,
  type KeepRemovalPorts,
} from '@knowscroll/backend/modules/experience/nest-providers';
import type { KeepEntryRef, RemoveKeepEntry, NavigationOutcome } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedAsset, seedPerson, type FixturePerson } from '../support/fixtures.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import { gate } from '../support/fixture-model.js';

const command = (entry: KeepEntryRef): RemoveKeepEntry => ({
  version: 'keep-remove.v1',
  commandId: randomUUID(),
  entry,
});
describe('exact Saved membership removal (real scoped PG/pg-boss)', () => {
  let database: TestDatabase<Database>, other: DatabaseHandle<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  const notices: ScopeNotice[] = [];
  let relay: ScopeNoticeRelay;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('keep_remove');
    other = createDatabase<Database>(
      { ...database.settings, applicationName: 'ci-keep-remove-barrier' },
      { onIdleClientError: () => undefined },
    );
    c = await scrollUseCases(database);
    for (const q of [applyActionEvidenceQueue, projectEncounterActivityQueue])
      if ((await c.boss.getQueue(q.name)) === null) await c.boss.createQueue(q.name);
    relay = new ScopeNoticeRelay({
      database: database.settings,
      sink: {
        onNotice: (n) => notices.push(n),
        onResync: () => undefined,
        onAccessRevoked: () => undefined,
      },
      logEvent: () => undefined,
    });
    await relay.start();
  });
  afterAll(async () => {
    await relay?.stop();
    await c?.close();
    await other?.close();
    await database?.drop();
  });
  const remove = (db: Kysely<Database> = database.db, overrides: Partial<KeepRemovalPorts> = {}) =>
    keepRemovalUseCase({
      withScope: makeWithPersonalScope(db, { lockTimeoutMs: 10000 }),
      fenceOwn: accountAccessUseCases({ db, lockTimeoutMs: 10000 }).fenceOwnAccount,
      enqueue: makeEnqueueJob(c.boss),
      ...overrides,
    });
  async function saved(person?: FixturePerson) {
    const p = person ?? (await seedPerson(database.db)),
      a = await seedAsset(database.db),
      ref = { assetId: a.assetId, assetRevision: a.revision };
    // The real existing Save operation mints this membership; a Save ACK is not used as its identity.
    expect(
      await c.applyEncounterAction(p.authority, { commandId: randomUUID(), kind: 'save', target: ref }),
    ).toMatchObject({ kind: 'applied', outcome: { saved: true, changed: true } });
    const row = await database.db
      .selectFrom('experience.saved_items')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('asset_id', '=', ref.assetId)
      .executeTakeFirstOrThrow();
    const entry = { ...ref, savedEntryId: row.saved_entry_id };
    await database.db
      .insertInto('experience.saved_places')
      .values({
        universe_id: p.universeId,
        saved_entry_id: entry.savedEntryId,
        place_revision: 1,
        position: JSON.stringify({ kind: 'reel', positionMs: 1234.5 }),
      })
      .execute();
    return { person: p, entry, row };
  }
  async function state(p: FixturePerson) {
    return (
      await sql<{ value: Record<string, unknown> }>`select jsonb_build_object(
      'root',(select to_jsonb(r) from identity.universes r where id=${p.universeId}::uuid),
      'saved',(select coalesce(jsonb_agg(to_jsonb(r) order by asset_id),'[]'::jsonb) from experience.saved_items r where universe_id=${p.universeId}::uuid),
      'places',(select coalesce(jsonb_agg(to_jsonb(r) order by saved_entry_id),'[]'::jsonb) from experience.saved_places r where universe_id=${p.universeId}::uuid),
      'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by command_id),'[]'::jsonb) from receipts.personal_commands r where universe_id=${p.universeId}::uuid),
      'actions',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from experience.actions r where universe_id=${p.universeId}::uuid),
      'links',(select coalesce(jsonb_agg(to_jsonb(r) order by action_id),'[]'::jsonb) from experience.action_links r where universe_id=${p.universeId}::uuid),
      'channels',(select coalesce(jsonb_agg(to_jsonb(r) order by asset_id),'[]'::jsonb) from experience.action_state r where universe_id=${p.universeId}::uuid),
      'inputs',(select coalesce(jsonb_agg(to_jsonb(r) order by exposure_id),'[]'::jsonb) from experience.encounter_activity_inputs r where universe_id=${p.universeId}::uuid),
      'exposures',(select count(*) from experience.exposures where universe_id=${p.universeId}::uuid),
      'observations',(select count(*) from evidence.observations where universe_id=${p.universeId}::uuid),
      'jobs',(select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]'::jsonb) from pgboss.job j where data->>'universeId'=${p.universeId})
    ) value`.execute(database.db)
    ).rows[0]!.value;
  }
  async function waiting() {
    return (
      await sql<{
        n: number;
      }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
        database.db,
      )
    ).rows[0]!.n;
  }
  async function replayedFixture() {
    const f = await saved(),
      input = command(f.entry),
      first = await remove()(f.person.authority, input);
    expect(first.kind).toBe('ok');
    return { ...f, input, first };
  }
  async function activatedSaved() {
    const person = await seedPerson(database.db),
      source = starterSource();
    source['assetId'] = randomUUID();
    source['publication'] = { ...(source['publication'] as object), explanationUnitId: `ci-remove-${randomUUID()}` };
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('Canonical fixture import');
    const ref = { assetId: imported.assetId, assetRevision: imported.revision };
    const opened = await c.navigate(person.authority, {
      commandId: randomUUID(),
      target: { kind: 'return', ...ref },
      capabilities: textCapabilities,
    });
    if (opened.kind !== 'accepted' || opened.outcome.status !== 'ready') throw new Error('Expected admitted return');
    const o: Extract<NavigationOutcome, { status: 'ready' }> = opened.outcome;
    const activated = await c.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: o.sessionId,
        offerId: o.offer.offerId,
        expectedIntentRevision: o.intentRevision,
      },
    });
    if (activated.kind !== 'accepted') throw new Error('Expected activation');
    const exposureId = activated.outcome.exposureId,
      job = { v: 1 as const, universeId: person.universeId, privacyEpoch: 1, exposureId };
    for (const kind of ['like', 'save'] as const)
      expect(
        await c.applyEncounterAction(person.authority, { commandId: randomUUID(), kind, target: ref, exposureId }),
      ).toMatchObject({ kind: 'applied' });
    await c.projectActivity(job);
    const found = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(person.authority, (s) =>
      keepStore.membership(s, ref.assetId),
    );
    if (found.kind !== 'entered' || !found.value) throw new Error('Expected actual Saved');
    return { person, entry: found.value, exposureId, job };
  }
  it('cascades the real place and commits one Unsave/action/link/receipt/job/root/hint with no consumption', async () => {
    const f = await saved(),
      input = command(f.entry),
      before = await state(f.person);
    const result = await remove()(f.person.authority, input);
    expect(result).toMatchObject({
      kind: 'ok',
      value: {
        ...input,
        scope: { accountId: f.person.accountId, privacyEpoch: 1 },
        replayed: false,
        operation: 'keep.entry.remove',
      },
    });
    const after = await state(f.person);
    expect(after['saved']).toEqual([]);
    expect(after['places']).toEqual([]);
    for (const key of ['actions', 'links', 'receipts', 'jobs'])
      expect((after[key] as unknown[]).length).toBe((before[key] as unknown[]).length + 1);
    expect(after['exposures']).toBe(before['exposures']);
    expect(after['observations']).toBe(before['observations']);
    const root = after['root'] as { revision: number },
      oldRoot = before['root'] as { revision: number };
    expect(root.revision).toBe(oldRoot.revision + 1);
    const receipt = await database.db
      .selectFrom('receipts.personal_commands')
      .select(['operation', 'outcome_version', 'request_hash'])
      .where('command_id', '=', input.commandId)
      .executeTakeFirstOrThrow();
    expect(receipt).toEqual({
      operation: KEEP_REMOVAL_OPERATION,
      outcome_version: KEEP_REMOVAL_OUTCOME_VERSION,
      request_hash: requestHash(KEEP_REMOVAL_OPERATION, input),
    });
    const action = await database.db
      .selectFrom('experience.actions')
      .selectAll()
      .where('command_id', '=', input.commandId)
      .executeTakeFirstOrThrow();
    expect(action).toMatchObject({ kind: 'unsave', asset_id: f.entry.assetId, asset_revision: 1 });
    const jobs = (
      await sql<{
        name: string;
        data: unknown;
      }>`select name,data from pgboss.job where data->>'actionId'=${action.id}`.execute(database.db)
    ).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe(applyActionEvidenceQueue.name);
    await expect.poll(() => notices.filter((n) => n.eventId === action.id).length).toBe(1);
    expect(await remove()(f.person.authority, input)).toEqual(
      result.kind === 'ok' ? { kind: 'ok', value: { ...result.value, replayed: true } } : null,
    );
    expect(await state(f.person)).toEqual(after);
  });
  it('replays A before any membership read; resaved B and its position survive old replay and fresh mismatch', async () => {
    const f = await replayedFixture();
    expect(
      await c.applyEncounterAction(f.person.authority, { commandId: randomUUID(), kind: 'save', target: f.entry }),
    ).toMatchObject({ kind: 'applied' });
    // Read actual B under a real scope, not from the Save receipt.
    const found = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(f.person.authority, (scope) =>
      keepStore.membership(scope, f.entry.assetId),
    );
    if (found.kind !== 'entered' || !found.value) throw new Error('Expected actual B');
    expect(found.value.savedEntryId).not.toBe(f.entry.savedEntryId);
    await database.db
      .insertInto('experience.saved_places')
      .values({
        universe_id: f.person.universeId,
        saved_entry_id: found.value.savedEntryId,
        place_revision: 1,
        position: JSON.stringify({ kind: 'reel', positionMs: 99 }),
      })
      .execute();
    const before = await state(f.person);
    const replay = remove(database.db, {
      membership: () => {
        throw new Error('REPLAY_MUST_NOT_READ_MEMBERSHIP');
      },
    });
    expect(await replay(f.person.authority, f.input)).toMatchObject({
      kind: 'ok',
      value: { entry: f.entry, replayed: true },
    });
    expect(await remove()(f.person.authority, command(f.entry))).toEqual({
      kind: 'refused',
      code: 'KEEP_ENTRY_UNAVAILABLE',
    });
    expect(await remove()(f.person.authority, { ...f.input, entry: found.value })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    expect(await state(f.person)).toEqual(before);
  });
  it.each(['withdrawn', 'corrected'] as const)(
    'removes an actual %s saved ref with no canonical Content lookup',
    async (kind) => {
      const f = await saved();
      await database.db
        .updateTable('content.assets')
        .set(kind === 'withdrawn' ? { status: 'withdrawn' } : { revision: 2 })
        .where('id', '=', f.entry.assetId)
        .execute();
      // seedAsset intentionally has no canonical document/media; removing needs neither.
      expect(await remove()(f.person.authority, command(f.entry))).toMatchObject({ kind: 'ok' });
      expect((await state(f.person))['saved']).toEqual([]);
    },
  );
  it('never reinterprets an existing action command receipt as removal', async () => {
    const f = await saved(),
      before = await state(f.person);
    const prior = await database.db
      .selectFrom('receipts.personal_commands')
      .select('command_id')
      .where('universe_id', '=', f.person.universeId)
      .executeTakeFirstOrThrow();
    expect(await remove()(f.person.authority, { ...command(f.entry), commandId: prior.command_id })).toEqual({
      kind: 'refused',
      code: 'COMMAND_KEY_REUSED',
    });
    expect(await state(f.person)).toEqual(before);
  });
  it('serializes same-key duplicates and different-key contenders without inventing another action', async () => {
    const f = await saved(),
      input = command(f.entry);
    const pair = await Promise.all([remove()(f.person.authority, input), remove(other.db)(f.person.authority, input)]);
    expect(pair.map((v) => v.kind === 'ok' && v.value.replayed).sort()).toEqual([false, true]);
    expect(
      await database.db
        .selectFrom('experience.actions')
        .select('id')
        .where('command_id', '=', input.commandId)
        .execute(),
    ).toHaveLength(1);
    const g = await saved(),
      a = command(g.entry),
      b = command(g.entry),
      before = await state(g.person);
    const otherPair = await Promise.all([remove()(g.person.authority, a), remove(other.db)(g.person.authority, b)]);
    expect(otherPair.filter((v) => v.kind === 'ok')).toHaveLength(1);
    expect(otherPair.filter((v) => v.kind === 'refused')).toEqual([
      { kind: 'refused', code: 'KEEP_ENTRY_UNAVAILABLE' },
    ]);
    expect(((await state(g.person))['actions'] as unknown[]).length).toBe((before['actions'] as unknown[]).length + 1);
  });
  it('checks current account/epoch/owner before receipt lookup, including an already accepted command', async () => {
    const f = await replayedFixture(),
      foreign = await seedPerson(database.db);
    let lookups = 0;
    const guarded = remove(database.db, {
      findReceipt: async (s, k) => {
        lookups++;
        return findPersonalReceipt(s, k);
      },
    });
    expect(
      await guarded({ ...f.person.authority, actor: { kind: 'account', accountId: foreign.accountId } }, f.input),
    ).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', f.person.universeId)
      .execute();
    expect(await guarded(f.person.authority, f.input)).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
    expect(lookups).toBe(0);
    const current = { ...f.person.authority, privacyEpoch: 2 };
    expect(await guarded(current, f.input)).toEqual({ kind: 'refused', code: 'COMMAND_KEY_REUSED' });
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', f.person.accountId)
      .execute();
    const count = lookups;
    expect(await guarded(current, f.input)).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
    expect(lookups).toBe(count);
  });
  it('reads membership only after waiting for a fixture B replacement staged under the real root', async () => {
    const f = await saved(),
      entered = gate(),
      leave = gate(),
      before = await state(f.person);
    let b!: string;
    const held = makeWithPersonalScope(other.db, { lockTimeoutMs: 10000 })(f.person.authority, async (scope) => {
      expect((await accountAccessUseCases({ db: other.db, lockTimeoutMs: 10000 }).fenceOwnAccount(scope)).kind).toBe(
        'active',
      );
      const tx = transactionOf(scope);
      // Visibility-race fixture only; real Unsave/resave business effects are proved above.
      await tx
        .deleteFrom('experience.saved_items')
        .where('universe_id', '=', f.person.universeId)
        .where('asset_id', '=', f.entry.assetId)
        .execute();
      const row = await tx
        .insertInto('experience.saved_items')
        .values({
          universe_id: f.person.universeId,
          asset_id: f.entry.assetId,
          asset_revision: 1,
          saved_at: new Date(),
        })
        .returning('saved_entry_id')
        .executeTakeFirstOrThrow();
      b = row.saved_entry_id;
      entered.open();
      await leave.promise;
    });
    await entered.promise;
    const pending = remove()(f.person.authority, command(f.entry));
    await expect.poll(waiting).toBeGreaterThan(0);
    leave.open();
    await held;
    expect(await pending).toEqual({ kind: 'refused', code: 'KEEP_ENTRY_UNAVAILABLE' });
    const after = await state(f.person);
    expect(after['saved']).toMatchObject([{ saved_entry_id: b }]);
    for (const key of ['root', 'receipts', 'actions', 'links', 'channels', 'inputs', 'jobs'])
      expect(after[key]).toEqual(before[key]);
  });
  it('fresh own-account gate refuses after an account lock wait before touching a historical receipt', async () => {
    const f = await replayedFixture(),
      entered = gate(),
      leave = gate(),
      before = await state(f.person);
    const held = withTransaction(other.db, 'ci.keep-remove-account-wait', async (tx) => {
      await tx
        .updateTable('identity.accounts')
        .set({ status: 'suspended' })
        .where('id', '=', f.person.accountId)
        .execute();
      entered.open();
      await leave.promise;
    });
    await entered.promise;
    let reads = 0;
    const pending = remove(database.db, {
      findReceipt: async (sc, key) => {
        reads++;
        return findPersonalReceipt(sc, key);
      },
    })(f.person.authority, f.input);
    await expect.poll(waiting).toBeGreaterThan(0);
    leave.open();
    await held;
    expect(await pending).toEqual({ kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' });
    expect(reads).toBe(0);
    expect(await state(f.person)).toEqual(before);
  });
  it('rechecks epoch after a root wait before it can replay an old receipt', async () => {
    const f = await replayedFixture(),
      entered = gate(),
      leave = gate();
    const held = makeWithPersonalScope(other.db, { lockTimeoutMs: 10000 })(f.person.authority, async (scope) => {
      await transactionOf(scope)
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', f.person.universeId)
        .execute();
      entered.open();
      await leave.promise;
    });
    await entered.promise;
    const pending = remove()(f.person.authority, f.input);
    await expect.poll(waiting).toBeGreaterThan(0);
    leave.open();
    await held;
    expect(await pending).toEqual({ kind: 'refused', code: 'PRIVACY_EPOCH_CHANGED' });
  });
  it('refuses a fresh exhausted root without writes but allows its prior immutable replay', async () => {
    const f = await saved();
    await database.db
      .updateTable('identity.universes')
      .set({ revision: 2147483647 })
      .where('id', '=', f.person.universeId)
      .execute();
    const before = await state(f.person);
    expect(await remove()(f.person.authority, command(f.entry))).toEqual({
      kind: 'refused',
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(await state(f.person)).toEqual(before);
    const g = await replayedFixture();
    await database.db
      .updateTable('identity.universes')
      .set({ revision: 2147483647 })
      .where('id', '=', g.person.universeId)
      .execute();
    expect(await remove()(g.person.authority, g.input)).toMatchObject({ kind: 'ok', value: { replayed: true } });
  });
  it.each(['newer', 'older', 'wrong-scope', 'wrong-entry', 'wrong-command', 'replayed', 'extra', 'null'] as const)(
    'fails closed on %s stored history, without a membership fallback',
    async (kind) => {
      const f = await replayedFixture();
      if (f.first.kind !== 'ok') throw new Error('Expected accepted fixture');
      const value = f.first.value;
      const outcome =
        kind === 'wrong-scope'
          ? { ...value, scope: { ...value.scope, accountId: randomUUID() } }
          : kind === 'wrong-entry'
            ? { ...value, entry: { ...value.entry, savedEntryId: randomUUID() } }
            : kind === 'wrong-command'
              ? { ...value, commandId: randomUUID() }
              : kind === 'replayed'
                ? { ...value, replayed: true }
                : kind === 'extra'
                  ? { ...value, currentEntry: 'CANARY' }
                  : value;
      await database.db
        .updateTable('receipts.personal_commands')
        .set({
          outcome: kind === 'null' ? null : JSON.stringify(outcome),
          outcome_version:
            kind === 'newer' ? KEEP_REMOVAL_OUTCOME_VERSION + 1 : kind === 'older' ? 0 : KEEP_REMOVAL_OUTCOME_VERSION,
        })
        .where('command_id', '=', f.input.commandId)
        .execute();
      const before = await state(f.person),
        call = remove(database.db, {
          membership: () => {
            throw new Error('NO_HISTORY_FALLBACK');
          },
        })(f.person.authority, f.input);
      if (kind === 'null') await expect(call).rejects.toThrow('Receipt without outcome');
      else
        expect(await call).toEqual({
          kind: 'refused',
          code: kind === 'older' ? 'COMMAND_KEY_REUSED' : 'SERVICE_UNAVAILABLE',
        });
      expect(await state(f.person)).toEqual(before);
    },
  );
  const rollbackPatterns = [
    ['pending-receipt', 'insert into "receipts"."personal_commands"'],
    ['action', 'insert into "experience"."actions"'],
    ['saved-cascade', 'delete from "experience"."saved_items"'],
    ['channels', 'insert into experience.action_state'],
    ['links', 'insert into experience.action_links'],
    ['receipt-complete', 'update "receipts"."personal_commands"'],
    ['root', 'update "identity"."universes"'],
    ['notice', 'pg_notify'],
  ] as const;
  it.each(rollbackPatterns)('rolls back every effect after actual %s SQL succeeds', async (_name, pattern) => {
    const f = await saved(),
      input = command(f.entry),
      before = await state(f.person),
      actionId = randomUUID(),
      qs = new WeakMap<object, string>(),
      compiler = new PostgresQueryCompiler();
    let fired = false;
    const plugin: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        qs.set(queryId, compiler.compileQuery(node, queryId).sql);
        return node;
      },
      transformResult({ result, queryId }) {
        if (qs.get(queryId)?.includes(pattern)) {
          fired = true;
          throw new Error('CI_POST_WRITE_ROLLBACK');
        }
        return Promise.resolve(result);
      },
    };
    await expect(
      remove(database.db.withPlugin(plugin), { newId: () => actionId })(f.person.authority, input),
    ).rejects.toThrow('CI_POST_WRITE_ROLLBACK');
    expect(fired).toBe(true);
    expect(await state(f.person)).toEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notices.filter((n) => n.eventId === actionId)).toEqual([]);
  });
  it('rolls back after the real required pg-boss job was inserted', async () => {
    const f = await saved(),
      input = command(f.entry),
      before = await state(f.person),
      real = makeEnqueueJob(c.boss);
    const call = keepRemovalUseCase({
      withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 }),
      fenceOwn: accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount,
      enqueue: async (...args) => {
        await real(...args);
        throw new Error('CI_AFTER_JOB');
      },
    });
    await expect(call(f.person.authority, input)).rejects.toThrow('CI_AFTER_JOB');
    expect(await state(f.person)).toEqual(before);
  });
  it.each([1, 2])('rolls back the attributed Unsave after required job %i actually inserts', async (failAt) => {
    const f = await activatedSaved(),
      before = await state(f.person),
      real = makeEnqueueJob(c.boss);
    let count = 0;
    const call = keepRemovalUseCase({
      withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 }),
      fenceOwn: accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount,
      enqueue: async (...args) => {
        await real(...args);
        if (++count === failAt) throw new Error('CI_ATTRIBUTED_JOB_ROLLBACK');
      },
    });
    await expect(call(f.person.authority, command(f.entry))).rejects.toThrow('CI_ATTRIBUTED_JOB_ROLLBACK');
    expect(count).toBe(failAt);
    expect(await state(f.person)).toEqual(before);
  });
  it('keeps the actual credited Unsave correction and unrelated Like without creating fresh consumption', async () => {
    const { person, entry, exposureId, job } = await activatedSaved();
    const before = await state(person);
    expect(await remove()(person.authority, command(entry))).toMatchObject({ kind: 'ok' });
    const input = await database.db
      .selectFrom('experience.encounter_activity_inputs')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .where('exposure_id', '=', exposureId)
      .executeTakeFirstOrThrow();
    expect(input).toMatchObject({ saved: false, liked: true });
    await c.projectActivity(job);
    const activity = await database.db
      .selectFrom('evidence.activity_revisions')
      .select('channels')
      .where('universe_id', '=', person.universeId)
      .where('exposure_id', '=', exposureId)
      .orderBy('revision', 'desc')
      .executeTakeFirstOrThrow();
    expect(activity.channels).toMatchObject({ q: null, B: false, L: true });
    const after = await state(person);
    expect(after['observations']).toBe(before['observations']);
    expect(after['exposures']).toBe(before['exposures']);
  });
});
