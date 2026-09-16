import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import pg from 'pg';

import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {createReasoningFairness, type FairnessReadyInput, type FairnessScheduled} from '../packages/db/src/reasoning-fairness.ts';
import {lockFairnessResources, releaseNotSentFairness, settleFairness, clearFairnessMembership} from '../packages/db/src/reasoning-fairness-accounting.ts';
import {validateFairnessPolicy} from '../packages/db/src/reasoning-fairness-policy.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {createReasoningReconciliation} from '../packages/db/src/reasoning-reconciliation.ts';
import {runMigrations} from '../packages/db/src/migrations.ts';
import {fairnessAuthority, seedFairnessGraph, sqlFairnessPolicy} from './helpers/reasoning-fairness-fixture.ts';

const databaseUrl = process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL required'); })();
if (!new URL(databaseUrl).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Fairness SQL adversarial tests require an isolated knowscroll_test_* database');
}

const policy = {
  version: 'fairness-sql-v1', quantum: 100, maxCharge: 100, scale: 100,
  basis: {input_tokens: 100, output_tokens: 100, total_tokens: 100, requests: 100},
  maxProbes: 32, maxAdmissions: 16,
};

async function withSchema(name: string, body: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const schema = `fairness_sql_${name}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({connectionString: databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({connectionString: url.toString(), max: 4});
  try {
    await runMigrations(pool, {directory: 'packages/db/migrations'});
    await body(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

async function inTransaction<T>(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedPolicy(pool: pg.Pool): Promise<void> {
  const {hash} = validateFairnessPolicy(policy);
  await pool.query('INSERT INTO reasoning_fairness_policy(version,policy_hash,config) VALUES($1,$2,$3::jsonb)', [policy.version, hash, JSON.stringify(policy)]);
  await pool.query('INSERT INTO reasoning_fairness_scheduler(policy_version) VALUES($1)', [policy.version]);
  await pool.query("INSERT INTO reasoning_fairness_class(policy_version,class) VALUES($1,'interactive')", [policy.version]);
}

async function seedUniverse(pool: pg.Pool): Promise<string> {
  const universeId = randomUUID();
  await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)', [universeId]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)', [universeId]);
  await pool.query("INSERT INTO reasoning_fairness_universe(policy_version,class,universe_id) VALUES($1,'interactive',$2)", [policy.version, universeId]);
  return universeId;
}

async function seedAccounting(pool: pg.Pool, universeId: string, state: 'not_sent' | 'dispatch_committed'): Promise<string> {
  const attemptId = randomUUID();
  if (state === 'not_sent') {
    await pool.query(`INSERT INTO reasoning_accounting
      (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,
       state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold,closure_basis,all_duties_closed_at)
      VALUES($1,$2,0,$3,'route','profile',100,clock_timestamp()+interval '1 hour',
       'not_sent','withdrawn','settled','released','not_sent',false,false,'evidence',clock_timestamp())`,
    [attemptId, universeId, randomUUID()]);
  } else {
    await pool.query(`INSERT INTO reasoning_accounting
      (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,
       state,dispatch_id,dispatch_committed_at,input_reservation_ceiling,binding_hash,runtime_policy_version)
      VALUES($1,$2,0,$3,'route','profile',100,clock_timestamp()+interval '1 hour',
       'dispatch_committed',$4,clock_timestamp(),100,$5,'runtime-policy')`, [attemptId, universeId, randomUUID(), randomUUID(), 'f'.repeat(64)]);
  }
  return attemptId;
}

async function bindFairAttempt(pool: pg.Pool, attemptId: string, universeId: string, charge: number): Promise<void> {
  await pool.query(`INSERT INTO reasoning_fairness_attempt
    (attempt_id,policy_version,class,universe_id,reserved_charge,recognized_charge)
    VALUES($1,$2,'interactive',$3,$4,$4)`, [attemptId, policy.version, universeId, charge]);
}

function readyFor(graph: Awaited<ReturnType<typeof seedFairnessGraph>>): FairnessReadyInput {
  return {
    policyVersion: 'fairness-v1', class: 'interactive', universeId: graph.universeId, privacyEpoch: 0,
    jobId: graph.jobId, stepId: graph.stepId, contextId: graph.contextId, requestId: graph.requestId,
    requestHash: 'b'.repeat(64), inputTokensUpperBound: 20, maxOutputTokens: 20, costCeilingMicroUsd: null,
    deadline: new Date(Date.now() + 30_000).toISOString(), permitTtlMs: 20_000,
  };
}

async function addRateBinding(
  pool: pg.Pool,
  graph: Awaited<ReturnType<typeof seedFairnessGraph>>,
  windowId: string,
): Promise<string> {
  const bucketId = randomUUID();
  await pool.query(
    "INSERT INTO reasoning_bucket(id,dimension,unit,window_id,capacity) VALUES($1,'combined_rate','tokens',$2,1000)",
    [bucketId, windowId],
  );
  graph.policy.requiredDimensions.push('combined_rate');
  graph.policy.buckets.push({
    bucketId, dimension: 'combined_rate', unit: 'tokens', windowId, scope: 'shared', scopeId: null,
    basis: 'total_tokens', handling: 'rate',
  });
  return bucketId;
}

async function dispatch(
  admission: ReturnType<typeof createReasoningAdmission>,
  ready: FairnessReadyInput,
  outcome: FairnessScheduled,
): Promise<string> {
  const dispatchId = randomUUID();
  await admission.authorizeDispatch({
    universeId: ready.universeId, privacyEpoch: ready.privacyEpoch, jobId: ready.jobId, stepId: ready.stepId,
    attemptId: outcome.reserved.attemptId, owner: 'fairness-review', leaseFence: outcome.claim.leaseFence,
    requestId: ready.requestId, requestHash: ready.requestHash, inputTokensUpperBound: ready.inputTokensUpperBound,
    maxOutputTokens: ready.maxOutputTokens, dispatchId,
  });
  return dispatchId;
}

function receipt(
  ready: FairnessReadyInput,
  outcome: FairnessScheduled,
  dispatchId: string,
): Record<string, unknown> {
  return {
    version: 1, receiptId: randomUUID(), attemptId: outcome.reserved.attemptId, dispatchId,
    requestId: ready.requestId, routeId: outcome.reserved.routeId, routeProfileVersion: outcome.reserved.routeProfileVersion,
    evidenceKind: 'original_transport', observedAt: new Date().toISOString(), remoteDisposition: 'terminal',
    outcome: 'success', httpStatus: 200,
    usage: {inputTokens: 5, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null},
  };
}

test('fairness SQL retained accounting protects scope, idempotency, debt, and privacy membership', async (t) => {
  await t.test('database rejects binding an attempt to another universe fairness balance', async () => {
    await withSchema('cross_scope', async (pool) => {
      await seedPolicy(pool);
      const first = await seedUniverse(pool);
      const second = await seedUniverse(pool);
      const attemptId = await seedAccounting(pool, first, 'not_sent');
      await assert.rejects(bindFairAttempt(pool, attemptId, second, 10), /foreign key/);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_fairness_attempt')).rows[0]?.count, 0);
    });
  });

  await t.test('a proven not-sent closure refunds exactly once and cannot mint a second refund', async () => {
    await withSchema('not_sent', async (pool) => {
      await seedPolicy(pool);
      const universeId = await seedUniverse(pool);
      const attemptId = await seedAccounting(pool, universeId, 'not_sent');
      await bindFairAttempt(pool, attemptId, universeId, 30);

      for (let pass = 0; pass < 2; pass += 1) {
        await inTransaction(pool, async (client) => {
          await lockFairnessResources(client, [attemptId]);
          await releaseNotSentFairness(client, attemptId);
        });
      }
      assert.deepEqual((await pool.query("SELECT credit::text FROM reasoning_fairness_class WHERE policy_version=$1 AND class='interactive'", [policy.version])).rows[0], {credit: '30'});
      assert.deepEqual((await pool.query("SELECT credit::text FROM reasoning_fairness_universe WHERE policy_version=$1 AND class='interactive' AND universe_id=$2", [policy.version, universeId])).rows[0], {credit: '30'});
      assert.deepEqual((await pool.query('SELECT recognized_charge::text FROM reasoning_fairness_attempt WHERE attempt_id=$1', [attemptId])).rows[0], {recognized_charge: '0'});
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_fairness_delta WHERE attempt_id=$1 AND revision=0', [attemptId])).rows[0]?.count, 1);
    });
  });

  await t.test('late cumulative correction retains debt after private membership is cleared without recreating a queue', async () => {
    await withSchema('late_correction', async (pool) => {
      await seedPolicy(pool);
      const universeId = await seedUniverse(pool);
      const attemptId = await seedAccounting(pool, universeId, 'dispatch_committed');
      await bindFairAttempt(pool, attemptId, universeId, 20);

      await inTransaction(pool, async (client) => {
        await lockFairnessResources(client, [attemptId]);
        await settleFairness(client, attemptId, 1, {inputTokens: 5, outputTokens: 5});
        await settleFairness(client, attemptId, 1, {inputTokens: 5, outputTokens: 5});
      });
      assert.deepEqual((await pool.query("SELECT credit::text FROM reasoning_fairness_universe WHERE policy_version=$1 AND class='interactive' AND universe_id=$2", [policy.version, universeId])).rows[0], {credit: '10'});

      await inTransaction(pool, async (client) => {
        await lockFairnessResources(client, [attemptId], universeId);
        await settleFairness(client, attemptId, 2, {inputTokens: 100, outputTokens: 100});
        await clearFairnessMembership(client, universeId);
      });
      assert.deepEqual((await pool.query("SELECT credit::text,candidate_cursor FROM reasoning_fairness_universe WHERE policy_version=$1 AND class='interactive' AND universe_id=$2", [policy.version, universeId])).rows[0], {credit: '-180', candidate_cursor: '0'});
      assert.equal((await pool.query('SELECT paused FROM reasoning_fairness_scheduler WHERE policy_version=$1', [policy.version])).rows[0]?.paused, true);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_fairness_ready WHERE universe_id=$1', [universeId])).rows[0]?.count, 0);

      await inTransaction(pool, async (client) => {
        await lockFairnessResources(client, [attemptId]);
        await settleFairness(client, attemptId, 3, {inputTokens: 200, outputTokens: 100});
      });
      assert.deepEqual((await pool.query("SELECT credit::text FROM reasoning_fairness_universe WHERE policy_version=$1 AND class='interactive' AND universe_id=$2", [policy.version, universeId])).rows[0], {credit: '-280'});
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_fairness_delta WHERE attempt_id=$1', [attemptId])).rows[0]?.count, 3);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job')).rows[0]?.count, 0);
    });
  });

  await t.test('a later measurement may refund only a previously unknown conservative field', async () => {
    await withSchema('partial_known_refund', async (pool) => {
      await seedPolicy(pool);
      const universeId = await seedUniverse(pool);
      const attemptId = await seedAccounting(pool, universeId, 'dispatch_committed');
      await bindFairAttempt(pool, attemptId, universeId, 20);

      await inTransaction(pool, async (client) => {
        await lockFairnessResources(client, [attemptId]);
        await settleFairness(client, attemptId, 1, {inputTokens: null, outputTokens: 5});
        await settleFairness(client, attemptId, 2, {inputTokens: 5, outputTokens: 5});
      });
      assert.deepEqual((await pool.query("SELECT credit::text FROM reasoning_fairness_universe WHERE policy_version=$1 AND class='interactive' AND universe_id=$2", [policy.version, universeId])).rows[0], {credit: '10'});
      assert.deepEqual((await pool.query('SELECT recognized_charge::text FROM reasoning_fairness_attempt WHERE attempt_id=$1', [attemptId])).rows[0], {recognized_charge: '10'});
      assert.deepEqual((await pool.query('SELECT prior_charge::text,recognized_charge::text,class_delta FROM reasoning_fairness_delta WHERE attempt_id=$1 AND revision=2', [attemptId])).rows[0], {prior_charge: '105', recognized_charge: '10', class_delta: '95'});
    });
  });

  await t.test('a late public receipt settles its immutable original rate window after clear and leaves a newer window alone', async () => {
    await withSchema('late_receipt_original_window', async (pool) => {
      const first = await seedFairnessGraph(pool);
      const rateA = await addRateBinding(pool, first, 'window-a');
      const policies = new Map([[first.jobId, first.policy]]);
      const fairness = createReasoningFairness(pool, fairnessAuthority(policies));
      const admission = createReasoningAdmission(pool, fairnessAuthority(policies));
      await fairness.installPolicy(sqlFairnessPolicy);

      const readyA = readyFor(first);
      await fairness.enqueue(readyA);
      const scheduledA = await fairness.schedule({policyVersion: 'fairness-v1', owner: 'fairness-review', leaseMs: 20_000});
      assert.equal(scheduledA.kind, 'admitted');
      const dispatchA = await dispatch(admission, readyA, scheduledA);

      // A separate current job resolves to a new, immutable rate bucket.  It is
      // deliberately still unconfirmed when A's late receipt arrives.
      const second = await seedFairnessGraph(pool);
      const rateB = await addRateBinding(pool, second, 'window-b');
      const remoteB = second.policy.buckets.find(binding => binding.handling === 'remote')?.bucketId;
      assert.ok(remoteB);
      policies.set(second.jobId, second.policy);
      const readyB = readyFor(second);
      await fairness.enqueue(readyB);
      const scheduledB = await fairness.schedule({policyVersion: 'fairness-v1', owner: 'fairness-review', leaseMs: 20_000});
      assert.equal(scheduledB.kind, 'admitted');
      const dispatchB = await dispatch(admission, readyB, scheduledB);
      assert.ok(dispatchB);

      const sessionId = randomUUID();
      const deviceId = randomUUID();
      await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
        VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`, [sessionId, first.universeId, deviceId, 'd'.repeat(64)]);
      await inTransaction(pool, async (client) => {
        await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [first.universeId]);
        await clearScrollHistory(client, {
          universeId: first.universeId, privacyEpoch: 0, sessionId, deviceId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }, {requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history'});
      });
      assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1', [first.universeId])).rows[0]?.privacy_epoch, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_attempt WHERE universe_id=$1', [first.universeId])).rows[0]?.count, 0);

      const reconciliation = createReasoningReconciliation(pool);
      const settled = await reconciliation.recordAndSettleReceipt(receipt(readyA, scheduledA, dispatchA), 'worker');
      assert.equal(settled.replayed, false);
      assert.equal(settled.revision, 1);
      assert.deepEqual((await pool.query('SELECT reserved,consumed FROM reasoning_bucket WHERE id=$1', [rateA])).rows[0], {reserved: '0', consumed: '40'});
      assert.deepEqual((await pool.query('SELECT reserved,consumed FROM reasoning_bucket WHERE id=$1', [rateB])).rows[0], {reserved: '40', consumed: '0'});
      assert.deepEqual((await pool.query('SELECT reserved,consumed FROM reasoning_bucket WHERE id=$1', [remoteB])).rows[0], {reserved: '1', consumed: '0'});
      assert.deepEqual((await pool.query(`SELECT output_authority,reconciliation_hold FROM reasoning_accounting WHERE attempt_id=$1`, [scheduledA.reserved.attemptId])).rows[0], {output_authority: 'withdrawn', reconciliation_hold: false});
      assert.deepEqual((await pool.query(`SELECT state FROM reasoning_reservation WHERE attempt_id=$1 AND bucket_id=$2`, [scheduledB.reserved.attemptId, rateB])).rows[0], {state: 'held'});
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE universe_id=$1', [first.universeId])).rows[0]?.count, 0);
    });
  });
});
