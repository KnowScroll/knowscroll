import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import pg from 'pg';

import {createReasoningAdmission, REASONING_ADMISSION_LIMITS, type ClaimedJob, type ReserveAttemptInput} from '../packages/db/src/reasoning-admission.ts';
import {ReasoningDenied, type ReasoningAuthority, type ReasoningScope, type ResolvedReasoningPolicy} from '../packages/db/src/reasoning-runtime-policy.ts';
import {runMigrations} from '../packages/db/src/migrations.ts';

const databaseUrl = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith('knowscroll_test_')) {
  throw new Error(`Reasoning admission tests require a disposable knowscroll_test_* database, received ${databaseName}`);
}

type Graph = {universeId: string; jobId: string; contextId: string; stepId: string; epoch: number};
type MutableAuthority = ReasoningAuthority & {
  policies: Map<string, unknown>;
  validContexts: Map<string, boolean>;
};

async function withSchema(name: string, fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const schema = `admission_${name}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({connectionString: databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({connectionString: url.toString(), max: 12});
  try {
    await runMigrations(pool, {directory: 'packages/db/migrations'});
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

function makeAuthority(): MutableAuthority {
  const policies = new Map<string, unknown>();
  const validContexts = new Map<string, boolean>();
  return {
    policies,
    validContexts,
    async resolvePolicy(_client, scope) {
      return policies.get(scope.jobId);
    },
    async validateContext(_client, scope) {
      return validContexts.get(scope.contextId) ?? false;
    },
  };
}

function makePolicy(scope: ReasoningScope, shared: Partial<Record<'global' | 'provider' | 'route' | 'remote', string>> = {}): ResolvedReasoningPolicy {
  return {
    version: 1,
    routeId: 'minimax-m3',
    routeProfileVersion: 'profile-v1',
    policyVersion: 'policy-v1',
    maxInputTokens: 100,
    maxOutputTokens: 100,
    priceBasis: null,
    requiredDimensions: ['global_budget', 'owner_budget', 'job_budget', 'provider_account', 'route_quota', 'remote_concurrency'],
    buckets: [
      {bucketId: shared.global ?? randomUUID(), dimension: 'global_budget', unit: 'tokens', windowId: null, scope: 'shared', scopeId: null, basis: 'total_tokens', handling: 'budget'},
      {bucketId: randomUUID(), dimension: 'owner_budget', unit: 'tokens', windowId: null, scope: 'owner', scopeId: scope.universeId, basis: 'total_tokens', handling: 'budget'},
      {bucketId: randomUUID(), dimension: 'job_budget', unit: 'tokens', windowId: null, scope: 'job', scopeId: scope.jobId, basis: 'total_tokens', handling: 'budget'},
      {bucketId: shared.provider ?? randomUUID(), dimension: 'provider_account', unit: 'requests', windowId: null, scope: 'shared', scopeId: null, basis: 'requests', handling: 'budget'},
      {bucketId: shared.route ?? randomUUID(), dimension: 'route_quota', unit: 'requests', windowId: null, scope: 'shared', scopeId: null, basis: 'requests', handling: 'budget'},
      {bucketId: shared.remote ?? randomUUID(), dimension: 'remote_concurrency', unit: 'slots', windowId: null, scope: 'shared', scopeId: null, basis: 'remote_slots', handling: 'remote'},
    ],
  };
}

async function seedGraph(pool: pg.Pool, createdOffset = '0 milliseconds', deadline = '1 hour'): Promise<Graph> {
  const graph = {universeId: randomUUID(), jobId: randomUUID(), contextId: randomUUID(), stepId: randomUUID(), epoch: 0};
  await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)', [graph.universeId]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [graph.universeId]);
  await pool.query(
    `INSERT INTO reasoning_job
      (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,created_at,wake_kind,intent_id)
     VALUES($1,$2,0,'queued','interactive',$2,'policy-v1',clock_timestamp()+$3::interval,
       clock_timestamp()+$4::interval,'direct',$5)`,
    [graph.jobId, graph.universeId, deadline, createdOffset, randomUUID()],
  );
  await pool.query(
    `INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,'policy-v1','source-v1')`,
    [graph.contextId, graph.jobId, graph.universeId, 'a'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision)
     VALUES($1,$2,0,'source','public',NULL,'source:fixture',1)`,
    [graph.contextId, graph.universeId],
  );
  await pool.query(
    `INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
     VALUES($1,$2,$3,0,$4,1,'pending')`,
    [graph.stepId, graph.jobId, graph.universeId, graph.contextId],
  );
  return graph;
}

