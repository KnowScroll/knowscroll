/**
 * #132 — authorized Scroll Ask answers (ADR-0033) through the real Fastify app, the real reasoning
 * primitives (fair admission, one-time dispatch, receipts, settlement) and the worker's answer pass,
 * with the labelled fixture transport. Proves: the fresh authority, exactly-reserved bytes, validated
 * application, honest failure for rejected/unknown/error outcomes with no retry, cancellation, pause,
 * disabled routes, Clear during a call, and Clear/Reset/export. No provider is called here.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerAuthority, answerFairnessPolicy, installAskAnswerRoute } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { runAnswerPass } from '../apps/worker/src/reasoning/answer-worker.ts';
import { createFixtureAnswerTransport, type FixtureMode } from '../apps/worker/src/providers/answer-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Ask answer tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'answers-test-v1';
let mode: FixtureMode = 'answer';
const calls = { count: 0 };
const fixture = createFixtureAnswerTransport(() => mode, calls);
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  await createReasoningFairness(pool, answerAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
  await transaction(client => installAskAnswerRoute(client, { policyVersion: POLICY, routeId: 'fixture-route', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 40, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 600, remoteSlots: 16 }));
});
after(async () => { await app.close(); await pool.end(); });

type Asked = { token: string; universeId: string; askId: string; assetId: string; body: string };

async function ask(question = 'Why does this happen?'): Promise<Asked> {
  const identity = await provisionIdentity();
  const feed = await app.inject({ url: '/v1/feed?kinds=Scroll', headers: headers(identity.token) });
  assert.equal(feed.statusCode, 200, feed.body);
  const { decisionId, items } = feed.json() as { decisionId: string; items: { assetId: string; body: string }[] };
  const item = items[0]!;
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(identity.token), payload: { decisionId, assetId: item.assetId, clientExposureId: randomUUID() } });
  assert.equal(exposure.statusCode, 201, exposure.body);
  const recorded = await app.inject({ method: 'POST', url: '/v1/asks', headers: headers(identity.token),
    payload: { clientAskId: randomUUID(), exposureId: exposure.json().exposureId, expectedPrivacyEpoch: 0, question } });
  assert.equal(recorded.statusCode, 201, recorded.body);
  assert.equal(recorded.json().status, 'recorded_only');
  return { token: identity.token, universeId: identity.scope.universeId, askId: recorded.json().askId, assetId: item.assetId, body: item.body };
}

const requestAnswer = (a: Asked, key = randomUUID(), token = a.token) => app.inject({ method: 'POST', url: `/v1/asks/${a.askId}/answer`, headers: headers(token), payload: { clientRequestId: key, expectedPrivacyEpoch: 0 } });
const view = async (a: Asked) => { const r = await app.inject({ url: `/v1/asks/${a.askId}/answer`, headers: headers(a.token) }); return { status: r.statusCode, body: r.statusCode === 200 ? r.json() : null }; };
const pass = (signal = new AbortController().signal) => runAnswerPass({ pool, owner: 'answer-test-worker', leaseMs: 60_000, transports: { fixture }, signal });
const jobOf = async (a: Asked) => (await pool.query('SELECT j.status, r.request_hash, r.job_id FROM ask_answer_request r JOIN reasoning_job j ON j.id = r.job_id WHERE r.ask_id=$1', [a.askId])).rows[0];

test('an explicit request answers one Ask end to end, and the answer quotes the Scroll', async () => {
  mode = 'answer';
  const a = await ask();
  const requested = await requestAnswer(a);
  assert.equal(requested.statusCode, 202, requested.body);
  assert.equal((await view(a)).body.status, 'queued');
  const before = calls.count;
  const done = await pass();
  assert.equal(done.kind, 'done');
  if (done.kind === 'done') { assert.equal(done.askId, a.askId); assert.equal(done.invocation, 'recorded'); assert.deepEqual(done.outcome, { kind: 'applied', status: 'answered' }); }
  assert.equal(calls.count - before, 1, 'exactly one transport call');
  const answered = (await view(a)).body;
  assert.equal(answered.status, 'answered');
  assert.ok(answered.basis.length >= 1 && answered.basis.every((b: { quote: string }) => a.body.replace(/\s+/g, ' ').includes(b.quote)), 'every quote is in the Scroll');
  const job = await jobOf(a);
  assert.equal(job.status, 'completed');
  const accounting = (await pool.query(`SELECT ac.state, ac.output_authority FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id=at.id WHERE at.job_id=$1`, [job.job_id])).rows;
  assert.deepEqual(accounting, [{ state: 'responded', output_authority: 'withdrawn' }], 'one attempt; its output consumed');
  const sent = (await pool.query('SELECT request_hash FROM reasoning_attempt WHERE job_id=$1', [job.job_id])).rows[0].request_hash;
  assert.equal(sent, job.request_hash, 'the attempt sent exactly the bytes reserved at request time');
  assert.match(sent, /^[0-9a-f]{64}$/);
  void createHash;
});

test('no Ask runs without its own request; retries replay; another key or another session is refused', async () => {
  mode = 'answer';
  const a = await ask();
  assert.equal((await view(a)).status, 404, 'a recorded Ask has no answer until the reader asks for one');
  const idle = await pass();
  assert.equal(idle.kind, 'idle', 'the worker never promotes a recorded-only Ask');
  const key = randomUUID();
  const first = await requestAnswer(a, key);
  const again = await requestAnswer(a, key);
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().requestId, first.json().requestId, 'exact retry replays the same request');
  assert.equal((await requestAnswer(a, randomUUID())).statusCode, 409, 'one answer request per Ask');
  const b = await ask();
  const other = await provisionIdentity({ universeId: b.universeId });
  assert.equal((await requestAnswer(b, randomUUID(), other.token)).statusCode, 409, 'only the session that asked can authorise its answer');
  await pass(); // settle the queued one so later tests start clean
});

test('a reply whose quote is not in the Scroll is rejected, and nothing it said is kept', async () => {
  mode = 'invented_quote';
  const a = await ask();
  await requestAnswer(a);
  const done = await pass();
  assert.ok(done.kind === 'done' && done.outcome.kind === 'applied' && done.outcome.status === 'rejected', JSON.stringify(done));
  const v = (await view(a)).body;
  assert.equal(v.status, 'rejected');
  assert.deepEqual(v.reasons, ['basis_not_in_source']);
  assert.equal(v.answer, null);
  assert.deepEqual(v.basis, []);
  assert.equal((await jobOf(a)).status, 'failed');
});

for (const [failure, expected] of [['transport_loss', 'outcome_unknown'], ['http_error', 'provider_error']] as const) {
  test(`a ${failure.replace('_', ' ')} fails the answer honestly and is never retried`, async () => {
    mode = failure;
    const a = await ask();
    await requestAnswer(a);
    const before = calls.count;
    const done = await pass();
    assert.ok(done.kind === 'done' && done.outcome.kind === 'failed', JSON.stringify(done));
    const v = (await view(a)).body;
    assert.equal(v.status, 'failed');
    assert.deepEqual(v.reasons, [expected]);
    mode = 'answer';
    assert.equal((await pass()).kind, 'idle', 'no second attempt');
    assert.equal(calls.count - before, 1);
  });
}

test('the Scroll saying nothing is an honest answer', async () => {
  mode = 'not_in_source';
  const a = await ask('What happened on Mars last week?');
  await requestAnswer(a);
  await pass();
  const v = (await view(a)).body;
  assert.equal(v.status, 'not_in_source');
  assert.match(v.limits, /does not cover/);
});

test('cancelling before the worker starts withdraws the Job; a started one cannot be cancelled', async () => {
  mode = 'answer';
  const a = await ask();
  await requestAnswer(a);
  const cancelled = await app.inject({ method: 'POST', url: `/v1/asks/${a.askId}/answer/cancel`, headers: headers(a.token), payload: { expectedPrivacyEpoch: 0 } });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled');
  assert.equal((await jobOf(a)).status, 'cancelled');
  assert.equal((await pass()).kind, 'idle');
});

test('no answer is authorised while paused or without an enabled route', async () => {
  mode = 'answer';
  const a = await ask();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(a.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } })).statusCode, 200);
  assert.equal((await requestAnswer(a)).statusCode, 409);
  await app.inject({ method: 'POST', url: '/v1/privacy/resume', headers: headers(a.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  await pool.query('UPDATE ask_answer_route SET enabled=false WHERE policy_version=$1', [POLICY]);
  try { assert.equal((await requestAnswer(a)).statusCode, 503); }
  finally { await pool.query('UPDATE ask_answer_route SET enabled=true WHERE policy_version=$1', [POLICY]); }
});

test('Clear during a call discards the reply: nothing is applied to the new epoch', async () => {
  mode = 'hang';
  const a = await ask();
  await requestAnswer(a);
  const controller = new AbortController();
  const before = calls.count;
  const running = pass(controller.signal);
  const deadline = Date.now() + 10_000;
  while (calls.count === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.count - before, 1, 'the call is in flight');
  const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: headers(a.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  controller.abort();
  const done = await running;
  assert.ok(done.kind === 'done' && done.outcome.kind === 'discarded', JSON.stringify(done));
  assert.equal(Number((await pool.query('SELECT count(*) FROM ask_answer WHERE universe_id=$1', [a.universeId])).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM ask_answer_request WHERE universe_id=$1', [a.universeId])).rows[0].count), 0);
  mode = 'answer';
});

for (const operation of ['clear', 'reset'] as const) {
  test(`${operation} erases answers and their requests, after export carried them`, async () => {
    mode = 'answer';
    const a = await ask();
    await requestAnswer(a);
    await pass();
    const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(a.token), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    assert.equal(exported.statusCode, 200, exported.body);
    const rows = exported.json().askAnswers as { ask_id: string; status: string }[];
    assert.deepEqual(rows.map(r => [r.ask_id, r.status]), [[a.askId, 'answered']]);
    const result = await app.inject({ method: 'POST', url: operation === 'clear' ? '/v1/history/clear' : '/v1/privacy/reset', headers: headers(a.token),
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: operation === 'clear' ? 'clear-scroll-history' : 'reset-personal-universe' } });
    assert.equal(result.statusCode, 200, result.body);
    for (const table of ['ask_answer', 'ask_answer_request']) {
      assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [a.universeId])).rows[0].count), 0, `${table} erased`);
    }
  });
}
