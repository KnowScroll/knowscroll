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
