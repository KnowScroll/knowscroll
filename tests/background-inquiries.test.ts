/**
 * #132 — background bridge inquiries (ADR-0038) through the real Fastify app, the real Cartographer,
 * the real reasoning primitives (fair admission, one-time dispatch, receipts, settlement, withdrawal),
 * the real bridge validator and the worker's inquiry pass, with the labelled fixture transport.
 * Proves: consent is the authority (and never backfills), coalescing and its delay, the daily limit,
 * nothing_to_ask without a Job, an admitted bridge end to end, validator and shape rejections,
 * honest failures without retry, withdrawal before and during a call, stale contexts discarded and
 * never re-sent, Clear/Reset erasure after export, and the schema's own guards. No provider is called.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { inquiriesResponse, inquiryConsentResponse } from '../packages/contracts/src/inquiries.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { answerFairnessPolicy } from '../packages/db/src/reasoning-answers.ts';
import { createReasoningFairness } from '../packages/db/src/reasoning-fairness.ts';
import { inquiryAuthority, installBackgroundInquiryRoute, openDueInquiries, openInquiry, resolveInquiryPolicy } from '../packages/db/src/reasoning-inquiries.ts';
import { settleInquiries } from '../packages/db/src/reasoning-inquiry-execution.ts';
import { validateInquiryContext } from '../packages/db/src/reasoning-inquiry-context.ts';
import { correctSourceSnapshot } from '../packages/db/src/semantic/corrections.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { executeInquiryClaim, runInquiryPass, type InquiryTransport } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport, type InquiryFixtureMode } from '../apps/worker/src/providers/inquiry-fixture.ts';
import { formPlaces, gravitySunPayload, loadInquiryFixture, type InquiryFixture } from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const POLICY = 'inquiries-test-v1';
const DELAYED = 'inquiries-test-delay-v1';
const SHORT = 'inquiries-test-short-ttl-v1';
let mode: InquiryFixtureMode = 'proposal';
const calls = { count: 0 };
const fixture = createFixtureInquiryTransport(() => mode, calls);
let f: InquiryFixture;

async function installRoute(policyVersion: string, coalescingDelaySeconds: number, jobTtlSeconds = 600) {
  await createReasoningFairness(pool, inquiryAuthority()).installPolicy(answerFairnessPolicy(policyVersion, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(client => installBackgroundInquiryRoute(client, { policyVersion, routeId: `fixture-${policyVersion}`, routeProfileVersion: 'fixture-v1',
    transport: 'fixture', model: 'fixture-model', maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 200, tokenBudget: 10_000_000,
    ownerCapacity: 1_000_000, jobCapacity: 100_000, coalescingDelaySeconds, jobTtlSeconds, remoteSlots: 16 }));
}
const useRoute = async (policyVersion: string) => {
  await pool.query('UPDATE background_inquiry_route SET enabled=false WHERE enabled');
  await pool.query('UPDATE background_inquiry_route SET enabled=true WHERE policy_version=$1', [policyVersion]);
};

before(async () => {
  f = await loadInquiryFixture(pool);
  await installRoute(DELAYED, 2);
  await installRoute(SHORT, 0, 30);
  await installRoute(POLICY, 0);
});
after(async () => { await app.close(); await pool.end(); });

type Reader = { token: string; universeId: string; epoch: number; places: string[] };
const headers = (r: Reader) => ({ authorization: `Bearer ${r.token}` });
async function reader(): Promise<Reader> {
  const identity = await provisionIdentity();
  return { token: identity.token, universeId: identity.scope.universeId, epoch: 0, places: [] };
}
const putConsent = (r: Reader, body: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(r), payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: r.epoch, ...body } });
async function consent(r: Reader, enabled: boolean, dailyLimit?: number) {
  const response = await putConsent(r, { enabled, ...(dailyLimit ? { dailyLimit } : {}) });
  assert.equal(response.statusCode, 200, response.body);
  return inquiryConsentResponse.parse(response.json());
}
async function form(r: Reader, ...names: (keyof InquiryFixture['codes'])[]) {
  const codes = names.map(n => f.codes[n]);
  await formPlaces(r.universeId, codes, r.places);
  r.places.push(...codes);
}
async function list(r: Reader) {
  const response = await app.inject({ url: '/v1/inquiries', headers: headers(r) });
  assert.equal(response.statusCode, 200, response.body);
  // Every served list satisfies the strict wire contract the clients parse.
  return inquiriesResponse.parse(response.json());
}
const pass = (transport: InquiryTransport = fixture, signal = new AbortController().signal) =>
  runInquiryPass({ pool, owner: 'inquiry-test-worker', leaseMs: 60_000, transports: { fixture: transport }, signal });
const count = async (table: string, r: Reader) => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [r.universeId])).rows[0].count);
const inquiryOf = async (r: Reader) => (await pool.query(
  `SELECT i.*, j.status AS job_status, j.withdrawn_at, (SELECT count(*)::int FROM reasoning_attempt a WHERE a.job_id = i.job_id) AS attempts
   FROM background_inquiry i LEFT JOIN reasoning_job j ON j.id = i.job_id WHERE i.universe_id=$1 ORDER BY i.first_mail_at DESC LIMIT 1`, [r.universeId])).rows[0];
/** Requests this reader's universe has actually sent (dispatch committed), retained even across Clear. */
const sent = async (r: Reader) => Number((await pool.query('SELECT count(*) FROM reasoning_accounting WHERE universe_id=$1 AND dispatch_id IS NOT NULL', [r.universeId])).rows[0].count);
/** Lets every other open inquiry finish first, so a test that needs the scheduler's head owns it. */
async function quiesce() {
  for (let i = 0; i < 20; i += 1) {
    if (!(await pool.query(`SELECT 1 FROM background_inquiry WHERE status IN ('pending','queued')`)).rowCount) return;
    await pass();
    await settleInquiries(pool, { owner: 'inquiry-test-worker' });
  }
}
/** Runs the worker until nothing is left for this reader (other tests' queued work may come first). */
async function drain(r: Reader, transport: InquiryTransport = fixture) {
  for (let i = 0; i < 12; i += 1) {
    const open = (await pool.query(`SELECT 1 FROM background_inquiry WHERE universe_id=$1 AND status IN ('pending','queued')`, [r.universeId])).rowCount;
    if (!open) return;
    await pass(transport);
  }
}

