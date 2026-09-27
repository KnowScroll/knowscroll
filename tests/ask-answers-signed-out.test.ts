/**
 * #132 verification review — the recovery sweep and a reader who has signed out. ADR-0018 lets a
 * leaseless direct Job be withdrawn as `cancelled` only while its original session is live, and as
 * `expired` by anyone once its deadline has passed. A signed-out reader's abandoned answer must
 * therefore wait for its deadline without breaking the sweep for everyone else, then close
 * honestly. Fixture transport; a 30 s route (the shortest allowed).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerAuthority, answerFairnessPolicy, installAskAnswerRoute, settleAbandonedAnswers } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Ask answer tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'answers-signed-out-v1';
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  await createReasoningFairness(pool, answerAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
  await transaction(client => installAskAnswerRoute(client, { policyVersion: POLICY, routeId: 'fixture-route', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 40, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: 30, remoteSlots: 4 }));
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
const answerOf = async (a: Asked) => (await pool.query('SELECT status, reasons FROM ask_answer WHERE ask_id=$1', [a.askId])).rows[0] ?? null;
const jobStatus = async (a: Asked) => (await pool.query('SELECT j.status FROM ask_answer_request r JOIN reasoning_job j ON j.id = r.job_id WHERE r.ask_id=$1', [a.askId])).rows[0].status;

test('a signed-out reader\'s abandoned answer waits for its deadline without stopping the sweep, then closes honestly', async () => {
  const signedOut = await askAndRequest();
  const stillHere = await askAndRequest();
  const fairness = createReasoningFairness(pool, answerAuthority());
  for (let i = 0; i < 2; i += 1) assert.equal((await fairness.schedule({ owner: 'dead-worker', leaseMs: 1_000, policyVersion: POLICY })).kind, 'admitted');
  const revoked = await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: headers(signedOut.token), payload: {} });
  assert.equal(revoked.statusCode, 204, revoked.body);

  await new Promise(resolve => setTimeout(resolve, 1_200));
  await settleAbandonedAnswers(pool, { owner: 'sweep' }); // must not throw
  assert.deepEqual(await answerOf(stillHere), { status: 'failed', reasons: ['worker_stopped'] }, 'the live reader\'s answer is closed at once');
  assert.equal(await answerOf(signedOut), null, 'a signed-out reader\'s Job cannot be cancelled before its deadline');
  assert.equal(await jobStatus(signedOut), 'waiting');

  await new Promise(resolve => setTimeout(resolve, 30_500));
  await settleAbandonedAnswers(pool, { owner: 'sweep' });
  assert.equal(await jobStatus(signedOut), 'expired');
  assert.deepEqual(await answerOf(signedOut), { status: 'failed', reasons: ['worker_stopped'] });
});
