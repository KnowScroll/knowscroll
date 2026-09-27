/**
 * #132 — a worker killed during an answer call (ADR-0033 §3): separate worker processes against the
 * test database. The first worker commits its dispatch and is killed mid-call; a replacement worker
 * runs; the database shows exactly one attempt and one dispatch (a possibly-sent request is never
 * repeated). The replacement's recovery sweep closes the abandoned call honestly: the answer fails as
 * `outcome_unknown`, the accounting stays `unknown` and its remote slot stays held (it may have been
 * spent, ADR-0012), and no answer text is ever invented.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerAuthority, answerFairnessPolicy, installAskAnswerRoute } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Crash tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'answers-crash-v1';
const TTL = 30;
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const children: ChildProcess[] = [];

before(async () => {
  await createReasoningFairness(pool, answerAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 1024 }));
  await transaction(client => installAskAnswerRoute(client, { policyVersion: POLICY, routeId: 'fixture-crash', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 1024, requestCap: 40, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, answerTtlSeconds: TTL, remoteSlots: 16 }));
});
after(async () => { for (const c of children) c.kill('SIGKILL'); await app.close(); await pool.end(); });

const LEASE_MS = 3_000;
function worker(mode: string): ChildProcess {
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/worker/src/main.ts'], {
    env: { ...process.env, KS_ANSWER_TRANSPORT: 'fixture', KS_ANSWER_FIXTURE_MODE: mode, KS_ANSWER_LEASE_MS: String(LEASE_MS) }, stdio: 'ignore', detached: true,
  });
  children.push(child);
  return child;
}
const kill = (child: ChildProcess) => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
async function until(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what}`);
}

test('a worker killed mid-call is never repeated by its replacement, and the answer fails as outcome unknown', async () => {
  const identity = await provisionIdentity();
  const feed = (await app.inject({ url: '/v1/feed?kinds=Scroll', headers: headers(identity.token) })).json() as { decisionId: string; items: { assetId: string }[] };
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers: headers(identity.token), payload: { decisionId: feed.decisionId, assetId: feed.items[0]!.assetId, clientExposureId: randomUUID() } });
  const asked = await app.inject({ method: 'POST', url: '/v1/asks', headers: headers(identity.token), payload: { clientAskId: randomUUID(), exposureId: exposure.json().exposureId, expectedPrivacyEpoch: 0, question: 'What happens next?' } });
  const askId = asked.json().askId as string;
  const requested = await app.inject({ method: 'POST', url: `/v1/asks/${askId}/answer`, headers: headers(identity.token), payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(requested.statusCode, 202, requested.body);
  const jobId = requested.json().jobId as string;
  const dispatches = async () => (await pool.query(`SELECT count(*) FILTER (WHERE ac.dispatch_id IS NOT NULL)::int AS sent, count(*)::int AS attempts
    FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.job_id=$1`, [jobId])).rows[0] as { sent: number; attempts: number };

  const first = worker('hang');
  await until(async () => (await dispatches()).sent === 1, 30_000, 'the first worker to commit its dispatch');
  kill(first);
  // The replacement keeps polling well past the killed worker's lease, so it could take the Job over.
  const replacement = worker('answer');
  await new Promise(r => setTimeout(r, LEASE_MS * 4));
  kill(replacement);
  assert.deepEqual(await dispatches(), { sent: 1, attempts: 1 }, 'the possibly-sent request is never sent again');
  const answer = (await pool.query('SELECT status, answer, basis, reasons FROM ask_answer WHERE ask_id=$1', [askId])).rows[0];
  assert.deepEqual(answer, { status: 'failed', answer: null, basis: [], reasons: ['outcome_unknown'] }, 'closed honestly, nothing invented');
  const accounting = (await pool.query(`SELECT ac.state, ac.output_authority FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.job_id=$1`, [jobId])).rows;
  assert.deepEqual(accounting, [{ state: 'unknown', output_authority: 'withdrawn' }]);
  const remoteHeld = Number((await pool.query(`SELECT count(*) FROM reasoning_reservation rr JOIN reasoning_bucket b ON b.id = rr.bucket_id
    JOIN reasoning_attempt at ON at.id = rr.attempt_id WHERE at.job_id=$1 AND b.dimension='remote_concurrency' AND rr.state='held'`, [jobId])).rows[0].count);
  assert.equal(remoteHeld, 1, 'an unknown outcome keeps its remote slot: it may have been spent');
  const view = (await app.inject({ url: `/v1/asks/${askId}/answer`, headers: headers(identity.token) })).json();
  assert.deepEqual([view.status, view.reasons], ['failed', ['outcome_unknown']]);
});
