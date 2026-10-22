import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeCommission,
  postgresCommissionStore,
  makeCommissionReview,
  postgresCommissionReview,
  lockCommissionBusiness,
  makeCutroomSubmitClient,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  cutroomMaintenanceFor,
  makeEnqueueCutroom,
  makeEnqueueCutroomMaintenance,
} from '@knowscroll/backend/reasoning/nest-providers';
import { cutroomPoolQueue, cutroomSettleQueue, recoverCutroomQueue } from '@knowscroll/backend/reasoning';
import {
  createBoss,
  applyQueueDeclarations,
  defineQueue,
  jobConsumer,
  startConsumers,
} from '@knowscroll/backend/infrastructure/jobs';
import { z } from 'zod';
import {
  commissionFixture,
  fixtureReview,
  fixtureCorpusManifest,
  fixtureDispatchedCommission,
  hash,
  type CommissionFixture,
} from '../support/commission-fixture.js';
// Authored scripts/approvals and disposable actual PG/pg-boss only; no POST/provider.
describe('connected reservation, closed queue authority and finite durable recovery', () => {
  let f: CommissionFixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('rolls review refusal back with business/reservation/required pool job; accepted review commits maintenance atomically', async () => {
    f = await commissionFixture('atomic');
    const cmd = f.command('atomic', 1, true),
      reviewed = await fixtureReview(f, cmd.input),
      b = f.service();
    const denied = makeCommission({
      reasoning: b,
      store: postgresCommissionStore,
      sha256: hash,
      admitReview: () => Promise.resolve(false),
    });
    expect(await denied(cmd.input)).toMatchObject({ kind: 'refused', code: 'authority' });
    expect(await f.world.db.selectFrom('content.reel_commissions').selectAll().execute()).toHaveLength(0);
    expect(await f.world.db.selectFrom('reasoning.cutroom_attempts').selectAll().execute()).toHaveLength(0);
    expect(
      (
        await sql<{ n: number }>`select count(*)::int n from pgboss.job where name='reasoning.cutroom-pool'`.execute(
          f.world.db,
        )
      ).rows[0]!.n,
    ).toBe(0);
    const review = makeCommissionReview(postgresCommissionReview, {
        enabled: true,
        approvals: [reviewed.human],
        manifests: [fixtureCorpusManifest()],
      }),
      maintenance = cutroomMaintenanceFor(f.world.db, f.boss, {
        enabled: true,
        worldId: 'dev',
        lockBusiness: lockCommissionBusiness,
      });
    const accepted = await makeCommission({
      reasoning: b,
      store: postgresCommissionStore,
      sha256: hash,
      admitReview: async (scope, _candidate, id) => {
        if ((await review.admit(scope, reviewed.packet)).kind !== 'reviewed') return false;
        await maintenance.trackInScope(scope, id);
        return true;
      },
    })(cmd.input);
    expect(accepted.kind).toBe('pending');
    expect(
      (await sql<{ n: number }>`select count(*)::int n from reasoning.cutroom_maintenance`.execute(f.world.db)).rows[0]!
        .n,
    ).toBe(1);
    expect(await f.world.db.selectFrom('content.cutroom_reviews').selectAll().execute()).toHaveLength(1);
  });
  it('rejects arbitrary queue/world, copied/closed capability and cross-operation accounting with zero send effect', async () => {
    f = await commissionFixture('queuecaps');
    const c = await fixtureDispatchedCommission(f, 'queuecaps'),
      send = vi.spyOn(f.boss, 'send');
    const enqueue = makeEnqueueCutroom(f.boss),
      accounting = makeEnqueueCutroomMaintenance(f.boss),
      other = defineQueue({
        name: 'fixture.paid',
        purpose: 'fixture',
        payload: z.unknown(),
        policy: cutroomPoolQueue.policy,
        consumer: cutroomPoolQueue.consumer,
      });
    await f.service().withScope(c.input.authority, 'admit', async (scope) => {
      await expect(enqueue(scope, other, { v: 1 })).rejects.toThrow('CUTROOM_FIXED_QUEUE_REQUIRED');
      await expect(
        enqueue(scope, cutroomPoolQueue, {
          v: 1,
          worldId: 'stage',
          generation: 1,
          attemptId: c.target.attemptId,
          operationId: randomUUID(),
        }),
      ).rejects.toThrow('CUTROOM_JOB_WORLD_MISMATCH');
      await expect(
        enqueue({ ...scope }, cutroomPoolQueue, {
          v: 1,
          worldId: 'dev',
          generation: 1,
          attemptId: c.target.attemptId,
          operationId: randomUUID(),
        }),
      ).rejects.toThrow('forged or closed');
    });
    let retained: Parameters<typeof accounting>[0] | undefined;
    await c.accounting(c.target, async (scope) => {
      retained = scope;
      await expect(
        accounting(scope, {
          kind: 'settle',
          payload: { v: 1, ...c.target, attemptId: randomUUID(), operationId: randomUUID() },
        }),
      ).rejects.toThrow('CUTROOM_MAINTENANCE_BINDING');
    });
    await expect(
      accounting(retained!, { kind: 'settle', payload: { v: 1, ...c.target, operationId: randomUUID() } }),
    ).rejects.toThrow('forged or closed');
    expect(send).not.toHaveBeenCalled();
  });
  it('consumes one genuine committed C1 permit for exactly stored POST bytes; copied/replayed/lost ACK never authorizes a resend', async () => {
    f = await commissionFixture('onesend');
    const c = await fixtureDispatchedCommission(f, 'onesend');
    const transport = makeCutroomSubmitClient({ enabled: true, origin: 'http://127.0.0.1:9876' }),
      canary = 'private-provider-error-canary';
    const fetch = vi.fn(() => Promise.reject(new Error(canary)));
    vi.stubGlobal('fetch', fetch);
    expect(await transport.submit({ ...c.permit })).toEqual({ kind: 'held', code: 'permit' });
    const result = await transport.submit(c.permit);
    expect(result).toMatchObject({ kind: 'observed', outcome: 'unknown', runId: null });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      expect.any(URL),
      { method: 'POST', body: c.prepared.requestUtf8, redirect: 'error' },
    ]);
    expect(await transport.submit(c.permit)).toEqual({ kind: 'held', code: 'permit' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await c.execution.prepareIntent(c.input.authority, c.target.attemptId)).toMatchObject({
      kind: 'held',
      code: 'unknown',
    });
  });
  it('commits an advancing continuation before25 busy/live heads, then restart reaches orphan26 without resetting the ceiling', async () => {
    f = await commissionFixture('recoverfair');
    await applyQueueDeclarations(f.boss, [cutroomSettleQueue, recoverCutroomQueue]);
    await f.boss.unschedule(recoverCutroomQueue.name);
    const maintenance = cutroomMaintenanceFor(f.world.db, f.boss, {
      enabled: true,
      worldId: 'dev',
      lockBusiness: lockCommissionBusiness,
    });
    const attempts = [];
    for (let i = 0; i < 26; i++) {
      const c = await fixtureDispatchedCommission(f, `page-${i}`);
      await f
        .service()
        .withScope(c.input.authority, 'admit', (scope) => maintenance.trackInScope(scope, c.target.attemptId));
      attempts.push(c);
    }
    attempts.sort((a, b) => a.target.attemptId.localeCompare(b.target.attemptId));
    const tail = attempts[25]!;
    await sql`update reasoning.cutroom_maintenance set next_at=clock_timestamp()-interval '1 minute'`.execute(
      f.world.db,
    );
    // Authored terminal delivery fixture; no production recovery path edits job state.
    await sql`update pgboss.job set state='failed',completed_on=clock_timestamp() where name in ('reasoning.cutroom-follow','reasoning.cutroom-pool') and data->>'attemptId'=${tail.target.attemptId}`.execute(
      f.world.db,
    );
    await sql`create function pgboss.ci_cutroom_page_fail() returns trigger language plpgsql as $$begin if new.name='reasoning.recover-cutroom' then raise check_violation using message='CI_CUTROOM_PAGE_FAIL';end if;return new;end$$`.execute(
      f.world.db,
    );
    await sql`create trigger ci_cutroom_page_fail before insert on pgboss.job for each row execute function pgboss.ci_cutroom_page_fail()`.execute(
      f.world.db,
    );
    try {
      await expect(maintenance.recover({ v: 1 })).rejects.toThrow('CI_CUTROOM_PAGE_FAIL');
    } finally {
      await sql`drop trigger ci_cutroom_page_fail on pgboss.job`.execute(f.world.db);
      await sql`drop function pgboss.ci_cutroom_page_fail()`.execute(f.world.db);
    }
    expect(
      (
        await sql<{ n: number }>`select count(*)::int n from pgboss.job where name='reasoning.recover-cutroom'`.execute(
          f.world.db,
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await sql<{ n: number }>`select count(*)::int n from reasoning.cutroom_maintenance where recoveries>0`.execute(
          f.world.db,
        )
      ).rows[0]!.n,
    ).toBe(0);
    const blocked = new pg.Client({ connectionString: f.world.settings.url });
    await blocked.connect();
    await blocked.query('begin');
    await blocked.query('select 1 from content.reel_commissions where business_run_id=$1 for update', [
      attempts[0]!.target.businessRunId,
    ]);
    try {
      const first = await maintenance.recover({ v: 1 });
      expect(first).toEqual({ scanned: 25, woken: 0 });
    } finally {
      await blocked.query('rollback');
      await blocked.end();
    }
    const child = (
      await sql<{
        data: { v: 1; afterAttemptId: string; throughAttemptId: string };
      }>`select data from pgboss.job where name='reasoning.recover-cutroom' and state='created'`.execute(f.world.db)
    ).rows;
    expect(child).toHaveLength(1);
    expect(child[0]!.data).toEqual({
      v: 1,
      afterAttemptId: attempts[24]!.target.attemptId,
      throughAttemptId: tail.target.attemptId,
    });
    await maintenance.recover({ v: 1 });
    expect(
      (
        await sql<{ n: number }>`select count(*)::int n from pgboss.job where name='reasoning.recover-cutroom'`.execute(
          f.world.db,
        )
      ).rows[0]!.n,
    ).toBe(1);
    const consumer = createBoss(f.world.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await consumer.start();
    try {
      await startConsumers(
        consumer,
        [
          jobConsumer(
            { ...recoverCutroomQueue, consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 } },
            async (payload) => {
              await maintenance.recover(payload);
            },
          ),
        ],
        () => undefined,
      );
      await expect
        .poll(
          async () =>
            Number(
              (
                await sql<{
                  recoveries: number;
                }>`select recoveries from reasoning.cutroom_maintenance where attempt_id=${tail.target.attemptId}::uuid`.execute(
                  f!.world.db,
                )
              ).rows[0]!.recoveries,
            ),
          { timeout: 10000 },
        )
        .toBe(1);
      const counts = (
        await sql<{ n: number }>`select count(*)::int n from reasoning.cutroom_maintenance where recoveries>0`.execute(
          f.world.db,
        )
      ).rows[0]!.n;
      expect(counts).toBe(1);
      expect(await maintenance.recover(child[0]!.data)).toEqual({ scanned: 0, woken: 0 });
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int n from pgboss.job where name='reasoning.recover-cutroom'`.execute(f.world.db)
        ).rows[0]!.n,
      ).toBe(1);
    } finally {
      await consumer.stop({ graceful: false });
    }
  }, 60000);
});
