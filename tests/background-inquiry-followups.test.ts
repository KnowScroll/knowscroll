/**
 * #166 — the #153 follow-ups (ADR-0042 §6), each a test that failed before its fix, over the real app,
 * the real reasoning primitives and the worker passes with labelled fixture transports:
 *  1. a queued inquiry gone stale at the scheduler's head never stalls it, even behind more than a
 *     sweep's worth of valid queued inquiries with earlier deadlines;
 *  2. an answers-only worker never schedules a scheduler it shares with inquiries, and a worker that
 *     can run both asks the inquiry transport's quota before scheduling;
 *  4. consent applies only its newest recorded request;
 *  5. a pair counts as asked only if its request was sent.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerFairnessPolicy, installAskAnswerRoute } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { FAIRNESS_CLASSES } from '../packages/db/src/reasoning-fairness-policy.ts';
import { installBackgroundInquiryRoute, openDueInquiries, sharedReasoningAuthority } from '../packages/db/src/reasoning-inquiries.ts';
import { settleInquiries } from '../packages/db/src/reasoning-inquiry-execution.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { runAnswerPass } from '../apps/worker/src/reasoning/answer-worker.ts';
import { executeInquiryClaim, runInquiryPass, type InquiryTransport } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureAnswerTransport } from '../apps/worker/src/providers/answer-fixture.ts';
import { createFixtureInquiryTransport } from '../apps/worker/src/providers/inquiry-fixture.ts';
import { consentingReader, formPlaces, gravitySunPayload, loadInquiryFixture, newestInquiry, type InquiryFixture } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'followups-shared-v1';
const answerFixture = createFixtureAnswerTransport(() => 'answer', { count: 0 });
const inquiryFixture = createFixtureInquiryTransport(() => 'none', { count: 0 });
const signal = new AbortController().signal;
let f: InquiryFixture;

before(async () => {
  f = await loadInquiryFixture(pool);
  await createReasoningFairness(pool, sharedReasoningAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(async client => {
    await installAskAnswerRoute(client, { policyVersion: POLICY, routeId: 'fixture-answers', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
      maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 200, tokenBudget: 10_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 600, remoteSlots: 16 });
    await installBackgroundInquiryRoute(client, { policyVersion: POLICY, routeId: 'fixture-inquiries', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
      maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 200, tokenBudget: 10_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000,
      coalescingDelaySeconds: 0, jobTtlSeconds: 600, remoteSlots: 16 });
  });
});
after(async () => { await app.close(); await pool.end(); });

const headers = (token: string) => ({ authorization: `Bearer ${token}` });
async function askForAnswer(): Promise<{ token: string; askId: string }> {
  const identity = await provisionIdentity();
  const feed = (await app.inject({ url: '/v1/feed?kinds=Scroll', headers: headers(identity.token) })).json();
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(identity.token), payload: { decisionId: feed.decisionId, assetId: feed.items[0].assetId, clientExposureId: randomUUID() } });
  const asked = await app.inject({ method: 'POST', url: '/v1/asks', headers: headers(identity.token),
    payload: { clientAskId: randomUUID(), exposureId: exposure.json().exposureId, expectedPrivacyEpoch: 0, question: 'Why does this happen?' } });
  const requested = await app.inject({ method: 'POST', url: `/v1/asks/${asked.json().askId}/answer`, headers: headers(identity.token), payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(requested.statusCode, 202, requested.body);
  return { token: identity.token, askId: asked.json().askId };
}
const answerStatus = async (a: { token: string; askId: string }) => (await app.inject({ url: `/v1/asks/${a.askId}/answer`, headers: headers(a.token) })).json().status as string;
const execute = executeInquiryClaim;
/** The scheduler's next probe starts at the background lane, at this universe's queued inquiry. */
const headAt = (universeId: string) => transaction(async client => {
  await client.query(`UPDATE reasoning_fairness_class SET open_universe_id=$2, universe_remaining=1000000 WHERE policy_version=$1 AND class='background_inquiry'`, [POLICY, universeId]);
  await client.query(`UPDATE reasoning_fairness_scheduler SET class_cursor=$2, generation=generation+1 WHERE policy_version=$1`, [POLICY, FAIRNESS_CLASSES.indexOf('background_inquiry')]);
});
/** Leaves nothing of an earlier test queued on the shared scheduler. */
async function quiesce() {
  for (let i = 0; i < 40 && (await pool.query(`SELECT 1 FROM background_inquiry WHERE status IN ('pending','queued')`)).rowCount; i += 1) {
    await runInquiryPass({ pool, owner: 'followups-worker', leaseMs: 60_000, transports: { fixture: inquiryFixture }, signal, answers: { transports: { fixture: answerFixture } } });
    await settleInquiries(pool, { owner: 'followups-worker' });
  }
}

