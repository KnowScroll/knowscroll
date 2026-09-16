import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {createReasoningFairness, type FairnessScheduled} from '../packages/db/src/reasoning-fairness.ts';
import type {FairnessClass} from '../packages/db/src/reasoning-fairness-policy.ts';
import {fairnessAuthority, seedFairnessGraph, sqlFairnessPolicy, withFairnessSchema} from './helpers/reasoning-fairness-fixture.ts';

// Small reviewed quanta keep sustained SQL traces bounded. Physical resources
// are deliberately ample; real reservations remain held until schema cleanup.
// These tests measure scheduling opportunity, with no transport or receipts.
const policy = {...sqlFairnessPolicy, quantum: 10, maxCharge: 10};
const classes: FairnessClass[] = ['interactive', 'active_continuity', 'accumulated_interpretation', 'background_inquiry', 'housekeeping'];
const weights = [5, 6, 4, 3, 2];
type Graph = Awaited<ReturnType<typeof seedFairnessGraph>>;
type Fairness = ReturnType<typeof createReasoningFairness>;
const schedule = (fairness: Fairness) => fairness.schedule({policyVersion: policy.version, owner: 'service-oracle', leaseMs: 60_000});

async function enqueue(fairness: Fairness, graph: Graph, klass: FairnessClass, charge: number) {
 await fairness.enqueue({policyVersion: policy.version, class: klass, universeId: graph.universeId, privacyEpoch: 0,
  jobId: graph.jobId, stepId: graph.stepId, contextId: graph.contextId, requestId: graph.requestId,
  requestHash: 'c'.repeat(64), inputTokensUpperBound: 1, maxOutputTokens: charge - 1,
  costCeilingMicroUsd: null, deadline: new Date(Date.now() + 120_000).toISOString(), permitTtlMs: 60_000});
}

/** Add distinct jobs to an existing universe. Shared/owner buckets retain the
 * seed's identity; every new job gets its own correctly scoped job budget.
 */
