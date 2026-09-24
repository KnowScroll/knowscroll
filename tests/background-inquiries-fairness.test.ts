/**
 * #132 — a direct Ask against a queue of background inquiries (ADR-0038 §4). The inquiry route shares
 * the answer route's scheduler, so the existing class-aware fair admission (ADR-0013) decides between
 * them: whichever loop asks, the admitted claim is run by its own family's path, and a queue of
 * background work never starves the direct Ask — it waits for at most one background visit's
 * allowance, while inquiries are still queued. Fixture transports only.
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
import { runAnswerPass } from '../apps/worker/src/reasoning/answer-worker.ts';
import { executeInquiryClaim, runInquiryPass } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureAnswerTransport } from '../apps/worker/src/providers/answer-fixture.ts';
import { createFixtureInquiryTransport } from '../apps/worker/src/providers/inquiry-fixture.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { formPlaces, gravitySunPayload, loadInquiryFixture, type InquiryFixture } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'inquiries-fairness-v1';
const answerFixture = createFixtureAnswerTransport(() => 'answer', { count: 0 });
const inquiryFixture = createFixtureInquiryTransport(() => 'none', { count: 0 });
const signal = new AbortController().signal;
let f: InquiryFixture;

before(async () => {
  f = await loadInquiryFixture(pool);
  await createReasoningFairness(pool, sharedReasoningAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(async client => {
    await installAskAnswerRoute(client, { policyVersion: POLICY, routeId: 'fixture-answers', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
      maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 100, tokenBudget: 10_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 600, remoteSlots: 16 });
    await installBackgroundInquiryRoute(client, { policyVersion: POLICY, routeId: 'fixture-inquiries', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
      maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 100, tokenBudget: 10_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000,
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
const queuedInquiries = async () => Number((await pool.query(`SELECT count(*) FROM background_inquiry WHERE status='queued' AND policy_version=$1`, [POLICY])).rows[0].count);
const inquiryPass = () => runInquiryPass({ pool, owner: 'fair-worker', leaseMs: 60_000, transports: { fixture: inquiryFixture }, signal, answers: { transports: { fixture: answerFixture } } });
const answerPass = () => runAnswerPass({ pool, owner: 'fair-worker', leaseMs: 60_000, transports: { fixture: answerFixture }, signal,
  inquiries: { transports: { fixture: inquiryFixture }, execute: executeInquiryClaim } });

test('a queue of background inquiries never starves a direct Ask on the shared scheduler', async () => {
  const readers: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const identity = await provisionIdentity();
    const consent = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(identity.token), payload: { enabled: true, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    assert.equal(consent.statusCode, 200, consent.body);
    await formPlaces(identity.scope.universeId, [f.codes.gravity, f.codes.sun]);
    readers.push(identity.token);
  }
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 7);
  assert.equal(await queuedInquiries(), 7);

  // The background lane is being served when the reader asks.
  for (let i = 0; i < 2; i += 1) assert.equal((await inquiryPass()).kind, 'done');
  const ask = await askForAnswer();
  assert.equal(await answerStatus(ask), 'queued');

  // The answer loop itself may be handed a background claim; it runs it through the inquiry path.
  const seen: string[] = [];
  let waitingWhenAdmitted = -1;
  for (let i = 0; i < 6 && (await answerStatus(ask)) === 'queued'; i += 1) {
    const before = await queuedInquiries();
    const pass = await answerPass();
    seen.push(pass.kind);
    if (pass.kind === 'done') { assert.equal(pass.askId, ask.askId); waitingWhenAdmitted = before; }
  }
  assert.equal(await answerStatus(ask), 'answered', JSON.stringify(seen));
  const background = seen.filter(kind => kind === 'other_family').length;
  assert.ok(background >= 1 && background <= 3, `at most one background visit's allowance before the Ask: ${JSON.stringify(seen)}`);
  assert.ok(waitingWhenAdmitted >= 1, 'the Ask was admitted while background inquiries were still queued');

  // And the inquiry loop, handed the next direct Ask by the shared scheduler, answers it — again
  // after at most one background visit's allowance (an emptied lane gives up its turn in the round).
  const next = await askForAnswer();
  const viaInquiryLoop: string[] = [];
  for (let i = 0; i < 6 && (await answerStatus(next)) === 'queued'; i += 1) viaInquiryLoop.push((await inquiryPass()).kind);
  assert.equal(await answerStatus(next), 'answered', JSON.stringify(viaInquiryLoop));
  assert.equal(viaInquiryLoop.at(-1), 'answer');
  assert.ok(viaInquiryLoop.filter(kind => kind === 'done').length <= 3, JSON.stringify(viaInquiryLoop));

  for (let i = 0; i < 10 && (await queuedInquiries()) > 0; i += 1) await inquiryPass();
  assert.equal(await queuedInquiries(), 0, 'the background queue drains afterwards');
  for (const token of readers) {
    await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(token), payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  }
});

test('a background inquiry gone stale at the head of the shared scheduler never breaks the answer loop', async () => {
  const identity = await provisionIdentity();
  const consent = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(identity.token), payload: { enabled: true, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(consent.statusCode, 200, consent.body);
  await formPlaces(identity.scope.universeId, [f.codes.gravity, f.codes.sun]);
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 1);
  // The reader's universe connects the pair itself while the inquiry waits in the queue.
  await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [identity.scope.universeId]);
    await submitBridgeProposal(client, { scope: { kind: 'universe', universeId: identity.scope.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${f.tag}`, payload: gravitySunPayload(f) });
  });
  const ask = await askForAnswer();
  // Stand-in for the round having reached the background lane while the Ask waits: the scheduler's
  // next probe meets the stale inquiry first.
  await pool.query(`UPDATE reasoning_fairness_scheduler SET class_cursor=$2, generation=generation+1 WHERE policy_version=$1`,
    [POLICY, FAIRNESS_CLASSES.indexOf('background_inquiry')]);
  const seen: string[] = [];
  for (let i = 0; i < 6 && (await answerStatus(ask)) === 'queued'; i += 1) {
    const pass = await answerPass();
    seen.push(pass.kind === 'idle' ? pass.reason : pass.kind);
  }
  assert.equal(await answerStatus(ask), 'answered', JSON.stringify(seen));
  // The scheduler skipped the stale head (#153); its own sweep withdraws it, never sent.
  await settleInquiries(pool, { owner: 'fair-worker' });
  const inquiry = (await pool.query('SELECT status, reasons FROM background_inquiry WHERE universe_id=$1', [identity.scope.universeId])).rows[0];
  assert.deepEqual([inquiry.status, inquiry.reasons], ['failed', ['stale_context', 'pair_connected']]);
  assert.equal(Number((await pool.query('SELECT count(*) FROM reasoning_accounting WHERE universe_id=$1', [identity.scope.universeId])).rows[0].count), 0, 'never admitted, never sent');
});

test('families of child inquiries, each able to continue, never starve a direct Ask either (ADR-0042 §4)', async () => {
  const FAMILY = 'inquiries-fairness-family-v1';
  await createReasoningFairness(pool, sharedReasoningAuthority()).installPolicy(answerFairnessPolicy(FAMILY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(async client => {
    await installAskAnswerRoute(client, { policyVersion: FAMILY, routeId: 'fixture-answers-family', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
      maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 100, tokenBudget: 10_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 600, remoteSlots: 16 });
    await installBackgroundInquiryRoute(client, { policyVersion: FAMILY, routeId: 'fixture-inquiries-family', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
      maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 100, tokenBudget: 10_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000,
      coalescingDelaySeconds: 0, jobTtlSeconds: 600, remoteSlots: 16, maxChildren: 3 });
  });
  // Each child's first proposal is refused and continued once: more background work per family.
  const continuing = createFixtureInquiryTransport(() => 'refused_then_valid', { count: 0 });
  const familyInquiryPass = () => runInquiryPass({ pool, owner: 'fair-worker', leaseMs: 60_000, transports: { fixture: continuing }, signal, answers: { transports: { fixture: answerFixture } } });
  const familyAnswerPass = () => runAnswerPass({ pool, owner: 'fair-worker', leaseMs: 60_000, transports: { fixture: answerFixture }, signal,
    inquiries: { transports: { fixture: continuing }, execute: executeInquiryClaim } });
  const readers: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const identity = await provisionIdentity();
    const consent = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(identity.token), payload: { enabled: true, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    assert.equal(consent.statusCode, 200, consent.body);
    await formPlaces(identity.scope.universeId, [f.codes.gravity, f.codes.sun, f.codes.moon]);
    readers.push(identity.token);
  }
  assert.equal((await openDueInquiries(pool, { limit: 50 })).opened, 5);
  const queuedChildren = async () => Number((await pool.query(`SELECT count(*) FROM background_inquiry WHERE status='queued' AND role='child' AND policy_version=$1`, [FAMILY])).rows[0].count);
  assert.equal(await queuedChildren(), 10, 'five families of two children');

  for (let i = 0; i < 2; i += 1) assert.equal((await familyInquiryPass()).kind, 'done');
  const ask = await askForAnswer();
  const seen: string[] = [];
  let waitingWhenAdmitted = -1;
  for (let i = 0; i < 6 && (await answerStatus(ask)) === 'queued'; i += 1) {
    const before = await queuedChildren();
    const pass = await familyAnswerPass();
    seen.push(pass.kind);
    if (pass.kind === 'done') waitingWhenAdmitted = before;
  }
  assert.equal(await answerStatus(ask), 'answered', JSON.stringify(seen));
  assert.ok(seen.filter(kind => kind === 'other_family').length <= 3, `at most one background visit's allowance before the Ask: ${JSON.stringify(seen)}`);
  assert.ok(waitingWhenAdmitted >= 1, 'the Ask was admitted while children were still queued');

  for (let i = 0; i < 60 && (await queuedChildren()) > 0; i += 1) await familyInquiryPass();
  assert.equal(await queuedChildren(), 0, 'the families drain afterwards');
  const outcomes = (await pool.query(`SELECT role, status, count(*)::int AS n FROM background_inquiry WHERE policy_version=$1 GROUP BY role, status ORDER BY role, status`, [FAMILY])).rows;
  assert.deepEqual(outcomes, [{ role: 'child', status: 'admitted', n: 10 }, { role: 'parent', status: 'settled', n: 5 }]);
  for (const token of readers) {
    await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(token), payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  }
});
