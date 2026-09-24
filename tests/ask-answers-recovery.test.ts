/**
 * #132 review B2 — an answer attempt that was admitted but never sent must never stay stuck. With a
 * single remote slot (the live and journey setting), a worker that stops before dispatch gives the
 * attempt back at once, and a worker that dies after admission is closed by the recovery sweep once
 * its lease expires: the reservations are released, the answer fails honestly as not sent, and the
 * next Ask proceeds. Fixture transport only.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerAuthority, answerFairnessPolicy, installAskAnswerRoute, settleAbandonedAnswers } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { runAnswerPass } from '../apps/worker/src/reasoning/answer-worker.ts';
import { createFixtureAnswerTransport } from '../apps/worker/src/providers/answer-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Ask answer tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'answers-recovery-v1';
const fixture = createFixtureAnswerTransport(() => 'answer', { count: 0 });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  await createReasoningFairness(pool, answerAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
  await transaction(client => installAskAnswerRoute(client, { policyVersion: POLICY, routeId: 'fixture-route', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 40, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 600, remoteSlots: 1 }));
});
after(async () => { await app.close(); await pool.end(); });

type Asked = { token: string; askId: string };
async function askAndRequest(): Promise<Asked> {
  const identity = await provisionIdentity();
  const feed = (await app.inject({ url: '/v1/feed?kinds=Scroll', headers: headers(identity.token) })).json();
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(identity.token), payload: { decisionId: feed.decisionId, assetId: feed.items[0].assetId, clientExposureId: randomUUID() } });
  const recorded = await app.inject({ method: 'POST', url: '/v1/asks', headers: headers(identity.token),
    payload: { clientAskId: randomUUID(), exposureId: exposure.json().exposureId, expectedPrivacyEpoch: 0, question: 'Why does this happen?' } });
  const requested = await app.inject({ method: 'POST', url: `/v1/asks/${recorded.json().askId}/answer`, headers: headers(identity.token), payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(requested.statusCode, 202, requested.body);
  return { token: identity.token, askId: recorded.json().askId };
}
const view = async (a: Asked) => (await app.inject({ url: `/v1/asks/${a.askId}/answer`, headers: headers(a.token) })).json();
const pass = (signal = new AbortController().signal) => runAnswerPass({ pool, owner: 'answer-recovery-worker', leaseMs: 60_000, transports: { fixture }, signal });
const heldFor = async (a: Asked) => Number((await pool.query(
  `SELECT count(*) FROM reasoning_reservation rr JOIN reasoning_attempt at ON at.id = rr.attempt_id JOIN ask_answer_request r ON r.job_id = at.job_id
   WHERE r.ask_id = $1 AND rr.state = 'held'`, [a.askId])).rows[0].count);
const jobStatus = async (a: Asked) => (await pool.query('SELECT j.status FROM ask_answer_request r JOIN reasoning_job j ON j.id = r.job_id WHERE r.ask_id=$1', [a.askId])).rows[0].status;

test('a worker that stops before dispatch gives the attempt back: nothing held, failed as not sent, the next Ask proceeds', async () => {
  const first = await askAndRequest();
  const stopping = new AbortController();
  stopping.abort();
  const result = await pass(stopping.signal);
  assert.equal(result.kind, 'done');
  if (result.kind === 'done') { assert.equal(result.invocation, 'not_invoked'); assert.deepEqual(result.outcome, { kind: 'failed', status: 'failed' }); }
  const seen = await view(first);
  assert.deepEqual([seen.status, seen.reasons], ['failed', ['not_sent']]);
  assert.equal(await heldFor(first), 0, 'every reservation released');
  assert.equal(await jobStatus(first), 'cancelled');

  const second = await askAndRequest();
  const next = await pass();
  assert.equal(next.kind === 'done' && next.outcome.kind, 'applied', JSON.stringify(next));
  assert.equal((await view(second)).status, 'answered');
});

test('a worker that dies after admission is closed by the sweep once its lease expires; the next Ask then proceeds', async () => {
  const first = await askAndRequest();
  const admitted = await createReasoningFairness(pool, answerAuthority()).schedule({ owner: 'dead-worker', leaseMs: 1_000, policyVersion: POLICY });
  assert.equal(admitted.kind, 'admitted');
  const second = await askAndRequest();
  const blocked = await pass();
  assert.equal(blocked.kind, 'idle', 'the only remote slot is held by the dead worker\'s attempt');
  assert.equal((await view(first)).status, 'running');

  await new Promise(resolve => setTimeout(resolve, 1_200));
  const settled = await settleAbandonedAnswers(pool, { owner: 'answer-recovery-worker' });
  assert.ok(settled >= 1, `settled ${settled}`);
  const seen = await view(first);
  assert.deepEqual([seen.status, seen.reasons], ['failed', ['worker_stopped']]);
  assert.equal(await heldFor(first), 0, 'the never-sent attempt released everything it held');
  assert.equal(await jobStatus(first), 'cancelled');
  assert.equal(await settleAbandonedAnswers(pool, { owner: 'answer-recovery-worker' }), 0, 'settling is idempotent');

  const next = await pass();
  assert.equal(next.kind === 'done' && next.outcome.kind, 'applied', JSON.stringify(next));
  assert.equal((await view(second)).status, 'answered');
});