test('consent is the authority: nothing is mailed without it, and turning it on never backfills earlier places', async () => {
  const r = await reader();
  await form(r, 'gravity');
  assert.equal(await count('inquiry_mail', r), 0, 'no consent, no mail');
  const on = await consent(r, true);
  assert.deepEqual([on.consent.enabled, on.consent.dailyLimit, on.consent.available, on.consent.usedToday], [true, 3, true, 0]);
  assert.equal(await count('background_inquiry', r), 0, 'the place formed before consent is not turned into paid work');
  await pass();
  assert.equal(await sent(r), 0);
  assert.deepEqual((await list(r)).inquiries, []);

  await form(r, 'sun');
  assert.equal(await count('inquiry_mail', r), 1, 'a planet formed with consent posts mail in its own transaction');
  const listed = await list(r);
  assert.equal(listed.inquiries.length, 1);
  assert.equal(listed.inquiries[0]!.status, 'waiting');
  await drain(r);
  assert.equal((await list(r)).inquiries[0]!.status, 'found');
});

test('pausing stops the mailbox: no mail while recording is paused, and the pending inquiry is withdrawn', async () => {
  const r = await reader();
  await consent(r, true);
  await form(r, 'gravity');
  assert.equal((await inquiryOf(r)).status, 'pending');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } })).statusCode, 200);
  const withdrawn = await inquiryOf(r);
  assert.deepEqual([withdrawn.status, withdrawn.reasons], ['withdrawn', ['recording_paused']]);
  await assert.rejects(transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [r.universeId]);
    await client.query(`INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status) VALUES($1,$2,0,'bridge_between_places','pending')`, [randomUUID(), r.universeId]);
    const delta = (await client.query(`SELECT id FROM atlas_delta WHERE universe_id=$1 LIMIT 1`, [r.universeId])).rows[0].id;
    await client.query(`INSERT INTO inquiry_mail(id,universe_id,privacy_epoch,kind,inquiry_id,cause_delta_id)
      SELECT $1,$2,0,'bridge_between_places',id,$3 FROM background_inquiry WHERE universe_id=$2 AND status='pending'`, [randomUUID(), r.universeId, delta]);
  }), /active consent in the current epoch while recording/, 'the schema refuses mail while paused');
});