test('#153.1: a stale inquiry at the scheduler\'s head never stalls it, even behind a sweep\'s worth of valid ones with earlier deadlines', async () => {
  await quiesce();
  const readers = [];
  for (let i = 0; i < 11; i += 1) {
    const r = await consentingReader(app);
    await formPlaces(r.universeId, [f.codes.gravity, f.codes.sun]);
    readers.push(r);
  }
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 11);
  // The last to open, so the latest deadline: the sweep's first ten never reach it.
  const stale = await consentingReader(app);
  await formPlaces(stale.universeId, [f.codes.gravity, f.codes.sun]);
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 1);
  await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [stale.universeId]);
    await submitBridgeProposal(client, { scope: { kind: 'universe', universeId: stale.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${f.tag}`, payload: gravitySunPayload(f) });
  });
  const ask = await askForAnswer();
  await headAt(stale.universeId);
  const seen: string[] = [];
  for (let i = 0; i < 8 && (await answerStatus(ask)) === 'queued'; i += 1) {
    const pass = await runAnswerPass({ pool, owner: 'followups-worker', leaseMs: 60_000, transports: { fixture: answerFixture }, signal,
      inquiries: { transports: { fixture: inquiryFixture }, execute } });
    seen.push(pass.kind === 'idle' ? pass.reason : pass.kind);
  }
  assert.equal(await answerStatus(ask), 'answered', JSON.stringify(seen));
  assert.equal((await newestInquiry(stale.universeId)).dispatched, 0, 'the stale inquiry was never sent');
  // Its sweep withdraws it in time, never sent.
  for (let i = 0; i < 4 && (await newestInquiry(stale.universeId)).status === 'queued'; i += 1) await settleInquiries(pool, { owner: 'followups-worker', limit: 50 });
  assert.deepEqual((await newestInquiry(stale.universeId)).reasons, ['stale_context', 'pair_connected']);
  for (const r of [...readers, stale]) await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
});

test('#153.2: an answers-only worker never schedules a scheduler it shares with inquiries; with both, the inquiry quota is asked first', async () => {
  await quiesce();
  const r = await consentingReader(app);
  await formPlaces(r.universeId, [f.codes.gravity, f.codes.sun]);
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 1);
  const ask = await askForAnswer();
  await headAt(r.universeId);

  const answersOnly = await runAnswerPass({ pool, owner: 'followups-worker', leaseMs: 60_000, transports: { fixture: answerFixture }, signal });
  assert.deepEqual(answersOnly, { kind: 'idle', reason: 'shared_scheduler_needs_inquiry_transport' });
  let quotaChecks = 0;
  const overQuota: InquiryTransport = { ...inquiryFixture, async ready() { quotaChecks += 1; return { ok: false, reason: 'provider_quota_preflight_failed' }; } };
  const refused = await runAnswerPass({ pool, owner: 'followups-worker', leaseMs: 60_000, transports: { fixture: answerFixture }, signal,
    inquiries: { transports: { fixture: overQuota }, execute } });
  assert.deepEqual([refused, quotaChecks], [{ kind: 'idle', reason: 'provider_quota_preflight_failed' }, 1]);
  const inquiry = await newestInquiry(r.universeId);
  assert.deepEqual([inquiry.status, inquiry.job_status, inquiry.dispatched], ['queued', 'queued', 0], 'nothing was admitted, given back or sent');
  assert.equal(await answerStatus(ask), 'queued');
  await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
});

test('#153.4: consent applies only its newest recorded request, never an older one again', async () => {
  const r = await consentingReader(app);
  const on = (await pool.query('SELECT request_id FROM background_inquiry_consent WHERE universe_id=$1', [r.universeId])).rows[0].request_id;
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } })).statusCode, 200);
  await assert.rejects(pool.query('UPDATE background_inquiry_consent SET enabled=true, request_id=$2, revision=revision+1 WHERE universe_id=$1', [r.universeId, on]),
    /only its newest request/);
});

test('#153.5: a pair counts as asked only if its request was sent', async () => {
  await quiesce();
  const r = await consentingReader(app);
  await formPlaces(r.universeId, [f.codes.gravity, f.codes.sun]);
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 1);
  // Paused before anything was sent: withdrawn, and the database records it was never sent.
  await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  const withdrawn = await newestInquiry(r.universeId);
  assert.deepEqual([withdrawn.status, withdrawn.sent], ['withdrawn', false]);
  await app.inject({ method: 'POST', url: '/v1/privacy/resume', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  // A new place asks for a look again: the pair that was never sent is offered again.
  await formPlaces(r.universeId, [f.codes.moon], [f.codes.gravity, f.codes.sun]);
  await openDueInquiries(pool, { limit: 50 });
  const again = await newestInquiry(r.universeId);
  const codes = (again.pairs as { a: { code: string }; b: { code: string } }[]).map(p => `${p.a.code}~${p.b.code}`);
  assert.ok(codes.includes(`${f.codes.gravity}~${f.codes.sun}`), JSON.stringify(codes));
  // Sent, it counts: once this one closes, a later look does not offer its pairs again.
  for (let i = 0; i < 12 && (await newestInquiry(r.universeId)).status === 'queued'; i += 1) {
    await runInquiryPass({ pool, owner: 'followups-worker', leaseMs: 60_000, transports: { fixture: inquiryFixture }, signal, answers: { transports: { fixture: answerFixture } } });
  }
  const answered = await newestInquiry(r.universeId);
  assert.deepEqual([answered.status, answered.sent], ['none', true]);
  await formPlaces(r.universeId, [f.codes.body], [f.codes.gravity, f.codes.sun, f.codes.moon]);
  await openDueInquiries(pool, { limit: 50 });
  assert.equal((await newestInquiry(r.universeId)).status, 'nothing_to_ask');
});
