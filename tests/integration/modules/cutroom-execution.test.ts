import { randomUUID } from 'node:crypto';
import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cutroomExecutionFor,
  makeWithCutroomAccountingScope,
  makeEnqueueCutroomAccounting,
  makeEnqueueCutroom,
  makeWithCutroomScope,
  postgresCutroomExecution,
  makeCutroomExecutionFoundation,
  consumeCutroomDispatchPermit,
} from '@knowscroll/backend/reasoning/nest-providers';
import { makeCommissionReview, postgresCommissionReview } from '@knowscroll/backend/modules/content/nest-providers';
import {
  cutroomAccountingQueue,
  cutroomFollowQueue,
  type CutroomAccountingScopeTx,
  type CutroomDispatchPreflight,
  type WithCutroomScope,
  type CutroomExecutionPorts,
} from '@knowscroll/backend/reasoning';
import {
  commissionFixture,
  fixtureReview,
  fixtureCorpusManifest,
  hash,
  type CommissionFixture,
} from '../support/commission-fixture.js';
import { gate } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';

describe('Cutroom C1 inert execution/accounting foundation (real PG/pg-boss; no network/provider)', () => {
  let f: CommissionFixture;
  beforeAll(async () => {
    f = await commissionFixture('execution');
  });
  afterAll(async () => {
    await f.close();
  });
  const accounting = () => makeWithCutroomAccountingScope(f.world.db, { enabled: true, lockTimeoutMs: 5000 });
  const enqueueAccounting = () => makeEnqueueCutroomAccounting(f.boss, cutroomAccountingQueue);
  const store = () => postgresCutroomExecution(makeEnqueueCutroom(f.boss), enqueueAccounting());
  async function admitted(label: string, distinct = false) {
    const c = f.command(label, 1, distinct),
      r = await f.commission()(c.input);
    if (r.kind !== 'pending') throw new Error('CI reserve');
    return {
      ...c,
      attemptId: r.attemptId,
      target: { worldId: 'dev' as const, businessRunId: c.input.businessRunId, attemptId: r.attemptId },
    };
  }
  async function counts() {
    return (
      await sql<{
        e: string;
        o: string;
        i: string;
        j: string;
      }>`select (select count(*) from reasoning.cutroom_execution) e,(select count(*) from reasoning.cutroom_observations) o,(select count(*) from reasoning.cutroom_accounting_intents) i,(select count(*) from pgboss.job where name in ('reasoning.cutroom-follow','reasoning.cutroom-accounting')) j`.execute(
        f.world.db,
      )
    ).rows[0];
  }
  async function prepared(label: string) {
    const cmd = f.command(label, 1, true),
      r = await fixtureReview(f, cmd.input),
      admittedResult = await f.commission()(cmd.input);
    if (admittedResult.kind !== 'pending') throw new Error('CI reserve');
    const c = {
        ...cmd,
        attemptId: admittedResult.attemptId,
        target: {
          worldId: 'dev' as const,
          businessRunId: cmd.input.businessRunId,
          attemptId: admittedResult.attemptId,
        },
      },
      review = makeCommissionReview(postgresCommissionReview, {
        enabled: true,
        approvals: [r.human],
        manifests: [fixtureCorpusManifest()],
      });
    const accepted = await f.service().withScope(c.input.authority, 'admit', (s) => review.admit(s, r.packet));
    expect(accepted).toMatchObject({ kind: 'entered', value: { kind: 'reviewed' } });
    expect(await f.service().claim(c.input.authority, c.attemptId)).toMatchObject({
      kind: 'pending',
      poolState: 'claimed',
    });
    const a = await f.world.db
      .selectFrom('reasoning.cutroom_attempts')
      .selectAll()
      .where('id', '=', c.attemptId)
      .executeTakeFirstOrThrow();
    const t = (
      await sql<{
        claimed: string;
        bound: string;
      }>`select to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') claimed,to_char(bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') bound from reasoning.cutroom_attempts where id=${c.attemptId}::uuid`.execute(
        f.world.db,
      )
    ).rows[0]!;
    const now = new Date(),
      preflight: CutroomDispatchPreflight = {
        attemptId: c.attemptId,
        requestSha256: c.prepared.requestSha256,
        fence: a.fence,
        profileSha256: hash('fixture-engine'),
        soleWriterEvidenceSha256: hash('fixture-sole-writer'),
        fundsEvidenceSha256: hash('fixture-funds-not-real'),
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30000).toISOString(),
        availableCents: 200,
        poolReceipt: { bindingId: a.binding_id!, claimedAt: t.claimed, boundAt: t.bound },
      };
    const ports: CutroomExecutionPorts = {
      enabled: true,
      withScope: makeWithCutroomScope(f.world.db, { enabled: true, lockTimeoutMs: 5000 }),
      withAccountingScope: accounting(),
      store: store(),
      recheckReview: review.recheck,
      preflights: [preflight],
      now: () => now,
    };
    return { ...c, r, review, ports, preflight, now };
  }
  it('default disabled and empty registries never mint an intent or touch the pool', async () => {
    const c = await admitted('default'),
      before = await counts();
    expect(await cutroomExecutionFor(f.world.db, f.boss).prepareIntent(c.input.authority, c.attemptId)).toEqual({
      kind: 'held',
      code: 'disabled',
    });
    expect(
      await cutroomExecutionFor(f.world.db, f.boss, { enabled: true }).prepareIntent(c.input.authority, c.attemptId),
    ).toEqual({ kind: 'held', code: 'review' });
    expect(await counts()).toEqual(before);
    expect((await f.owner.query('select * from public.pool_order')).rows).toHaveLength(0);
  });
  it('historical accounting locks exact root/business/attempt even disabled/new generation, with no bytes, B admission or external money effect', async () => {
    const c = await admitted('historical'),
      before = await counts(),
      b = f.service();
    await f.world.db
      .updateTable('reasoning.cutroom_scopes')
      .set({ enabled: false, generation: 2 })
      .where('world_id', '=', 'dev')
      .execute();
    try {
      expect(await b.claim(c.input.authority, c.attemptId)).toMatchObject({ kind: 'refused' });
      const x = cutroomExecutionFor(f.world.db, f.boss, { enabled: true }),
        o = {
          requestId: c.prepared.requestId,
          runId: null,
          evidenceSha256: hash('fixture-observation'),
          outcome: 'unknown',
        };
      const result = await x.recordObservation(c.target, o);
      expect(result).toMatchObject({ kind: 'pending' });
      expect(await x.recordObservation(c.target, o)).toEqual(result);
      const entered = await accounting()(c.target, async (scope) => {
        expect(Object.keys(scope).sort()).toEqual([
          'attemptGeneration',
          'attemptId',
          'businessRunId',
          'currentGeneration',
          'fence',
          'identity',
          'worldId',
        ]);
        expect(scope.currentGeneration).toBe(2);
        expect(scope.attemptGeneration).toBe(1);
        await expect(f.ports().pool.read(scope.identity)).rejects.toMatchObject({ code: 'NETWORK_IN_TRANSACTION' });
        return 'accounting-only';
      });
      expect(entered).toMatchObject({ kind: 'entered' });
      expect(await x.recordObservation({ ...c.target, businessRunId: randomUUID() }, o)).toEqual({
        kind: 'refused',
        code: 'identity',
      });
      expect(await x.recordObservation(c.target, { ...o, rawBody: 'SECRET_CANARY' })).toEqual({
        kind: 'refused',
        code: 'invalid',
      });
      expect(await x.recordObservation(c.target, { ...o, requestId: 'foreign' })).toEqual({
        kind: 'refused',
        code: 'identity',
      });
      await expect(x.recordObservation(c.target, { ...o, outcome: 'pending' })).rejects.toThrow('CONTRADICTION');
      const row = await f.world.db
        .selectFrom('reasoning.cutroom_accounting_intents')
        .selectAll()
        .where('attempt_id', '=', c.attemptId)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe('pending');
      expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
      expect(await counts()).toEqual({
        ...before!,
        o: String(Number(before!['o']) + 1),
        i: String(Number(before!['i']) + 1),
        j: String(Number(before!['j']) + 1),
      });
    } finally {
      await f.world.db
        .updateTable('reasoning.cutroom_scopes')
        .set({ enabled: true, generation: 1 })
        .where('world_id', '=', 'dev')
        .execute();
    }
  });
  it('accounting refuses an oversized stored business request ID after SQL projects NULL, without loading its text or creating work', async () => {
    const isolated = await commissionFixture('accounting-oversized');
    try {
      const c = isolated.command('source');
      expect(await isolated.commission()(c.input)).toMatchObject({ kind: 'pending' });
      const original = await isolated.world.db
        .selectFrom('content.reel_commissions')
        .selectAll()
        .where('business_run_id', '=', c.input.businessRunId)
        .executeTakeFirstOrThrow();
      const businessRunId = randomUUID(),
        oversized = 'é'.repeat(65);
      expect(oversized.length).toBe(65);
      expect(Buffer.byteLength(oversized, 'utf8')).toBe(130);
      // Authored malformed initial row is allowed by immutable 0030. No trigger is disabled.
      await isolated.world.db
        .insertInto('content.reel_commissions')
        .values({ ...original, business_run_id: businessRunId, request_id: oversized, attempt_id: null })
        .execute();
      const projected: unknown[] = [];
      const inspect: KyselyPlugin = {
        transformQuery: ({ node }) => node,
        transformResult({ result }) {
          for (const row of result.rows) {
            if ('request_id' in row) projected.push(row['request_id']);
            expect(Object.values(row)).not.toContain(oversized);
          }
          return Promise.resolve(result);
        },
      };
      const withAccounting = makeWithCutroomAccountingScope(isolated.world.db.withPlugin(inspect), {
        enabled: true,
        lockTimeoutMs: 5000,
      });
      let entered = false;
      expect(
        await withAccounting({ worldId: 'dev', businessRunId, attemptId: original.attempt_id! }, () => {
          entered = true;
          return Promise.resolve();
        }),
      ).toEqual({ kind: 'refused', code: 'identity' });
      expect(projected).toEqual([null]);
      expect(entered).toBe(false);
      expect(await isolated.world.db.selectFrom('reasoning.cutroom_observations').selectAll().execute()).toEqual([]);
      expect(await isolated.world.db.selectFrom('reasoning.cutroom_accounting_intents').selectAll().execute()).toEqual(
        [],
      );
      expect(
        (await sql`select id from pgboss.job where name='reasoning.cutroom-accounting'`.execute(isolated.world.db))
          .rows,
      ).toEqual([]);
      expect((await isolated.owner.query('select * from public.pool_order')).rows).toEqual([]);
    } finally {
      await isolated.close();
    }
  });
  it('forged/closed accounting scopes, wrong scope IDs and arbitrary queue substitution fail closed', async () => {
    const c = await admitted('scope'),
      enqueue = enqueueAccounting();
    let closed: CutroomAccountingScopeTx | undefined;
    await accounting()(c.target, async (scope) => {
      closed = scope;
      await expect(
        enqueue(scope, { v: 1, ...c.target, attemptId: randomUUID(), observationId: randomUUID() }),
      ).rejects.toThrow('SCOPE_MISMATCH');
    });
    const payload = { v: 1 as const, ...c.target, observationId: randomUUID() };
    for (const sc of [closed!, { ...closed! } as CutroomAccountingScopeTx])
      await expect(enqueue(sc, payload)).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
    expect(() =>
      makeEnqueueCutroomAccounting(f.boss, { ...cutroomAccountingQueue, name: cutroomFollowQueue.name }),
    ).toThrow('QUEUE_REQUIRED');
  });
  it('observation/intention/required job roll back together after enqueue', async () => {
    const c = await admitted('rollback'),
      before = await counts(),
      enqueue = enqueueAccounting(),
      s = postgresCutroomExecution(makeEnqueueCutroom(f.boss), async (...args) => {
        await enqueue(...args);
        throw new Error('CI accounting after job');
      });
    await expect(
      accounting()(c.target, (scope) =>
        s.observe(scope, {
          requestId: c.prepared.requestId,
          runId: null,
          evidenceSha256: hash('rollback'),
          outcome: 'unknown',
        }),
      ),
    ).rejects.toThrow('CI accounting');
    expect(await counts()).toEqual(before);
  });
  it('accounting waits on the current root and observes the new generation after the wait', async () => {
    const c = await admitted('accounting-wait'),
      held = gate(),
      release = gate();
    const tx = f.world.db.transaction().execute(async (t) => {
      await t
        .updateTable('reasoning.cutroom_scopes')
        .set({ generation: 2, enabled: false })
        .where('world_id', '=', 'dev')
        .execute();
      held.open();
      await release.promise;
    });
    await held.promise;
    const pending = accounting()(c.target, (scope) => Promise.resolve(scope.currentGeneration));
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                f.world.db,
              )
            ).rows[0]!.n,
          ),
        )
        .toBeGreaterThan(0);
    } finally {
      release.open();
    }
    await tx;
    expect(await pending).toEqual({ kind: 'entered', value: 2 });
    await f.world.db
      .updateTable('reasoning.cutroom_scopes')
      .set({ generation: 1, enabled: true })
      .where('world_id', '=', 'dev')
      .execute();
  });
  it('acknowledged atomic intent returns ONE ephemeral permit and exact stored bytes; replay is unknown and cannot resend', async () => {
    const c = await prepared('intent'),
      x = makeCutroomExecutionFoundation(c.ports),
      before = await counts();
    const r = await x.prepareIntent(c.input.authority, c.attemptId);
    expect(r.kind).toBe('prepared');
    if (r.kind !== 'prepared') return;
    const bytes = consumeCutroomDispatchPermit(r.permit);
    expect(bytes).toMatchObject({ requestUtf8: c.prepared.requestUtf8, requestSha256: c.prepared.requestSha256 });
    const receipt = (
      await sql<{
        binding: string;
        claimed: string;
        bound: string;
      }>`select binding_id binding,to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') claimed,to_char(bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') bound from reasoning.cutroom_execution where attempt_id=${c.attemptId}::uuid`.execute(
        f.world.db,
      )
    ).rows[0]!;
    expect(receipt).toEqual({
      binding: c.preflight.poolReceipt.bindingId,
      claimed: c.preflight.poolReceipt.claimedAt,
      bound: c.preflight.poolReceipt.boundAt,
    });
    expect(consumeCutroomDispatchPermit(r.permit)).toBeUndefined();
    expect(consumeCutroomDispatchPermit({ ...r.permit })).toBeUndefined();
    expect(await x.prepareIntent(c.input.authority, c.attemptId)).toEqual({ kind: 'held', code: 'unknown' });
    expect(await counts()).toEqual({
      ...before!,
      e: String(Number(before!['e']) + 1),
      j: String(Number(before!['j']) + 1),
    });
    const a = await f.world.db
      .selectFrom('reasoning.cutroom_attempts')
      .selectAll()
      .where('id', '=', c.attemptId)
      .executeTakeFirstOrThrow();
    expect(a.state).toBe('unknown');
    expect(a.dispatch_intent_at).not.toBeNull();
    const job = await sql<{
      data: object;
    }>`select data from pgboss.job where name='reasoning.cutroom-follow' and data->>'attemptId'=${c.attemptId}`.execute(
      f.world.db,
    );
    expect(job.rows).toHaveLength(1);
    expect(Object.keys(job.rows[0]!.data).sort()).toEqual(['attemptId', 'businessRunId', 'dispatchId', 'v', 'worldId']);
  });
  it('lost world COMMIT acknowledgement returns no permit; next delivery only marks unknown', async () => {
    const c = await prepared('lost-ack'),
      withScope: WithCutroomScope = async (...args) => {
        await c.ports.withScope(...args);
        throw new Error('CI lost COMMIT ACK');
      };
    await expect(
      makeCutroomExecutionFoundation({ ...c.ports, withScope }).prepareIntent(c.input.authority, c.attemptId),
    ).rejects.toThrow('lost COMMIT ACK');
    expect(await makeCutroomExecutionFoundation(c.ports).prepareIntent(c.input.authority, c.attemptId)).toEqual({
      kind: 'held',
      code: 'unknown',
    });
  });
  it('failed follow enqueue rolls back intent and state, leaving the unchanged attempt eligible', async () => {
    const c = await prepared('intent-rollback'),
      enqueue = makeEnqueueCutroom(f.boss),
      before = await counts(),
      s = postgresCutroomExecution(async (...args) => {
        await enqueue(...args);
        throw new Error('CI after follow');
      }, enqueueAccounting());
    await expect(
      makeCutroomExecutionFoundation({ ...c.ports, store: s }).prepareIntent(c.input.authority, c.attemptId),
    ).rejects.toThrow('CI after follow');
    expect(await counts()).toEqual(before);
    expect(
      (
        await f.world.db
          .selectFrom('reasoning.cutroom_attempts')
          .select('state')
          .where('id', '=', c.attemptId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('reserved');
  });
  it('changed/expired funds/receipt and revoked human review refuse before intent', async () => {
    const c = await prepared('refusals'),
      before = await counts();
    for (const p of [
      { ...c.preflight, availableCents: 0 },
      { ...c.preflight, observedAt: new Date(c.now.getTime() - 31000).toISOString() },
      {
        ...c.preflight,
        poolReceipt: {
          ...c.preflight.poolReceipt,
          boundAt: c.preflight.poolReceipt.boundAt.replace(/\d{6}Z$/, '999999Z'),
        },
      },
    ])
      expect(
        await makeCutroomExecutionFoundation({ ...c.ports, preflights: [p] }).prepareIntent(
          c.input.authority,
          c.attemptId,
        ),
      ).toEqual({ kind: 'held', code: 'preflight' });
    await f.world.db
      .updateTable('content.cutroom_reviews')
      .set({ revoked_at: new Date() })
      .where('business_run_id', '=', c.input.businessRunId)
      .execute();
    expect(await makeCutroomExecutionFoundation(c.ports).prepareIntent(c.input.authority, c.attemptId)).toEqual({
      kind: 'held',
      code: 'review',
    });
    expect(await counts()).toEqual(before);
  });
  it('expired/purged bytes never reconstruct, and retained metadata remains accountable', async () => {
    const c = await prepared('purged');
    await f.world.db
      .updateTable('reasoning.cutroom_requests')
      .set({ request_utf8: null, purged_at: new Date() })
      .where('attempt_id', '=', c.attemptId)
      .execute();
    expect(await makeCutroomExecutionFoundation(c.ports).prepareIntent(c.input.authority, c.attemptId)).toEqual({
      kind: 'held',
      code: 'expired',
    });
    expect(
      await cutroomExecutionFor(f.world.db, f.boss, { enabled: true }).recordObservation(c.target, {
        requestId: c.prepared.requestId,
        runId: null,
        evidenceSha256: hash('after-purge'),
        outcome: 'unknown',
      }),
    ).toMatchObject({ kind: 'pending' });
    expect(
      (
        await f.world.db
          .selectFrom('reasoning.cutroom_requests')
          .select('request_utf8')
          .where('attempt_id', '=', c.attemptId)
          .executeTakeFirstOrThrow()
      ).request_utf8,
    ).toBeNull();
  });
  it('rechecks human revocation after the root lock wait before committing any dispatch intent', async () => {
    const c = await prepared('review-wait'),
      held = gate(),
      release = gate(),
      before = await counts();
    const tx = f.world.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('reasoning.cutroom_scopes')
        .selectAll()
        .where('world_id', '=', 'dev')
        .forNoKeyUpdate()
        .execute();
      await trx
        .updateTable('content.cutroom_reviews')
        .set({ revoked_at: new Date() })
        .where('business_run_id', '=', c.input.businessRunId)
        .execute();
      held.open();
      await release.promise;
    });
    await held.promise;
    const pending = makeCutroomExecutionFoundation(c.ports).prepareIntent(c.input.authority, c.attemptId);
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                f.world.db,
              )
            ).rows[0]!.n,
          ),
        )
        .toBeGreaterThan(0);
    } finally {
      release.open();
    }
    await tx;
    expect(await pending).toEqual({ kind: 'held', code: 'review' });
    expect(await counts()).toEqual(before);
  });
  it('actual personal epoch invalidation/erasure does not delete public execution or accounting rows/jobs', async () => {
    const c = await admitted('erasure');
    await cutroomExecutionFor(f.world.db, f.boss, { enabled: true }).recordObservation(c.target, {
      requestId: c.prepared.requestId,
      runId: null,
      evidenceSha256: hash('erasure-public'),
      outcome: 'unknown',
    });
    const before = await counts(),
      p = await seedPerson(f.world.db),
      access = accountAccessUseCases({ db: f.world.db, lockTimeoutMs: 5000 });
    expect(await access.invalidateOwnAccountAccess(p.authority, 'advance_epoch')).toMatchObject({ kind: 'entered' });
    await makeWithPersonalScope(f.world.db, { lockTimeoutMs: 5000 })({ ...p.authority, privacyEpoch: 2 }, (scope) =>
      eraseUniverse(scope, personalStores),
    );
    expect(await counts()).toEqual(before);
  });
});