test('a burst of places coalesces into one inquiry, due only after the coalescing delay', async () => {
  await useRoute(DELAYED);
  try {
    const r = await reader();
    await consent(r, true);
    await form(r, 'gravity', 'sun', 'tides');
    await form(r, 'body');
    assert.equal(await count('inquiry_mail', r), 4);
    assert.equal(await count('background_inquiry', r), 1, 'four new places, one inquiry');
    assert.equal((await openDueInquiries(pool)).opened, 0, 'not due inside the coalescing delay');
    const pending = await inquiryOf(r);
    assert.equal(await transaction(client => openInquiry(client, pending.id)), 'waiting', 'opening it directly rechecks the delay too');
    assert.equal((await list(r)).inquiries[0]!.status, 'waiting');
    await new Promise(resolve => setTimeout(resolve, 2_100));
    assert.equal((await openDueInquiries(pool)).opened, 1);
    const inquiry = await inquiryOf(r);
    const job = (await pool.query('SELECT class, wake_kind, dirty_scope, through_sequence::text, status FROM reasoning_job WHERE id=$1', [inquiry.job_id])).rows[0];
    const last = (await pool.query('SELECT max(sequence)::text AS n FROM inquiry_mail WHERE inquiry_id=$1', [inquiry.id])).rows[0].n;
    assert.deepEqual(job, { class: 'background_inquiry', wake_kind: 'dirty', dirty_scope: 'inquiry:bridge_between_places', through_sequence: last, status: 'queued' });
    assert.equal((await list(r)).inquiries[0]!.status, 'looking');
    await consent(r, false);
  } finally { await useRoute(POLICY); }
});

test('with no eligible pair the inquiry closes as nothing_to_ask: no Job, no attempt, no call', async () => {
  const r = await reader();
  await consent(r, true);
  await form(r, 'gravity', 'tides');
  await drain(r);
  const inquiry = await inquiryOf(r);
  assert.deepEqual([inquiry.status, inquiry.reasons, inquiry.job_id], ['nothing_to_ask', ['no_candidate_pair'], null]);
  assert.equal(await count('reasoning_job', r), 0);
  assert.equal(await sent(r), 0);
  assert.equal((await list(r)).inquiries[0]!.status, 'nothing_to_ask');
});

