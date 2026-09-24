/**
 * #132 — a background inquiry never stays stuck (ADR-0038 §6, the ADR-0019 sweep). A worker that
 * dies after admission is recovered once its lease expires: nothing held, the inquiry failed as
 * worker_stopped, never sent. A reply that lands after the lease expired is recorded but never
 * applied: the inquiry fails as apply_failed and nothing is admitted. A queued Job past its deadline
 * expires without ever being sent. Fixture transport only.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerFairnessPolicy } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { inquiryAuthority, installBackgroundInquiryRoute, openDueInquiries } from '../packages/db/src/reasoning-inquiries.ts';
import { settleInquiries } from '../packages/db/src/reasoning-inquiry-execution.ts';
import { runInquiryPass, type InquiryTransport } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport } from '../apps/worker/src/providers/inquiry-fixture.ts';
import { formPlaces, loadInquiryFixture, type InquiryFixture } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'inquiries-recovery-v1';
const fixture = createFixtureInquiryTransport(() => 'proposal', { count: 0 });
let f: InquiryFixture;

before(async () => {
  f = await loadInquiryFixture(pool);
  await createReasoningFairness(pool, inquiryAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(client => installBackgroundInquiryRoute(client, { policyVersion: POLICY, routeId: 'fixture-recovery', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 40, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, coalescingDelaySeconds: 0, jobTtlSeconds: 600, remoteSlots: 1 }));
});
after(async () => { await app.close(); await pool.end(); });

async function queuedInquiry() {
  const identity = await provisionIdentity();
  const consent = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: { authorization: `Bearer ${identity.token}` },
    payload: { enabled: true, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(consent.statusCode, 200, consent.body);
  await formPlaces(identity.scope.universeId, [f.codes.gravity, f.codes.sun]);
  await openDueInquiries(pool, { limit: 50 });
  const row = (await pool.query(`SELECT id, job_id FROM background_inquiry WHERE universe_id=$1 AND status='queued'`, [identity.scope.universeId])).rows[0];
  assert.ok(row, 'queued');
  return { universeId: identity.scope.universeId, inquiryId: row.id as string, jobId: row.job_id as string };
}
const state = async (q: { inquiryId: string; jobId: string }) => (await pool.query(
  `SELECT i.status, i.reasons, i.proposal_id, j.status AS job_status,
     (SELECT count(*)::int FROM reasoning_reservation rr JOIN reasoning_attempt at ON at.id = rr.attempt_id WHERE at.job_id = i.job_id AND rr.state = 'held') AS held
   FROM background_inquiry i JOIN reasoning_job j ON j.id = i.job_id WHERE i.id=$1`, [q.inquiryId])).rows[0];
const sweep = () => settleInquiries(pool, { owner: 'inquiry-recovery-worker' });

test('a worker that dies after admission is recovered once its lease expires: nothing held, never sent', async () => {
  const q = await queuedInquiry();
  const admitted = await createReasoningFairness(pool, inquiryAuthority()).schedule({ owner: 'dead-worker', leaseMs: 1_000, policyVersion: POLICY });
  assert.equal(admitted.kind, 'admitted');
  assert.equal((await state(q)).job_status, 'running');
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.ok(await sweep() >= 1);
  assert.deepEqual(await state(q), { status: 'failed', reasons: ['worker_stopped'], proposal_id: null, job_status: 'cancelled', held: 0 });
  assert.equal(await sweep(), 0, 'settling is idempotent');
});

test('a reply that lands after the lease expired is recorded but never applied', async () => {
  const q = await queuedInquiry();
  // The reply is valid and its usage measured, but it arrives after this worker's 1 s lease.
  const slow: InquiryTransport = { kind: 'fixture', async send(input) {
    await new Promise(resolve => setTimeout(resolve, 1_300));
    return { ...await fixture.send(input), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null } };
  } };
  const result = await runInquiryPass({ pool, owner: 'inquiry-recovery-slow', leaseMs: 1_000, transports: { fixture: slow }, signal: new AbortController().signal });
  assert.equal(result.kind, 'done');
  if (result.kind === 'done') assert.deepEqual(result.outcome, { kind: 'discarded', reason: 'lease_lost' });
  assert.ok(await sweep() >= 1);
  const after = await state(q);
  assert.deepEqual([after.status, after.reasons, after.proposal_id, after.held], ['failed', ['apply_failed'], null, 0]);
  assert.equal(Number((await pool.query('SELECT count(*) FROM semantic_proposal WHERE universe_id=$1', [q.universeId])).rows[0].count), 0, 'nothing admitted');
});

test('a queued inquiry past its deadline expires without ever being sent', async () => {
  const q = await queuedInquiry();
  // Stand-in for thirty idle seconds: the Job's own deadline passes while it waits.
  await pool.query(`UPDATE reasoning_job SET deadline = clock_timestamp() - interval '1 second' WHERE id=$1`, [q.jobId]);
  assert.ok(await sweep() >= 1);
  const after = await state(q);
  assert.deepEqual([after.status, after.reasons, after.job_status, after.held], ['failed', ['expired'], 'expired', 0]);
  assert.equal(Number((await pool.query('SELECT count(*) FROM reasoning_attempt WHERE job_id=$1', [q.jobId])).rows[0].count), 0);
});