async function appendGraph(pool: pg.Pool, seed: Graph, klass: FairnessClass): Promise<Graph> {
 const jobId = randomUUID(), contextId = randomUUID(), stepId = randomUUID(), requestId = randomUUID(), bucketId = randomUUID();
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,0,'queued',$3,$2,'fairness-v1',clock_timestamp()+interval '1 hour','direct',$4)`, [jobId, seed.universeId, klass, randomUUID()]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
  VALUES($1,$2,$3,0,$4,'fairness-v1','source-v1')`, [contextId, jobId, seed.universeId, 'a'.repeat(64)]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
  VALUES($1,$2,$3,0,$4,1,'pending')`, [stepId, jobId, seed.universeId, contextId]);
 await pool.query("INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'job_budget','tokens',1000000)", [bucketId]);
 const buckets = seed.policy.buckets.map(bucket => bucket.dimension === 'job_budget' ? {...bucket, bucketId, scopeId: jobId} : bucket);
 return {...seed, jobId, contextId, stepId, requestId, policy: {...seed.policy, buckets}};
}

async function backlog(pool: pg.Pool, fairness: Fairness, policies: Map<string, Graph['policy']>, seed: Graph, klass: FairnessClass, charge: number, size: number) {
 for (let index = 0; index < size; index++) {
  const graph = index === 0 ? seed : await appendGraph(pool, seed, klass);
  policies.set(graph.jobId, graph.policy);
  await enqueue(fairness, graph, klass, charge);
 }
}

async function admitted(fairness: Fairness): Promise<FairnessScheduled> {
 const result = await schedule(fairness);
 assert.equal(result.kind, 'admitted', JSON.stringify(result));
 return result as FairnessScheduled;
}

test('SQL sustained unequal-cost service allocates class charge in the 5:6:4:3:2 ratio', {timeout: 120_000}, async t => {
 await withFairnessSchema('service_classes', async pool => {
  const policies = new Map<string, Graph['policy']>(), fairness = createReasoningFairness(pool, fairnessAuthority(policies));
  await fairness.installPolicy(policy);
  const costs = [5, 6, 4, 3, 2], totals = [0, 0, 0, 0, 0], visits = classes.map(() => new Set<string>());
  for (const [index, klass] of classes.entries()) {
   const seed = await seedFairnessGraph(pool, klass, 1_000_000);
   await backlog(pool, fairness, policies, seed, klass, costs[index]!, 60);
  }
  let completed = false;
  for (let selection = 0; selection < 250; selection++) {
   const result = await admitted(fairness), index = classes.indexOf(result.class);
   assert.equal(result.charge, costs[index]);
   const generation = (await pool.query('SELECT visit_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class=$2', [policy.version, result.class])).rows[0].visit_generation as string;
   if (index === 0 && !visits[0]!.has(generation) && visits[0]!.size === 4) {completed = true; break;}
   visits[index]!.add(generation); totals[index]! += result.charge;
  }
  assert.ok(completed, 'four full class traversals must complete within the selection bound');
  assert.deepEqual(visits.map(value => value.size), [4, 4, 4, 4, 4]);
  assert.deepEqual(totals, weights.map(weight => 4 * policy.quantum * weight));
  assert.ok((await pool.query('SELECT ready_count FROM reasoning_fairness_universe')).rows.every(row => BigInt(row.ready_count) > 0n), 'each class stayed backlogged');
  t.diagnostic(JSON.stringify({completedTraversals: 4, requestCosts: costs, measuredChargeByClass: totals, serviceRatio: weights}));
 });
});

test('SQL equal universe charge survives unequal request costs and backlog sizes', {timeout: 120_000}, async t => {
 await withFairnessSchema('service_universes', async pool => {
  const seeds = [await seedFairnessGraph(pool, 'interactive', 1_000_000), await seedFairnessGraph(pool, 'interactive', 1_000_000)].sort((a, b) => a.universeId.localeCompare(b.universeId));
  const policies = new Map<string, Graph['policy']>(), fairness = createReasoningFairness(pool, fairnessAuthority(policies));
  await fairness.installPolicy(policy);
  await backlog(pool, fairness, policies, seeds[0]!, 'interactive', 2, 80);
  await backlog(pool, fairness, policies, seeds[1]!, 'interactive', 10, 20);
  const visits = new Map<string, {universeId: string; charge: number; requests: number}>();
  let completed = false;
  for (let selection = 0; selection < 60; selection++) {
   const result = await admitted(fairness);
   const generation = (await pool.query("SELECT inner_generation FROM reasoning_fairness_class WHERE policy_version=$1 AND class='interactive'", [policy.version])).rows[0].inner_generation as string;
   if (!visits.has(generation) && visits.size === 12) {completed = true; break;}
   const visit = visits.get(generation) ?? {universeId: result.claim.universeId, charge: 0, requests: 0};
   assert.equal(visit.universeId, result.claim.universeId);
   visit.charge += result.charge; visit.requests++; visits.set(generation, visit);
  }
  assert.ok(completed, 'six complete inner traversals must finish within the selection bound');
  const turns = [...visits.values()];
  assert.deepEqual(turns.map(turn => turn.universeId), Array.from({length: 12}, (_, index) => seeds[index % 2]!.universeId));
  assert.ok(turns.every(turn => turn.charge === policy.quantum));
  const totals = seeds.map(seed => turns.filter(turn => turn.universeId === seed.universeId).reduce((sum, turn) => sum + turn.charge, 0));
  assert.deepEqual(totals, [60, 60]);
  assert.ok((await pool.query('SELECT ready_count FROM reasoning_fairness_universe')).rows.every(row => BigInt(row.ready_count) > 0n));
  t.diagnostic(JSON.stringify({initialBacklogs: [80, 20], requestCosts: [2, 10], measuredUniverseCharge: totals, admittedRequests: seeds.map(seed => turns.filter(turn => turn.universeId === seed.universeId).reduce((sum, turn) => sum + turn.requests, 0))}));
 });
});

test('SQL idle class return receives an opportunity before a borrower drains its queue', {timeout: 120_000}, async t => {
 await withFairnessSchema('service_returner', async pool => {
  const policies = new Map<string, Graph['policy']>(), fairness = createReasoningFairness(pool, fairnessAuthority(policies));
  await fairness.installPolicy(policy);
  const borrower = await seedFairnessGraph(pool, 'interactive', 1_000_000);
  await backlog(pool, fairness, policies, borrower, 'interactive', 2, 60);
  for (let index = 0; index < 3; index++) assert.equal((await admitted(fairness)).claim.universeId, borrower.universeId);
  const returner = await seedFairnessGraph(pool, 'housekeeping', 1_000_000);
  await backlog(pool, fairness, policies, returner, 'housekeeping', 3, 8);
  let borrowerCharge = 0, returnAt = 0;
  for (let selection = 1; selection <= 32; selection++) {
   const result = await admitted(fairness);
   if (result.claim.universeId === returner.universeId) {returnAt = selection; break;}
   assert.equal(result.claim.universeId, borrower.universeId); borrowerCharge += result.charge;
  }
  assert.ok(returnAt > 0, 'returning housekeeping must join within one capped borrower turn and class traversal');
  assert.ok(borrowerCharge <= policy.quantum * weights[0]! + policy.maxCharge);
  assert.ok(BigInt((await pool.query('SELECT ready_count FROM reasoning_fairness_universe WHERE universe_id=$1', [borrower.universeId])).rows[0].ready_count) > 0n);
  t.diagnostic(JSON.stringify({returnerAtSelection: returnAt, borrowerChargeAfterReturn: borrowerCharge, borrowerVisitSpendCap: 60}));
 });
});

test('SQL a partially spent inner turn keeps generation, credit and spend across class yield', {timeout: 120_000}, async t => {
 await withFairnessSchema('service_saved_inner', async pool => {
  const oneProbe = {...policy, maxProbes: 1}, policies = new Map<string, Graph['policy']>(), fairness = createReasoningFairness(pool, fairnessAuthority(policies));
  await fairness.installPolicy(oneProbe);
  const seeds = [await seedFairnessGraph(pool, 'interactive', 1_000_000), await seedFairnessGraph(pool, 'interactive', 1_000_000)].sort((a, b) => a.universeId.localeCompare(b.universeId));
  await backlog(pool, fairness, policies, seeds[0]!, 'interactive', 4, 30);
  await backlog(pool, fairness, policies, seeds[1]!, 'interactive', 3, 30);
  let yielded = false;
  for (let call = 0; call < 160; call++) {
   const result = await schedule(fairness);
   if (result.observations.some(event => event.reason === 'class_deficit_or_spend')) {yielded = true; break;}
  }
  assert.ok(yielded, 'unequal costs must produce a class deficit during a partially spent inner turn');
  const snapshot = async () => (await pool.query(`SELECT c.credit AS class_credit,c.remaining,c.open_universe_id,c.universe_remaining,c.visit_generation,c.inner_generation,u.credit AS universe_credit
   FROM reasoning_fairness_class c JOIN reasoning_fairness_universe u ON u.policy_version=c.policy_version AND u.class=c.class AND u.universe_id=c.open_universe_id
   WHERE c.policy_version=$1 AND c.class='interactive'`, [policy.version])).rows[0];
  const saved = await snapshot();
  assert.ok(saved); assert.equal(saved.open_universe_id, seeds[1]!.universeId);
  assert.deepEqual({classCredit: saved.class_credit, remaining: saved.remaining, universeCredit: saved.universe_credit, universeRemaining: saved.universe_remaining}, {classCredit: '1', remaining: null, universeCredit: '9', universeRemaining: '17'});
  let resumed: FairnessScheduled | undefined;
  for (let call = 0; call < 6; call++) {const result = await schedule(fairness); if (result.kind === 'admitted') {resumed = result; break;}}
  assert.ok(resumed, 'saved inner turn resumes within a complete five-class traversal');
  assert.equal(resumed.claim.universeId, seeds[1]!.universeId); assert.equal(resumed.charge, 3);
  const after = await snapshot();
  assert.equal(after.inner_generation, saved.inner_generation);
  assert.ok(BigInt(after.visit_generation) > BigInt(saved.visit_generation));
  assert.equal(after.universe_credit, '6', 'resumption spends credit without another universe quantum');
  assert.equal(after.universe_remaining, '14', 'resumption retains the previous spent allowance');
  t.diagnostic(JSON.stringify({savedInnerGeneration: saved.inner_generation, savedUniverseCredit: saved.universe_credit, savedSpendRemaining: saved.universe_remaining, resumedInnerGeneration: after.inner_generation, resumedUniverseCredit: after.universe_credit, resumedSpendRemaining: after.universe_remaining}));
 });
});