test('an admitted bridge end to end: found in the list, and a continuation from a Scroll on one side', async () => {
  mode = 'proposal';
  const r = await reader();
  await consent(r, true);
  await form(r, 'gravity', 'sun');
  await drain(r);
  assert.equal(await sent(r), 1, 'exactly one request sent');
  const inquiry = await inquiryOf(r);
  assert.equal(inquiry.status, 'admitted');
  assert.equal(inquiry.job_status, 'completed');
  const attempt = (await pool.query(`SELECT at.id, at.request_hash, ac.state, ac.output_authority FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.job_id=$1`, [inquiry.job_id])).rows;
  assert.equal(attempt.length, 1);
  assert.deepEqual([attempt[0].state, attempt[0].output_authority, attempt[0].request_hash], ['responded', 'withdrawn', inquiry.request_hash], 'the reserved bytes were sent');
  const proposal = (await pool.query('SELECT proposer_kind, proposer_ref, scope_kind, status FROM semantic_proposal WHERE id=$1', [inquiry.proposal_id])).rows[0];
  assert.deepEqual(proposal, { proposer_kind: 'model', proposer_ref: attempt[0].id, scope_kind: 'universe', status: 'admitted' });

  const found = (await list(r)).inquiries[0]!;
  assert.equal(found.status, 'found');
  assert.deepEqual(found.pairs, [{ a: { code: f.codes.gravity, name: 'Gravity' }, b: { code: f.codes.sun, name: 'The Sun' } }]);
  assert.ok(found.found && found.found.bridgeStatus === 'admitted' && found.found.relationType === 'compares_mechanism');
  assert.match(found.found.sentence, /^Fixture: Gravity and The Sun are linked/);
  assert.deepEqual(found.found.evidence.map(e => [e.claimKey, e.supports]).sort(), [[f.claims.gravity, 'from'], [f.claims.both, 'mechanism'], [f.claims.sun, 'to']].sort());

  const branches = await app.inject({ url: `/v1/assets/${f.assets.sun}/branches`, headers: headers(r) });
  assert.equal(branches.statusCode, 200, branches.body);
  const branch = (branches.json().branches as { bridgeId: string; target: { assetId: string } }[]).find(b => b.bridgeId === found.found!.bridgeId);
  assert.ok(branch, 'the admitted bridge is a continuation where either side is read');
  assert.equal(branch.target.assetId, f.assets.gravity);
  const stranger = await reader();
  const theirs = (await app.inject({ url: `/v1/assets/${f.assets.sun}/branches`, headers: headers(stranger) })).json();
  assert.ok(!(theirs.branches as { bridgeId: string }[]).some(b => b.bridgeId === found.found!.bridgeId), 'a personal bridge stays in its universe');
});

test('a proposal the validator refuses is recorded with its reasons; nothing is admitted', async () => {
  mode = 'invalid_bridge';
  const r = await reader();
  await consent(r, true);
  await form(r, 'gravity', 'sun');
  await drain(r);
  mode = 'proposal';
  const listed = (await list(r)).inquiries[0]!;
  assert.equal(listed.status, 'did_not_hold_up');
  // Reply v2: the system assigns sides, so the fixture's refused proposal is an analogy that never
  // says where it stops.
  assert.ok(listed.reasons.includes('analogy_limit_missing'), JSON.stringify(listed.reasons));
  const inquiry = await inquiryOf(r);
  assert.equal((await pool.query('SELECT status FROM semantic_proposal WHERE id=$1', [inquiry.proposal_id])).rows[0].status, 'rejected');
  assert.equal(await count('bridge', r), 0);
});

for (const [shape, reason] of [['prose', 'not_one_json_object'], ['unoffered_claim', 'claim_not_offered']] as const) {
  test(`a ${shape.replace('_', ' ')} reply is a shape rejection and stores no provider text`, async () => {
    mode = shape;
    const r = await reader();
    await consent(r, true);
    await form(r, 'gravity', 'sun');
    await drain(r);
    mode = 'proposal';
    const listed = (await list(r)).inquiries[0]!;
    assert.deepEqual([listed.status, listed.reasons, listed.found], ['did_not_hold_up', ['shape', reason], null]);
    assert.equal(await count('semantic_proposal', r), 0, 'nothing that failed the shape reaches a proposal');
  });
}

for (const [failure, expected] of [['http_error', 'provider_error'], ['transport_loss', 'outcome_unknown']] as const) {
  test(`a ${failure.replace('_', ' ')} fails the inquiry honestly and is never retried`, async () => {
    mode = failure;
    const r = await reader();
    await consent(r, true);
    await form(r, 'gravity', 'sun');
    await drain(r);
    mode = 'proposal';
    const listed = (await list(r)).inquiries[0]!;
    assert.deepEqual([listed.status, listed.reasons], ['failed', [expected]]);
    await pass();
    assert.equal(await sent(r), 1, 'no second call');
    assert.equal((await inquiryOf(r)).attempts, 1);
  });
}