import { makeWithCutroomPreparationScope } from '@knowscroll/backend/reasoning/nest-providers';
import type { CutroomPreparationScopeTx } from '@knowscroll/backend/reasoning';
import {
  assertOutsideTransaction,
  insideTransaction,
  transactionOf,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  cutroomPreparationTransactionOf,
  cutroomTransactionOf,
  cutroomAccountingTransactionOf,
} from '../../../packages/backend/src/infrastructure/postgres/cutroom-scope.js';

describe('D1 separate read-only preparation capability (real PG; no provider or approval)', () => {
  async function isolated(label: string, work: (f: CommissionFixture) => Promise<void>) {
    const f = await commissionFixture(`prep-${label}`);
    try {
      await f.world.db
        .updateTable('reasoning.cutroom_scopes')
        .set({ enabled: false })
        .where('world_id', '=', 'dev')
        .execute();
      await work(f);
    } finally {
      await f.close();
    }
  }
  it('defaults disabled; missing/stale/foreign/extra-field authority refuses without creating a root', async () => {
    await isolated('deny', async (f) => {
      const a = { worldId: 'dev' as const, generation: 1 };
      let calls = 0;
      const work = () => {
        calls++;
        return Promise.resolve(true);
      };
      expect(await makeWithCutroomPreparationScope(f.world.db)(a, work)).toEqual({ kind: 'refused', code: 'disabled' });
      const read = makeWithCutroomPreparationScope(f.world.db, { enabled: true });
      expect(await read({ ...a, generation: 2 }, work)).toEqual({ kind: 'refused', code: 'generation' });
      for (const authority of [
        { ...a, worldId: 'live' },
        { ...a, generation: 0 },
        { ...a, privateContext: 'canary' },
      ])
        expect(await read(authority as never, work)).toEqual({ kind: 'refused', code: 'identity' });
      await f.world.db.deleteFrom('reasoning.cutroom_scopes').where('world_id', '=', 'dev').execute();
      expect(await read(a, work)).toEqual({ kind: 'refused', code: 'identity' });
      expect(calls).toBe(0);
      expect(await f.world.db.selectFrom('reasoning.cutroom_scopes').selectAll().execute()).toEqual([]);
      expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
    });
  });
  it('actual server read-only repeatable-read rejects protected writes and read-write escalation', async () => {
    await isolated('readonly', async (f) => {
      const read = makeWithCutroomPreparationScope(f.world.db, { enabled: true }),
        a = { worldId: 'dev' as const, generation: 1 };
      expect(
        await read(a, async (scope) => {
          expect(insideTransaction()).toBe(true);
          expect(scope.rootEnabledAtSnapshot).toBe(false);
          expect(Object.isFrozen(scope)).toBe(true);
          expect(Object.isFrozen(scope.authority)).toBe(true);
          expect(Object.keys(scope)).toEqual(['authority', 'rootEnabledAtSnapshot']);
          const result = await sql<{
            isolation: string;
            readonly: string;
            timeout: string;
          }>`select current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly,current_setting('statement_timeout') timeout`.execute(
            cutroomPreparationTransactionOf(scope),
          );
          return result.rows[0];
        }),
      ).toEqual({ kind: 'entered', value: { isolation: 'repeatable read', readonly: 'on', timeout: '5s' } });
      await expect(
        read(a, async (scope) => {
          await cutroomPreparationTransactionOf(scope)
            .updateTable('reasoning.cutroom_scopes')
            .set({ enabled: true })
            .where('world_id', '=', 'dev')
            .execute();
        }),
      ).rejects.toMatchObject({ code: '25006' });
      await expect(
        read(a, async (scope) => {
          await sql`set transaction read write`.execute(cutroomPreparationTransactionOf(scope));
        }),
      ).rejects.toMatchObject({ code: '25001' });
      expect(
        await f.world.db
          .selectFrom('reasoning.cutroom_scopes')
          .select(['enabled', 'generation'])
          .where('world_id', '=', 'dev')
          .executeTakeFirstOrThrow(),
      ).toEqual({ enabled: false, generation: 1 });
      expect(insideTransaction()).toBe(false);
    });
  });
  it('live/forged/closed preparation scopes cannot enter B/accounting/personal/request/intent or either enqueue', async () => {
    await isolated('disjoint', async (f) => {
      const read = makeWithCutroomPreparationScope(f.world.db, { enabled: true });
      let closed: CutroomPreparationScopeTx | undefined;
      const before =
        await sql`select (select count(*) from reasoning.cutroom_attempts) a,(select count(*) from reasoning.cutroom_execution) e,(select count(*) from reasoning.cutroom_pool_operations) p,(select count(*) from pgboss.job) j`.execute(
          f.world.db,
        );
      const execution = postgresCutroomExecution(
        makeEnqueueCutroom(f.boss),
        makeEnqueueCutroomAccounting(f.boss, cutroomAccountingQueue),
      );
      await read({ worldId: 'dev', generation: 1 }, async (scope) => {
        closed = scope;
        for (const value of [scope, { ...scope }]) {
          expect(() => cutroomTransactionOf(value as never)).toThrow('forged or closed');
          expect(() => cutroomAccountingTransactionOf(value as never)).toThrow('forged or closed');
          expect(() => transactionOf(value as never)).toThrow();
          await expect(execution.identify(value as never, randomUUID())).rejects.toMatchObject({
            code: 'SCOPE_CLOSED',
          });
          await expect(execution.intent(value as never, randomUUID(), {} as never, {} as never)).rejects.toMatchObject({
            code: 'SCOPE_CLOSED',
          });
          await expect(
            makeEnqueueCutroom(f.boss)(value as never, cutroomFollowQueue, {
              v: 1,
              worldId: 'dev',
              attemptId: randomUUID(),
              businessRunId: randomUUID(),
              dispatchId: randomUUID(),
            }),
          ).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
          await expect(
            makeEnqueueCutroomAccounting(f.boss, cutroomAccountingQueue)(value as never, {
              v: 1,
              worldId: 'dev',
              attemptId: randomUUID(),
              businessRunId: randomUUID(),
              observationId: randomUUID(),
            }),
          ).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
        }
        expect(() => cutroomPreparationTransactionOf({ ...scope })).toThrow('forged or closed');
      });
      if (!closed) throw new Error('CI scope callback missing');
      const finished = closed;
      expect(() => cutroomPreparationTransactionOf(finished)).toThrow('forged or closed');
      const after =
        await sql`select (select count(*) from reasoning.cutroom_attempts) a,(select count(*) from reasoning.cutroom_execution) e,(select count(*) from reasoning.cutroom_pool_operations) p,(select count(*) from pgboss.job) j`.execute(
          f.world.db,
        );
      expect(after.rows).toEqual(before.rows);
      expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
    });
  });
  it('marks the real snapshot transaction and refuses nested B/accounting scopes and network work', async () => {
    await isolated('marker', async (f) => {
      await makeWithCutroomPreparationScope(f.world.db, { enabled: true })(
        { worldId: 'dev', generation: 1 },
        async () => {
          expect(() => assertOutsideTransaction('fixture no actual network')).toThrow('inside a database transaction');
          await expect(
            makeWithCutroomScope(f.world.db, { enabled: true, lockTimeoutMs: 5000 })(
              { worldId: 'dev', generation: 1 },
              'recover',
              () => Promise.resolve(true),
            ),
          ).rejects.toMatchObject({ code: 'NESTED_TRANSACTION' });
          await expect(
            makeWithCutroomAccountingScope(f.world.db, { enabled: true, lockTimeoutMs: 5000 })(
              { worldId: 'dev', businessRunId: randomUUID(), attemptId: randomUUID() },
              () => Promise.resolve(true),
            ),
          ).rejects.toMatchObject({ code: 'NESTED_TRANSACTION' });
        },
      );
      expect(insideTransaction()).toBe(false);
    });
  });
  it('takes no root row lock; a concurrent root change leaves an honestly old consistent snapshot and fresh admission refuses', async () => {
    await isolated('root-snapshot', async (f) => {
      const entered = gate(),
        release = gate(),
        read = makeWithCutroomPreparationScope(f.world.db, { enabled: true });
      const snapshot = read({ worldId: 'dev', generation: 1 }, async (scope) => {
        entered.open();
        await release.promise;
        return cutroomPreparationTransactionOf(scope)
          .selectFrom('reasoning.cutroom_scopes')
          .select(['enabled', 'generation'])
          .where('world_id', '=', 'dev')
          .executeTakeFirstOrThrow();
      });
      await entered.promise;
      try {
        await f.world.db
          .updateTable('reasoning.cutroom_scopes')
          .set({ enabled: true, generation: 2 })
          .where('world_id', '=', 'dev')
          .execute();
      } finally {
        release.open();
      }
      expect(await snapshot).toEqual({ kind: 'entered', value: { enabled: false, generation: 1 } });
      expect(await read({ worldId: 'dev', generation: 1 }, () => Promise.resolve(true))).toEqual({
        kind: 'refused',
        code: 'generation',
      });
      expect(
        await f.service().withScope({ worldId: 'dev', generation: 1 }, 'admit', () => Promise.resolve(true)),
      ).toEqual({ kind: 'refused', code: 'generation' });
    });
  });
});
