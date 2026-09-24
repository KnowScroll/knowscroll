/**
 * #132 — a worker killed during a background inquiry call (ADR-0038 §6): separate worker processes
 * against the test database. The first worker opens the due inquiry itself, commits its dispatch and
 * is killed mid-call; a replacement worker polls well past its lease. The database shows exactly one
 * attempt and one dispatch (a possibly-sent request is never repeated), and the replacement's sweep
 * closes the inquiry honestly as `outcome_unknown`, keeping the remote slot held (ADR-0012).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerFairnessPolicy } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { inquiryAuthority, installBackgroundInquiryRoute } from '../packages/db/src/reasoning-inquiries.ts';
import { formPlaces, loadInquiryFixture, type InquiryFixture } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Crash tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'inquiries-crash-v1';
const LEASE_MS = 3_000;
const children: ChildProcess[] = [];
let f: InquiryFixture;

before(async () => {
  f = await loadInquiryFixture(pool);
  await createReasoningFairness(pool, inquiryAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(client => installBackgroundInquiryRoute(client, { policyVersion: POLICY, routeId: 'fixture-crash', routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 40, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, coalescingDelaySeconds: 0, jobTtlSeconds: 60, remoteSlots: 16 }));
});
after(async () => { for (const c of children) c.kill('SIGKILL'); await app.close(); await pool.end(); });

function worker(mode: string): ChildProcess {
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/worker/src/main.ts'], {
    env: { ...process.env, KS_INQUIRY_TRANSPORT: 'fixture', KS_INQUIRY_FIXTURE_MODE: mode, KS_INQUIRY_LEASE_MS: String(LEASE_MS) }, stdio: 'ignore', detached: true,
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

test('a worker killed mid-call is never repeated by its replacement, and the inquiry fails as outcome unknown', async () => {
  const identity = await provisionIdentity();
  const headers = { authorization: `Bearer ${identity.token}` };
  const consent = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers, payload: { enabled: true, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(consent.statusCode, 200, consent.body);
  await formPlaces(identity.scope.universeId, [f.codes.gravity, f.codes.sun]);
  const dispatches = async () => (await pool.query(`SELECT count(*) FILTER (WHERE dispatch_id IS NOT NULL)::int AS sent, count(*)::int AS attempts
    FROM reasoning_accounting WHERE universe_id=$1`, [identity.scope.universeId])).rows[0] as { sent: number; attempts: number };

  const first = worker('hang');
  await until(async () => (await dispatches()).sent === 1, 30_000, 'the first worker to open the inquiry and commit its dispatch');
  kill(first);
  const replacement = worker('proposal');
  await new Promise(r => setTimeout(r, LEASE_MS * 4));
  kill(replacement);

  assert.deepEqual(await dispatches(), { sent: 1, attempts: 1 }, 'the possibly-sent request is never sent again');
  const inquiry = (await pool.query('SELECT id, status, reasons, proposal_id, job_id FROM background_inquiry WHERE universe_id=$1', [identity.scope.universeId])).rows[0];
  assert.deepEqual([inquiry.status, inquiry.reasons, inquiry.proposal_id], ['failed', ['outcome_unknown'], null], 'closed honestly, nothing invented');
  const accounting = (await pool.query(`SELECT state, output_authority FROM reasoning_accounting WHERE universe_id=$1`, [identity.scope.universeId])).rows;
  assert.deepEqual(accounting, [{ state: 'unknown', output_authority: 'withdrawn' }]);
  const remoteHeld = Number((await pool.query(`SELECT count(*) FROM reasoning_reservation rr JOIN reasoning_bucket b ON b.id = rr.bucket_id
    JOIN reasoning_attempt at ON at.id = rr.attempt_id WHERE at.job_id=$1 AND b.dimension='remote_concurrency' AND rr.state='held'`, [inquiry.job_id])).rows[0].count);
  assert.equal(remoteHeld, 1, 'an unknown outcome keeps its remote slot: it may have been spent');
  const listed = (await app.inject({ url: '/v1/inquiries', headers })).json();
  assert.deepEqual([listed.inquiries[0].status, listed.inquiries[0].reasons], ['failed', ['outcome_unknown']]);
  await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
});