test('the daily limit holds an inquiry as waiting; raising it lets it run', async () => {
  mode = 'none';
  const r = await reader();
  await consent(r, true, 1);
  await form(r, 'gravity', 'sun');
  await drain(r);
  assert.equal((await list(r)).inquiries[0]!.status, 'nothing_found');
  await form(r, 'body');
  await pass();
  const held = await list(r);
  assert.equal(held.inquiries[0]!.status, 'waiting', 'today\'s one inquiry is spent');
  assert.deepEqual([held.consent.usedToday, held.consent.dailyLimit], [1, 1]);
  await consent(r, true, 2);
  await drain(r);
  mode = 'proposal';
  const after = await list(r);
  // Released, it ran: Body's pairs have no claim naming both sides, so nothing could be admitted and
  // it closed as nothing_to_ask without a Job -- spending none of today's limit (review I1).
  assert.equal(after.inquiries[0]!.status, 'nothing_to_ask');
  assert.equal(after.consent.usedToday, 1);
});

/** Opens this reader's inquiry into a queued Job without running it. */
async function queued(r: Reader) {
  await consent(r, true);
  await form(r, 'gravity', 'sun');
  await openDueInquiries(pool, { limit: 50 });
  const inquiry = await inquiryOf(r);
  assert.deepEqual([inquiry.status, inquiry.job_status], ['queued', 'queued']);
  return inquiry;
}

for (const stop of ['consent_off', 'pause', 'clear'] as const) {
  test(`${stop.replace('_', ' ')} while queued withdraws the Job before anything is sent`, async () => {
    const r = await reader();
    await queued(r);
    if (stop === 'consent_off') await consent(r, false);
    if (stop === 'pause') assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } })).statusCode, 200);
    if (stop === 'clear') {
      const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
      assert.equal(cleared.statusCode, 200, cleared.body);
      for (const table of ['inquiry_mail', 'background_inquiry', 'background_inquiry_consent', 'reasoning_job']) assert.equal(await count(table, r), 0, `${table} erased`);
    } else {
      const after = await inquiryOf(r);
      assert.deepEqual([after.status, after.reasons, after.job_status, after.attempts], ['withdrawn', [stop === 'pause' ? 'recording_paused' : 'consent_off'], 'cancelled', 0]);
      assert.ok(after.withdrawn_at, 'ADR-0018 withdrawal, retention clock started');
      assert.equal((await list(r)).inquiries[0]!.status, 'withdrawn');
    }
    await pass();
    assert.equal(await sent(r), 0, 'nothing was sent');
  });
}

/** A transport that holds its call open until released, then replies as the fixture would. */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const transport: InquiryTransport = { kind: 'fixture', async send(input) { started = true; await gate; return fixture.send(input); } };
  return { transport, release, started: () => started };
}