async function installPolicy(pool: pg.Pool, authority: MutableAuthority, graph: Graph, policy = makePolicy({universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId}), capacity = 1_000): Promise<ResolvedReasoningPolicy> {
  authority.policies.set(graph.jobId, policy);
  authority.validContexts.set(graph.contextId, true);
  for (const binding of policy.buckets) {
    await pool.query(
      `INSERT INTO reasoning_bucket(id,dimension,unit,window_id,capacity)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
      [binding.bucketId, binding.dimension, binding.unit, binding.windowId, capacity],
    );
  }
  return policy;
}

function reservationInput(graph: Graph, claim: ClaimedJob, overrides: Partial<ReserveAttemptInput> = {}): ReserveAttemptInput {
  return {
    universeId: graph.universeId,
    privacyEpoch: graph.epoch,
    jobId: graph.jobId,
    stepId: graph.stepId,
    contextId: graph.contextId,
    owner: 'worker-a',
    leaseFence: claim.leaseFence,
    requestId: randomUUID(),
    requestHash: 'b'.repeat(64),
    inputTokensUpperBound: 20,
    maxOutputTokens: 20,
    costCeilingMicroUsd: null,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    permitTtlMs: 20_000,
    ...overrides,
  };
}

async function claimAndReserve(pool: pg.Pool, authority: MutableAuthority, graph: Graph, owner = 'worker-a') {
  const admission = createReasoningAdmission(pool, authority);
  const claim = await admission.claimJob({owner, leaseMs: 50_000});
  assert(claim);
  const input = reservationInput(graph, claim, {owner});
  const reserved = await admission.reserveAttempt(input);
  return {admission, claim, input, reserved};
}

function assertDenied(error: unknown, code: string): boolean {
  return error instanceof ReasoningDenied && error.code === code;
}

test('reasoning admission uses atomic PostgreSQL authority and one-time dispatch grants', async (t) => {
  await t.test('lease and permit TTLs are explicitly bounded', async () => {
    await withSchema('bounds', async (pool) => {
      const authority = makeAuthority();
      const expired = await seedGraph(pool, '-2 seconds', '-1 second');
      const graph = await seedGraph(pool);
      await installPolicy(pool, authority, graph);
      const admission = createReasoningAdmission(pool, authority);
      await assert.rejects(
        admission.claimJob({owner: 'worker-a', leaseMs: REASONING_ADMISSION_LIMITS.maxLeaseMs + 1}),
        (error) => assertDenied(error, 'invalid_lease_duration'),
      );
      const claim = await admission.claimJob({owner: 'worker-a', leaseMs: 10_000});
      assert(claim);
      assert.equal(claim.jobId, graph.jobId);
      assert.equal((await pool.query('SELECT status FROM reasoning_job WHERE id=$1', [expired.jobId])).rows[0]?.status, 'expired');
      await assert.rejects(
        admission.reserveAttempt(reservationInput(graph, claim, {permitTtlMs: REASONING_ADMISSION_LIMITS.maxPermitTtlMs + 1})),
        (error) => assertDenied(error, 'invalid_permit_duration'),
      );
    });
  });

  await t.test('concurrent shared-capacity contention admits exactly one and rolls the loser back', async () => {
    await withSchema('capacity', async (pool) => {
      const authority = makeAuthority();
      const first = await seedGraph(pool, '-2 seconds');
      const second = await seedGraph(pool, '-1 second');
      const shared = {global: randomUUID(), provider: randomUUID(), route: randomUUID(), remote: randomUUID()};
      await installPolicy(pool, authority, first, makePolicy({universeId: first.universeId, privacyEpoch: 0, jobId: first.jobId}, shared), 60);
      await installPolicy(pool, authority, second, makePolicy({universeId: second.universeId, privacyEpoch: 0, jobId: second.jobId}, shared), 60);
      const admission = createReasoningAdmission(pool, authority);
      const claim1 = await admission.claimJob({owner: 'worker-a', leaseMs: 50_000});
      const claim2 = await admission.claimJob({owner: 'worker-b', leaseMs: 50_000});
      assert(claim1 && claim2);
      const requests = [
        reservationInput(first, claim1, {owner: 'worker-a', inputTokensUpperBound: 30, maxOutputTokens: 30}),
        reservationInput(second, claim2, {owner: 'worker-b', inputTokensUpperBound: 30, maxOutputTokens: 30}),
      ];
      const outcomes = await Promise.allSettled(requests.map((input) => admission.reserveAttempt(input)));
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejection = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert(rejection && assertDenied(rejection.reason, 'insufficient_capacity'));
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_attempt')).rows[0]?.count, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_permit')).rows[0]?.count, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_reservation')).rows[0]?.count, 6);
      assert.equal((await pool.query('SELECT reserved::text FROM reasoning_bucket WHERE id=$1', [shared.global])).rows[0]?.reserved, '60');
    });
  });

  await t.test('invalid, missing, stale policy and context bindings leave no partial admission', async () => {
    await withSchema('binding', async (pool) => {
      const authority = makeAuthority();
      const graph = await seedGraph(pool);
      const policy = await installPolicy(pool, authority, graph);
      const admission = createReasoningAdmission(pool, authority);
      const claim = await admission.claimJob({owner: 'worker-a', leaseMs: 50_000});
      assert(claim);
      authority.validContexts.set(graph.contextId, false);
      await assert.rejects(admission.reserveAttempt(reservationInput(graph, claim)), (error) => assertDenied(error, 'stale_context'));
      authority.validContexts.set(graph.contextId, true);
      authority.policies.set(graph.jobId, {...policy, buckets: policy.buckets.slice(1)});
      await assert.rejects(admission.reserveAttempt(reservationInput(graph, claim)), (error) => error instanceof ReasoningDenied);
      authority.policies.set(graph.jobId, policy);
      await pool.query('DELETE FROM reasoning_bucket WHERE id=$1', [policy.buckets[0]?.bucketId]);
      await assert.rejects(admission.reserveAttempt(reservationInput(graph, claim)), (error) => assertDenied(error, 'missing_bucket'));
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_attempt')).rows[0]?.count, 0);
      assert.equal((await pool.query('SELECT coalesce(sum(reserved),0)::text AS reserved FROM reasoning_bucket')).rows[0]?.reserved, '0');
    });
  });

  await t.test('stale lease, epoch, context, request hash and output ceiling cannot authorize', async () => {
    await withSchema('stale', async (pool) => {
      const authority = makeAuthority();
      const graph = await seedGraph(pool);
      await installPolicy(pool, authority, graph);
      const {admission, claim, input, reserved} = await claimAndReserve(pool, authority, graph);
      const dispatch = {
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: reserved.attemptId, owner: input.owner, leaseFence: claim.leaseFence,
        requestId: input.requestId, requestHash: input.requestHash, inputTokensUpperBound: input.inputTokensUpperBound, maxOutputTokens: input.maxOutputTokens, dispatchId: randomUUID(),
      };
      await assert.rejects(admission.authorizeDispatch({...dispatch, leaseFence: String(BigInt(claim.leaseFence) + 1n)}), (error) => assertDenied(error, 'stale_lease'));
      await assert.rejects(admission.authorizeDispatch({...dispatch, requestHash: 'c'.repeat(64)}), (error) => assertDenied(error, 'request_binding_mismatch'));
      await assert.rejects(admission.authorizeDispatch({...dispatch, requestId: randomUUID()}), (error) => assertDenied(error, 'request_binding_mismatch'));
      await assert.rejects(admission.authorizeDispatch({...dispatch, inputTokensUpperBound: input.inputTokensUpperBound + 1}), (error) => assertDenied(error, 'request_binding_mismatch'));
      await assert.rejects(admission.authorizeDispatch({...dispatch, maxOutputTokens: input.maxOutputTokens + 1}), (error) => assertDenied(error, 'request_binding_mismatch'));
      authority.validContexts.set(graph.contextId, false);
      await assert.rejects(admission.authorizeDispatch(dispatch), (error) => assertDenied(error, 'stale_context'));
      authority.validContexts.set(graph.contextId, true);
      await pool.query('UPDATE universe SET privacy_epoch=1 WHERE id=$1', [graph.universeId]);
      await assert.rejects(admission.authorizeDispatch(dispatch), (error) => assertDenied(error, 'stale_epoch'));
    });
  });

  await t.test('authorization is granted exactly once after commit and existing intent never replays', async () => {
    await withSchema('authorize', async (pool) => {
      const authority = makeAuthority();
      const graph = await seedGraph(pool);
      await installPolicy(pool, authority, graph);
      const {admission, claim, input, reserved} = await claimAndReserve(pool, authority, graph);
      const dispatch = {
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: reserved.attemptId, owner: input.owner, leaseFence: claim.leaseFence,
        requestId: input.requestId, requestHash: input.requestHash, inputTokensUpperBound: input.inputTokensUpperBound, maxOutputTokens: input.maxOutputTokens, dispatchId: randomUUID(),
      };
      const outcomes = await Promise.allSettled([
        admission.authorizeDispatch(dispatch),
        admission.authorizeDispatch({...dispatch, dispatchId: randomUUID()}),
      ]);
      const grant = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof admission.authorizeDispatch>>> => outcome.status === 'fulfilled');
      assert(grant);
      assert.equal(grant.value.requestHash, input.requestHash);
      assert.equal(grant.value.inputTokensUpperBound, input.inputTokensUpperBound);
      assert.equal(grant.value.deadline, input.deadline);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      await assert.rejects(admission.authorizeDispatch(dispatch), (error) => assertDenied(error, 'dispatch_already_decided'));
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM reasoning_accounting WHERE state='dispatch_committed'")).rows[0]?.count, 1);
    });
  });

  await t.test('lost COMMIT acknowledgement returns no grant and retry cannot replay committed authorization', async () => {
    await withSchema('lostack', async (pool) => {
      const authority = makeAuthority();
      const graph = await seedGraph(pool);
      await installPolicy(pool, authority, graph);
      const {admission, claim, input, reserved} = await claimAndReserve(pool, authority, graph);
      const wrapped = {
        connect: async () => {
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property, receiver) {
              if (property !== 'query') return Reflect.get(target, property, receiver);
              return async (...args: unknown[]) => {
                const statement = args[0];
                if (statement === 'COMMIT') {
                  await (target.query as (...queryArgs: unknown[]) => Promise<unknown>).apply(target, args);
                  throw new Error('simulated lost commit acknowledgement');
                }
                return (target.query as (...queryArgs: unknown[]) => Promise<unknown>).apply(target, args);
              };
            },
          });
        },
      } as unknown as pg.Pool;
      const uncertain = createReasoningAdmission(wrapped, authority);
      const dispatch = {
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: reserved.attemptId, owner: input.owner, leaseFence: claim.leaseFence,
        requestId: input.requestId, requestHash: input.requestHash, inputTokensUpperBound: input.inputTokensUpperBound, maxOutputTokens: input.maxOutputTokens, dispatchId: randomUUID(),
      };
      await assert.rejects(uncertain.authorizeDispatch(dispatch), /lost commit acknowledgement/);
      assert.equal((await pool.query('SELECT dispatch_id FROM reasoning_accounting WHERE attempt_id=$1', [reserved.attemptId])).rows[0]?.dispatch_id, dispatch.dispatchId);
      await assert.rejects(admission.authorizeDispatch(dispatch), (error) => assertDenied(error, 'dispatch_already_decided'));
    });
  });

  await t.test('withdraw before dispatch refunds all reservations; withdraw after dispatch preserves uncertainty', async () => {
    await withSchema('withdraw', async (pool) => {
      const authority = makeAuthority();
      const beforeGraph = await seedGraph(pool, '-2 seconds');
      const afterGraph = await seedGraph(pool, '-1 second');
      await installPolicy(pool, authority, beforeGraph);
      await installPolicy(pool, authority, afterGraph);
      const before = await claimAndReserve(pool, authority, beforeGraph, 'worker-before');
      const beforeResult = await before.admission.withdrawJob({
        universeId: beforeGraph.universeId, privacyEpoch: 0, jobId: beforeGraph.jobId,
        owner: 'worker-before', leaseFence: before.claim.leaseFence, reason: 'cancelled',
      });
      assert.deepEqual(beforeResult, {closedNotSent: 1, preservedUnknown: 0});
      assert.equal((await pool.query('SELECT state FROM reasoning_accounting WHERE attempt_id=$1', [before.reserved.attemptId])).rows[0]?.state, 'not_sent');
      assert.equal((await pool.query('SELECT coalesce(sum(reserved),0)::text AS value FROM reasoning_bucket WHERE id=ANY($1::uuid[])', [(authority.policies.get(beforeGraph.jobId) as ResolvedReasoningPolicy).buckets.map((b) => b.bucketId)])).rows[0]?.value, '0');

      const after = await claimAndReserve(pool, authority, afterGraph, 'worker-after');
      await after.admission.authorizeDispatch({
        universeId: afterGraph.universeId, privacyEpoch: 0, jobId: afterGraph.jobId, stepId: afterGraph.stepId,
        attemptId: after.reserved.attemptId, owner: 'worker-after', leaseFence: after.claim.leaseFence,
        requestId: after.input.requestId, requestHash: after.input.requestHash, inputTokensUpperBound: after.input.inputTokensUpperBound, maxOutputTokens: after.input.maxOutputTokens, dispatchId: randomUUID(),
      });
      const afterResult = await after.admission.withdrawJob({
        universeId: afterGraph.universeId, privacyEpoch: 0, jobId: afterGraph.jobId,
        owner: 'worker-after', leaseFence: after.claim.leaseFence, reason: 'cancelled',
      });
      assert.deepEqual(afterResult, {closedNotSent: 0, preservedUnknown: 1});
      const account = (await pool.query('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1', [after.reserved.attemptId])).rows[0];
      assert.deepEqual(account, {state: 'unknown', output_authority: 'withdrawn'});
      assert.equal((await pool.query('SELECT state FROM reasoning_permit WHERE attempt_id=$1', [after.reserved.attemptId])).rows[0]?.state, 'consumed');
    });
  });

  await t.test('transport loss marks consumed work unknown without refund or replay', async () => {
    await withSchema('unknown', async (pool) => {
      const authority = makeAuthority();
      const graph = await seedGraph(pool);
      await installPolicy(pool, authority, graph);
      const value = await claimAndReserve(pool, authority, graph);
      await value.admission.authorizeDispatch({
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: value.reserved.attemptId, owner: 'worker-a', leaseFence: value.claim.leaseFence,
        requestId: value.input.requestId, requestHash: value.input.requestHash, inputTokensUpperBound: value.input.inputTokensUpperBound, maxOutputTokens: value.input.maxOutputTokens, dispatchId: randomUUID(),
      });
      assert.deepEqual(await value.admission.markAttemptUnknown({
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: value.reserved.attemptId, owner: 'worker-a', leaseFence: value.claim.leaseFence, reason: 'transport_loss',
      }), {outcome: 'unknown', outputWithdrawn: false});
      const account = (await pool.query('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1', [value.reserved.attemptId])).rows[0];
      assert.deepEqual(account, {state: 'unknown', output_authority: 'eligible'});
      await assert.rejects(value.admission.markAttemptUnknown({
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: value.reserved.attemptId, owner: 'worker-a', leaseFence: value.claim.leaseFence, reason: 'transport_loss',
      }), (error) => assertDenied(error, 'attempt_not_active'));
    });
  });

  await t.test('local cancellation withdraws output and obsolete private state is harmless', async () => {
    await withSchema('localcancel', async (pool) => {
      const authority = makeAuthority();
      const graph = await seedGraph(pool);
      await installPolicy(pool, authority, graph);
      const value = await claimAndReserve(pool, authority, graph);
      await value.admission.authorizeDispatch({
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: value.reserved.attemptId, owner: 'worker-a', leaseFence: value.claim.leaseFence,
        requestId: value.input.requestId, requestHash: value.input.requestHash,
        inputTokensUpperBound: value.input.inputTokensUpperBound, maxOutputTokens: value.input.maxOutputTokens, dispatchId: randomUUID(),
      });
      assert.deepEqual(await value.admission.markAttemptUnknown({
        universeId: graph.universeId, privacyEpoch: 0, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: value.reserved.attemptId, owner: 'worker-a', leaseFence: value.claim.leaseFence, reason: 'local_cancel',
      }), {outcome: 'unknown', outputWithdrawn: true});
      assert.equal((await pool.query('SELECT output_authority FROM reasoning_accounting WHERE attempt_id=$1', [value.reserved.attemptId])).rows[0]?.output_authority, 'withdrawn');
      assert.deepEqual(await value.admission.markAttemptUnknown({
        universeId: graph.universeId, privacyEpoch: 1, jobId: graph.jobId, stepId: graph.stepId,
        attemptId: value.reserved.attemptId, owner: 'worker-a', leaseFence: value.claim.leaseFence, reason: 'transport_loss',
      }), {outcome: 'private_state_gone', outputWithdrawn: true});
    });
  });

  await t.test('lease and permit expiry while waiting on bucket locks fail after the wait and roll back', async () => {
    await withSchema('waitexpiry', async (pool) => {
      const authority = makeAuthority();
      const reserveGraph = await seedGraph(pool, '-2 seconds');
      const authGraph = await seedGraph(pool, '-1 second');
      const reservePolicy = await installPolicy(pool, authority, reserveGraph);
      const authPolicy = await installPolicy(pool, authority, authGraph);
      const admission = createReasoningAdmission(pool, authority);
      const reserveClaim = await admission.claimJob({owner: 'worker-reserve', leaseMs: 80});
      assert(reserveClaim);
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM reasoning_bucket WHERE id=$1 FOR UPDATE', [reservePolicy.buckets[0]?.bucketId]);
      const waitingReserve = admission.reserveAttempt(reservationInput(reserveGraph, reserveClaim, {owner: 'worker-reserve'}));
      await new Promise((resolve) => setTimeout(resolve, 120));
      await blocker.query('ROLLBACK');
      blocker.release();
      await assert.rejects(waitingReserve, (error) => assertDenied(error, 'expired_lease_or_job'));
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_attempt WHERE job_id=$1', [reserveGraph.jobId])).rows[0]?.count, 0);

      const authClaim = await admission.claimJob({owner: 'worker-auth', leaseMs: 10_000});
      assert(authClaim?.jobId === authGraph.jobId);
      const authInput = reservationInput(authGraph, authClaim, {owner: 'worker-auth', permitTtlMs: 50});
      const reserved = await admission.reserveAttempt(authInput);
      const authBlocker = await pool.connect();
      await authBlocker.query('BEGIN');
      await authBlocker.query('SELECT id FROM reasoning_bucket WHERE id=$1 FOR UPDATE', [authPolicy.buckets[0]?.bucketId]);
      const waitingAuth = admission.authorizeDispatch({
        universeId: authGraph.universeId, privacyEpoch: 0, jobId: authGraph.jobId, stepId: authGraph.stepId,
        attemptId: reserved.attemptId, owner: 'worker-auth', leaseFence: authClaim.leaseFence,
        requestId: authInput.requestId, requestHash: authInput.requestHash, inputTokensUpperBound: authInput.inputTokensUpperBound,
        maxOutputTokens: authInput.maxOutputTokens, dispatchId: randomUUID(),
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await authBlocker.query('ROLLBACK');
      authBlocker.release();
      await assert.rejects(waitingAuth, (error) => assertDenied(error, 'authorization_expired'));
      assert.equal((await pool.query('SELECT state FROM reasoning_accounting WHERE attempt_id=$1', [reserved.attemptId])).rows[0]?.state, 'reserved');
    });
  });

  await t.test('recovery refuses a healthy lease and fences expired unconsumed or consumed work without replay', async () => {
    await withSchema('recover', async (pool) => {
      const authority = makeAuthority();
      const reservedGraph = await seedGraph(pool, '-2 seconds');
      const consumedGraph = await seedGraph(pool, '-1 second');
      await installPolicy(pool, authority, reservedGraph);
      await installPolicy(pool, authority, consumedGraph);
      const reserved = await claimAndReserve(pool, authority, reservedGraph, 'worker-reserved');
      await assert.rejects(reserved.admission.recoverAttempt({
        universeId: reservedGraph.universeId, privacyEpoch: 0, jobId: reservedGraph.jobId, stepId: reservedGraph.stepId,
        attemptId: reserved.reserved.attemptId, owner: 'recovery-worker',
      }), (error) => assertDenied(error, 'lease_still_healthy'));
      await pool.query("UPDATE reasoning_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [reservedGraph.jobId]);
      assert.equal((await reserved.admission.recoverAttempt({
        universeId: reservedGraph.universeId, privacyEpoch: 0, jobId: reservedGraph.jobId, stepId: reservedGraph.stepId,
        attemptId: reserved.reserved.attemptId, owner: 'recovery-worker',
      })).outcome, 'not_sent');

      const consumed = await claimAndReserve(pool, authority, consumedGraph, 'worker-consumed');
      await consumed.admission.authorizeDispatch({
        universeId: consumedGraph.universeId, privacyEpoch: 0, jobId: consumedGraph.jobId, stepId: consumedGraph.stepId,
        attemptId: consumed.reserved.attemptId, owner: 'worker-consumed', leaseFence: consumed.claim.leaseFence,
        requestId: consumed.input.requestId, requestHash: consumed.input.requestHash, inputTokensUpperBound: consumed.input.inputTokensUpperBound, maxOutputTokens: consumed.input.maxOutputTokens, dispatchId: randomUUID(),
      });
      await pool.query("UPDATE reasoning_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [consumedGraph.jobId]);
      assert.equal((await consumed.admission.recoverAttempt({
        universeId: consumedGraph.universeId, privacyEpoch: 0, jobId: consumedGraph.jobId, stepId: consumedGraph.stepId,
        attemptId: consumed.reserved.attemptId, owner: 'recovery-worker',
      })).outcome, 'unknown');
      assert.equal((await pool.query('SELECT state FROM reasoning_permit WHERE attempt_id=$1', [consumed.reserved.attemptId])).rows[0]?.state, 'consumed');
    });
  });

  await t.test('a locked universe does not block claiming another ready universe', async () => {
    await withSchema('skiplocked', async (pool) => {
      const authority = makeAuthority();
      const blocked = await seedGraph(pool, '-2 seconds');
      const available = await seedGraph(pool, '-1 second');
      await installPolicy(pool, authority, blocked);
      await installPolicy(pool, authority, available);
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [blocked.universeId]);
        const claimed = await createReasoningAdmission(pool, authority).claimJob({owner: 'worker-free', leaseMs: 20_000});
        assert.equal(claimed?.jobId, available.jobId);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    });
  });
});