// consent_off_on / pause_resume (review #5): turned back on before the reply lands, the seal still
// tells: the reply was asked under consent (or recording) that has since ended, so it never applies.
for (const stop of ['consent_off', 'pause', 'clear', 'consent_off_on', 'pause_resume'] as const) {
  test(`${stop.replaceAll('_', ' ')} during a call discards the reply: nothing is admitted`, async () => {
    mode = 'proposal';
    await quiesce();
    const r = await reader();
    await queued(r);
    const g = gated();
    const running = pass(g.transport);
    const deadline = Date.now() + 10_000;
    while (!g.started() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(g.started(), 'the call is in flight');
    if (stop === 'consent_off' || stop === 'consent_off_on') await consent(r, false);
    if (stop === 'consent_off_on') await consent(r, true);
    if (stop === 'pause' || stop === 'pause_resume') await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    if (stop === 'pause_resume') assert.equal((await app.inject({ method: 'POST', url: '/v1/privacy/resume', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } })).statusCode, 200);
    if (stop === 'clear') await app.inject({ method: 'POST', url: '/v1/history/clear', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
    g.release();
    const done = await running;
    assert.equal(done.kind, 'done');
    if (done.kind !== 'done') return;
    assert.equal(done.invocation, 'recorded', 'the reply arrived');
    if (stop === 'clear') {
      assert.deepEqual(done.outcome, { kind: 'discarded', reason: 'stale_epoch' });
      assert.equal(await count('background_inquiry', r), 0);
    } else {
      assert.deepEqual(done.outcome, { kind: 'withdrawn', reason: stop.startsWith('pause') ? 'recording_paused' : 'consent_off' });
      const after = await inquiryOf(r);
      assert.deepEqual([after.status, after.job_status, after.proposal_id], ['withdrawn', 'failed', null]);
    }
    assert.equal(await count('semantic_proposal', r), 0, 'the reply never became a proposal');
    assert.equal(await count('bridge', r), 0);
  });
}

// Review #7: a reply that lands after its Job's deadline says so ("it waited too long and expired"),
// not that the sealed inputs could not be verified. The shortest route time-to-live is 30 s.
test('a reply that lands after the Job deadline is discarded as expired', { timeout: 60_000 }, async () => {
  mode = 'proposal';
  await quiesce();
  await useRoute(SHORT);
  try {
    const r = await reader();
    await queued(r);
    const g = gated();
    const running = pass(g.transport);
    const until = Date.now() + 10_000;
    while (!g.started() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(g.started(), 'the call is in flight');
    const job = await inquiryOf(r);
    while ((await pool.query('SELECT deadline > clock_timestamp() AS live FROM reasoning_job WHERE id=$1', [job.job_id])).rows[0].live) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    g.release();
    const done = await running;
    assert.equal(done.kind, 'done');
    if (done.kind !== 'done') return;
    assert.deepEqual(done.outcome, { kind: 'failed', reason: 'expired' }, 'closed now, not left looking until the lease-expiry sweep');
    const after = await inquiryOf(r);
    assert.deepEqual([after.status, after.reasons, after.proposal_id, after.job_status], ['failed', ['expired'], null, 'failed']);
    assert.equal((await list(r)).inquiries[0]!.status, 'failed');
    // The sealed context names the same cause if it is rechecked after the deadline.
    const check = await transaction(client => validateInquiryContext(client, { universeId: r.universeId, privacyEpoch: 0, jobId: after.job_id,
      stepId: after.step_id, contextId: after.context_id, policyVersion: SHORT }, resolveInquiryPolicy, 'recheck'));
    assert.deepEqual(check, { valid: false, reason: 'expired' });
    assert.equal(await count('semantic_proposal', r), 0, 'the reply never became a proposal');
  } finally { await useRoute(POLICY); }
});

test('a pair connected before admission makes the context stale: discarded, never sent, never re-sent', async () => {
  const r = await reader();
  await queued(r);
  // The reader's own universe gains a bridge between the two places before the worker gets there.
  const personal = await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [r.universeId]);
    return submitBridgeProposal(client, { scope: { kind: 'universe', universeId: r.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${f.tag}`, payload: gravitySunPayload(f) });
  });
  assert.equal(personal.status, 'admitted');
  await drain(r);
  const after = await inquiryOf(r);
  assert.deepEqual([after.status, after.reasons, after.job_status, after.attempts], ['failed', ['stale_context', 'pair_connected'], 'cancelled', 0]);
  await pass();
  assert.equal(await sent(r), 0, 'never sent, never re-sent');
});

test('admitted, then stale before sending: the reserved attempt is given back unsent', async () => {
  await quiesce();
  const r = await reader();
  const inquiry = await queued(r);
  const scheduled = await createReasoningFairness(pool, inquiryAuthority()).schedule({ owner: 'inquiry-test-worker', leaseMs: 60_000, policyVersion: POLICY });
  assert.equal(scheduled.kind, 'admitted');
  if (scheduled.kind !== 'admitted') return;
  assert.equal(scheduled.claim.jobId, inquiry.job_id);
  await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [r.universeId]);
    await submitBridgeProposal(client, { scope: { kind: 'universe', universeId: r.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${f.tag}`, payload: gravitySunPayload(f) });
  });
  const done = await executeInquiryClaim({ pool, owner: 'inquiry-test-worker', transport: fixture, signal: new AbortController().signal, authority: inquiryAuthority() }, scheduled);
  assert.deepEqual([done.invocation, done.outcome], ['not_invoked', { kind: 'failed', reason: 'stale_context' }]);
  assert.equal(await sent(r), 0);
  const after = await inquiryOf(r);
  assert.deepEqual([after.status, after.reasons, after.job_status], ['failed', ['stale_context', 'pair_connected'], 'cancelled']);
  const accounting = (await pool.query(`SELECT ac.state FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.job_id=$1`, [inquiry.job_id])).rows;
  assert.deepEqual(accounting, [{ state: 'not_sent' }]);
  const held = Number((await pool.query(`SELECT count(*) FROM reasoning_reservation rr JOIN reasoning_attempt at ON at.id = rr.attempt_id WHERE at.job_id=$1 AND rr.state='held'`, [inquiry.job_id])).rows[0].count);
  assert.equal(held, 0, 'every reservation released');
});

test('a claim that loses its source support makes the context stale: discarded, never sent', async () => {
  const own = await loadInquiryFixture(pool);
  const r = await reader();
  await consent(r, true);
  await formPlaces(r.universeId, [own.codes.gravity, own.codes.sun]);
  await openDueInquiries(pool, { limit: 50 });
  assert.equal((await inquiryOf(r)).status, 'queued');
  await transaction(client => correctSourceSnapshot(client, { sourceKey: own.sources.stars, action: 'revoked', reason: 'Fixture: this source was withdrawn' }, 'editorial'));
  await drain(r);
  const after = await inquiryOf(r);
  assert.deepEqual([after.status, after.reasons, after.attempts], ['failed', ['stale_context', 'claim_changed'], 0]);
  assert.equal(await sent(r), 0);
});

test('the sweep withdraws a queued inquiry whose consent went away without the hook (defence in depth)', async () => {
  const r = await reader();
  await queued(r);
  // A consent row changed only through its recorded request; here the recorded request turns it off
  // without the route's hook, as a concurrent writer might.
  await transaction(async client => {
    const id = randomUUID();
    const session = (await client.query('SELECT id FROM device_session WHERE universe_id=$1 LIMIT 1', [r.universeId])).rows[0].id;
    await client.query(`INSERT INTO background_inquiry_consent_request(id,universe_id,privacy_epoch,session_id,client_request_id,enabled,daily_limit) VALUES($1,$2,0,$3,$4,false,3)`,
      [id, r.universeId, session, randomUUID()]);
    await client.query('UPDATE background_inquiry_consent SET enabled=false, revision=revision+1, request_id=$2 WHERE universe_id=$1', [r.universeId, id]);
  });
  assert.ok(await settleInquiries(pool, { owner: 'inquiry-test-worker' }) >= 1);
  const after = await inquiryOf(r);
  assert.deepEqual([after.status, after.reasons, after.job_status], ['withdrawn', ['consent_off'], 'cancelled']);
});

for (const operation of ['clear', 'reset'] as const) {
  test(`${operation} erases inquiries, mail and consent, after export carried them`, async () => {
    mode = 'proposal';
    const r = await reader();
    await consent(r, true);
    await form(r, 'gravity', 'sun');
    await drain(r);
    const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: headers(r), payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    assert.equal(exported.statusCode, 200, exported.body);
    const body = exported.json();
    assert.equal(body.rowCounts.inquiries, 1);
    assert.deepEqual(body.inquiries.inquiries.map((i: { status: string }) => i.status), ['admitted']);
    assert.deepEqual([body.inquiries.consent.length, body.inquiries.consentRequests.length, body.inquiries.mail.length], [1, 1, 2], 'two planets formed: two mail, one inquiry');
    assert.equal(body.semantic.proposals.length, 1, 'the decided proposal is exported with the rest of the semantic history');
    const result = await app.inject({ method: 'POST', url: operation === 'clear' ? '/v1/history/clear' : '/v1/privacy/reset', headers: headers(r),
      payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: operation === 'clear' ? 'clear-scroll-history' : 'reset-personal-universe' } });
    assert.equal(result.statusCode, 200, result.body);
    for (const table of ['inquiry_mail', 'background_inquiry', 'background_inquiry_consent', 'background_inquiry_consent_request', 'semantic_proposal', 'bridge']) {
      assert.equal(await count(table, r), 0, `${table} erased`);
    }
    if (operation === 'clear') {
      r.epoch = 1;
      const fresh = await list(r);
      assert.deepEqual([fresh.privacyEpoch, fresh.consent.enabled, fresh.inquiries], [1, false, []], 'consent is personal history: a new epoch starts without it');
    }
  });
}

test('PUT consent: exact retry replays, a reused key or a stale epoch is a conflict, malformed input is a 400', async () => {
  const r = await reader();
  const key = randomUUID();
  const first = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(r), payload: { enabled: true, clientRequestId: key, expectedPrivacyEpoch: 0 } });
  assert.equal(first.statusCode, 200, first.body);
  const again = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(r), payload: { enabled: true, clientRequestId: key, expectedPrivacyEpoch: 0 } });
  assert.equal(again.statusCode, 200);
  assert.equal(Number((await pool.query('SELECT revision FROM background_inquiry_consent WHERE universe_id=$1', [r.universeId])).rows[0].revision), 1, 'a replay changes nothing');
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: headers(r), payload: { enabled: false, clientRequestId: key, expectedPrivacyEpoch: 0 } })).statusCode, 409);
  assert.equal((await putConsent(r, { enabled: true, expectedPrivacyEpoch: 1 })).statusCode, 409);
  for (const bad of [{ enabled: true, dailyLimit: 11 }, { enabled: true, dailyLimit: 0 }, { enabled: 'yes' }, { enabled: true, extra: 1 }]) {
    assert.equal((await putConsent(r, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await app.inject({ url: '/v1/inquiries' })).statusCode, 401);
  await pool.query('UPDATE background_inquiry_route SET enabled=false WHERE enabled');
  try { assert.equal((await list(r)).consent.available, false, 'consent is kept; the client can say nothing runs'); }
  finally { await useRoute(POLICY); }
});

test('the schema keeps its own promises: consent needs its request, private rows outlive nothing, a background Job needs its cause', async () => {
  const r = await reader();
  const inquiry = await queued(r);
  await assert.rejects(pool.query('UPDATE background_inquiry_consent SET daily_limit=5 WHERE universe_id=$1', [r.universeId]), /recorded request/);
  await assert.rejects(pool.query('DELETE FROM background_inquiry WHERE id=$1', [inquiry.id]), /only after their privacy epoch ends/);
  await assert.rejects(pool.query(`UPDATE background_inquiry SET status='admitted' WHERE id=$1`, [inquiry.id]));
  await assert.rejects(pool.query(`INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status) VALUES($1,$2,0,'bridge_between_places','queued')`, [randomUUID(), r.universeId]), /starts pending/);
  // An idle background Job cannot be withdrawn while its inquiry has not recorded why.
  await assert.rejects(transaction(async client => {
    await client.query("DELETE FROM reasoning_fairness_ready WHERE job_id=$1", [inquiry.job_id]);
    await client.query("UPDATE reasoning_step SET status='cancelled' WHERE job_id=$1", [inquiry.job_id]);
    await client.query("UPDATE reasoning_job SET status='cancelled',lease_fence=lease_fence+1,withdrawn_at=clock_timestamp() WHERE id=$1", [inquiry.job_id]);
  }), /requires a safely withdrawn Job/);
  await consent(r, false);
});
