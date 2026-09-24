/**
 * #166 — native continuation as a bounded repair (ADR-0042 §1–§3), through the real app, the real
 * reasoning primitives, the real validator and the worker's inquiry pass, over the labelled fixture
 * transport. Proves: a refused proposal continues in the same conversation with the prior assistant
 * turn (thinking blocks in place) and the validator's reasons, as a fresh admitted Attempt after its
 * own quota check, and the validator decides again; the route's bound; truncation as its own outcome;
 * a continuation refused when the sealed context changed; an unknown outcome held and never resent;
 * competing workers; consent off and Clear during the continuation call; a stale continuation output
 * discarded; the protected turn never exposed. No provider is called.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { pool, transaction } from '../packages/db/src/index.ts';
import { settleInquiries } from '../packages/db/src/reasoning-inquiry-execution.ts';
import { submitBridgeProposal } from '../packages/db/src/semantic/proposals.ts';
import { createReadinessGate } from '../apps/worker/src/reasoning/answer-worker.ts';
import { runInquiryPass, type InquiryObservation, type InquiryTransport } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport, type InquiryFixtureMode } from '../apps/worker/src/providers/inquiry-fixture.ts';
import {
  consentingReader, formPlaces, gravitySunPayload, installFixtureInquiryRoute, loadInquiryFixture, newestInquiry, useInquiryRoute,
  type InquiryFixture, type InquiryReader,
} from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
// Thinking on, so the fixture's replies carry a thinking block like M3's; one continuation (the default).
const POLICY = 'continuation-test-v1';
const NEVER = 'continuation-test-never-v1';
const TWICE = 'continuation-test-twice-v1';
let mode: InquiryFixtureMode = 'refused_then_valid';
const fixture = createFixtureInquiryTransport(() => mode);
/** What was sent and what came back, in order: request bodies and assistant turns (fixture replies). */
const sentBodies: Uint8Array[] = [];
const replies: InquiryObservation[] = [];
const recording: InquiryTransport = { kind: 'fixture', async send(input) {
  sentBodies.push(Uint8Array.from(input.body));
  const o = await fixture.send(input);
  replies.push(o);
  return o;
} };
const signal = new AbortController().signal;
let f: InquiryFixture;

before(async () => {
  f = await loadInquiryFixture(pool);
  await installFixtureInquiryRoute(NEVER, { thinking: 'adaptive', maxContinuationSteps: 0 });
  await installFixtureInquiryRoute(TWICE, { thinking: 'adaptive', maxContinuationSteps: 2 });
  await installFixtureInquiryRoute(POLICY, { thinking: 'adaptive' });
});
after(async () => { await app.close(); await pool.end(); });

const pass = (transport: InquiryTransport = recording, owner = 'continuation-worker', leaseMs = 60_000) =>
  runInquiryPass({ pool, owner, leaseMs, transports: { fixture: transport }, signal });
const sweep = () => settleInquiries(pool, { owner: 'continuation-worker' });
/** The worker loop for one reader: passes and its periodic sweep, until nothing of theirs is open. */
async function drain(r: InquiryReader, transport: InquiryTransport = recording) {
  for (let i = 0; i < 16; i += 1) {
    if (!(await pool.query(`SELECT 1 FROM background_inquiry WHERE universe_id=$1 AND status IN ('pending','queued')`, [r.universeId])).rowCount) return;
    await pass(transport);
    await sweep();
  }
}
/** Lets every other open inquiry finish first, so a test that needs the scheduler's head owns it. */
async function quiesce() {
  for (let i = 0; i < 24 && (await pool.query(`SELECT 1 FROM background_inquiry WHERE status IN ('pending','queued')`)).rowCount; i += 1) {
    await pass(fixture);
    await sweep();
  }
}
async function reader(): Promise<InquiryReader> {
  const r = await consentingReader(app);
  await formPlaces(r.universeId, [f.codes.gravity, f.codes.sun]);
  return r;
}
const steps = async (jobId: string) => (await pool.query(
  `SELECT s.ordinal, s.status, ac.state, a.id AS attempt FROM reasoning_step s LEFT JOIN reasoning_attempt a ON a.step_id = s.id
   LEFT JOIN reasoning_accounting ac ON ac.attempt_id = a.id WHERE s.job_id=$1 ORDER BY s.ordinal`, [jobId])).rows;
const proposals = async (r: InquiryReader) => (await pool.query(
  `SELECT status, proposer_ref, decision FROM semantic_proposal WHERE universe_id=$1 ORDER BY decided_at`, [r.universeId])).rows;
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const list = async (r: InquiryReader) => (await app.inject({ url: '/v1/inquiries', headers: r.headers })).json();

test('a refused proposal continues once, in the same conversation, and the validator admits the corrected one', async () => {
  mode = 'refused_then_valid';
  await quiesce();
  sentBodies.length = 0; replies.length = 0;
  const r = await reader();
  // The quota is checked before every request: a dispatch spends the gate's trusted window (ADR-0042 §3).
  let checks = 0;
  const quota: InquiryTransport = { ...recording, async ready() { checks += 1; return { ok: true }; } };
  const gate = createReadinessGate(quota, { okMs: 60_000 });
  const run = () => runInquiryPass({ pool, owner: 'continuation-worker', leaseMs: 60_000, transports: { fixture: quota }, readiness: { fixture: gate }, signal });

  const first = await run();
  assert.ok(first.kind === 'done', JSON.stringify(first));
  assert.deepEqual(first.outcome, { kind: 'continued', ordinal: 2 });
  const waiting = await newestInquiry(r.universeId);
  assert.deepEqual([waiting.status, waiting.job_status], ['queued', 'queued'], 'the Job is back in the fair queue, its lease released');
  const second = await run();
  assert.ok(second.kind === 'done', JSON.stringify(second));
  assert.deepEqual(second.outcome, { kind: 'applied', status: 'admitted' });
  assert.equal(checks, 2, 'one quota check before each of the two requests');

  // Two requests, each a fresh admitted Attempt on its own Step; the first Step was superseded.
  const inquiry = await newestInquiry(r.universeId);
  const graph = await steps(inquiry.job_id);
  assert.deepEqual(graph.map(s => [s.ordinal, s.status, s.state]), [[1, 'superseded', 'responded'], [2, 'succeeded', 'responded']]);
  assert.deepEqual([inquiry.status, inquiry.job_status, inquiry.attempt_id, inquiry.dispatched, inquiry.sent], ['admitted', 'completed', graph[1]!.attempt, 2, true]);
  // The validator decided both: the first refused (its reasons kept), the continuation admitted.
  const decided = await proposals(r);
  assert.deepEqual(decided.map(p => [p.status, p.proposer_ref]), [['rejected', graph[0]!.attempt], ['admitted', graph[1]!.attempt]]);
  assert.equal(inquiry.proposal_id !== null, true);

  // The continuation is the first request, the refused turn exactly as returned (thinking first), then the reasons.
  assert.equal(sentBodies.length, 2);
  const [one, two] = sentBodies.map(decode);
  assert.deepEqual([two.system, two.model, two.max_tokens, two.thinking, two.messages[0]], [one.system, one.model, one.max_tokens, one.thinking, one.messages[0]]);
  assert.deepEqual(two.messages[1], { role: 'assistant', content: replies[0]!.content });
  assert.deepEqual(replies[0]!.content.map(b => b.type), ['thinking', 'text']);
  const reasons: string[] = decided[0]!.decision.reasons;
  assert.ok(reasons.length > 0 && reasons.every(reason => two.messages[2].content.includes(reason)), two.messages[2].content);
  for (const body of sentBodies) assert.ok(body.byteLength <= 16_384);
  assert.ok(two.max_tokens <= 4_096);
  const continuation = (await pool.query('SELECT ordinal, reasons, assistant_turn, previous_attempt_id FROM background_inquiry_continuation WHERE job_id=$1', [inquiry.job_id])).rows;
  assert.deepEqual(continuation, [{ ordinal: 2, reasons, assistant_turn: replies[0]!.content, previous_attempt_id: graph[0]!.attempt }]);
  assert.equal((await list(r)).inquiries[0].status, 'found');
});

for (const [policy, requests] of [[NEVER, 1], [POLICY, 2], [TWICE, 3]] as const) {
  test(`the route bounds it: ${requests} request(s) with max_continuation_steps ${requests - 1}, then the validator's refusal stands`, async () => {
    mode = 'invalid_bridge';
    await quiesce();
    await useInquiryRoute(policy);
    try {
      const r = await reader();
      await drain(r);
      const inquiry = await newestInquiry(r.universeId);
      assert.deepEqual([inquiry.status, inquiry.dispatched], ['rejected', requests]);
      assert.ok(inquiry.reasons.includes('analogy_limit_missing'), JSON.stringify(inquiry.reasons));
      assert.deepEqual((await proposals(r)).map(p => p.status), Array(requests).fill('rejected'));
      assert.deepEqual((await steps(inquiry.job_id)).map(s => s.status), [...Array(requests - 1).fill('superseded'), 'failed']);
      await pass(); await sweep();
      assert.equal((await newestInquiry(r.universeId)).dispatched, requests, 'nothing more is ever sent');
    } finally { await useInquiryRoute(POLICY); }
  });
}

test('truncation is its own outcome: the reply is not parsed and never continued', async () => {
  mode = 'truncated';
  const r = await reader();
  await drain(r);
  const inquiry = await newestInquiry(r.universeId);
  assert.deepEqual([inquiry.status, inquiry.reasons, inquiry.proposal_id, inquiry.dispatched], ['failed', ['truncated'], null, 1]);
  assert.deepEqual(await proposals(r), []);
  assert.deepEqual((await list(r)).inquiries[0].reasons, ['truncated']);
});

test('a continuation is refused when the sealed context changed: never sent, never re-sent', async () => {
  mode = 'refused_then_valid';
  await quiesce();
  const r = await reader();
  const continued = await pass();
  assert.ok(continued.kind === 'done' && continued.outcome.kind === 'continued', JSON.stringify(continued));
  // The reader's own universe connects the pair before the continuation is sent.
  await transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [r.universeId]);
    await submitBridgeProposal(client, { scope: { kind: 'universe', universeId: r.universeId, privacyEpoch: 0 }, proposerKind: 'person', proposerRef: `person-${f.tag}`, payload: gravitySunPayload(f) });
  });
  await drain(r);
  const inquiry = await newestInquiry(r.universeId);
  assert.deepEqual([inquiry.status, inquiry.reasons, inquiry.dispatched], ['failed', ['stale_context', 'pair_connected'], 1]);
  assert.deepEqual((await steps(inquiry.job_id)).map(s => [s.ordinal, s.status, s.state]), [[1, 'superseded', 'responded'], [2, 'cancelled', null]]);
});

test('a lost acknowledgement on the continuation is held as unknown and never resent', async () => {
  mode = 'refused_then_valid';
  await quiesce();
  const r = await reader();
  let calls = 0;
  const losing: InquiryTransport = { kind: 'fixture', async send(input) { calls += 1; if (calls === 2) throw new Error('fixture: the reply never arrived'); return fixture.send(input); } };
  await drain(r, losing);
  const inquiry = await newestInquiry(r.universeId);
  assert.deepEqual([inquiry.status, inquiry.reasons, inquiry.dispatched], ['failed', ['outcome_unknown'], 2]);
  const graph = await steps(inquiry.job_id);
  assert.deepEqual(graph.map(s => s.state), ['responded', 'unknown']);
  const remote = Number((await pool.query(`SELECT count(*) FROM reasoning_reservation rr JOIN reasoning_bucket b ON b.id = rr.bucket_id
    WHERE rr.attempt_id=$1 AND b.dimension='remote_concurrency' AND rr.state='held'`, [graph[1]!.attempt])).rows[0].count);
  assert.equal(remote, 1, 'an unknown outcome keeps its remote slot');
  for (let i = 0; i < 3; i += 1) { await pass(losing); await sweep(); }
  assert.equal((await newestInquiry(r.universeId)).dispatched, 2, 'never resent');
});

test('competing workers send each continuation exactly once', async () => {
  mode = 'refused_then_valid';
  await quiesce();
  const readers = [await reader(), await reader(), await reader()];
  const seen: string[] = [];
  const open = async () => (await pool.query(`SELECT 1 FROM background_inquiry WHERE status IN ('pending','queued')`)).rowCount;
  // Two schedulers on one policy mostly find each other's cursor moved and yield: they contend for a
  // while, then one finishes what is left. How far the pair gets depends on timing; what is asserted
  // below never does: each Step was sent exactly once, whichever worker sent it.
  for (let i = 0; i < 40 && await open(); i += 1) {
    for (const done of await Promise.all([pass(fixture, 'worker-a'), pass(fixture, 'worker-b')])) {
      seen.push(done.kind === 'idle' ? done.reason : done.kind === 'done' ? done.outcome.kind : done.kind);
    }
    await sweep();
  }
  for (let i = 0; i < 40 && await open(); i += 1) { await pass(fixture, 'worker-a'); await sweep(); }
  for (const r of readers) {
    const inquiry = await newestInquiry(r.universeId);
    assert.deepEqual([inquiry.status, inquiry.dispatched], ['admitted', 2], JSON.stringify(seen));
    const perStep = (await pool.query('SELECT step_id, count(*)::int AS n FROM reasoning_attempt WHERE job_id=$1 GROUP BY step_id', [inquiry.job_id])).rows;
    assert.deepEqual(perStep.map(s => s.n), [1, 1], 'one Attempt per Step');
  }
});

/** A transport that answers the first request at once and holds the continuation open until released. */
function gatedContinuation() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const transport: InquiryTransport = { kind: 'fixture', async send(input) {
    if (decode(input.body).messages.length > 1) { started = true; await gate; }
    return fixture.send(input);
  } };
  return { transport, release, started: () => started };
}

for (const stop of ['consent_off', 'clear'] as const) {
  test(`${stop.replace('_', ' ')} during the continuation call discards its reply: nothing is admitted`, async () => {
    mode = 'refused_then_valid';
    await quiesce();
    const r = await reader();
    const g = gatedContinuation();
    assert.equal((await pass(g.transport)).kind, 'done');
    const running = pass(g.transport);
    for (let i = 0; i < 500 && !g.started(); i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(g.started(), 'the continuation is in flight');
    if (stop === 'consent_off') {
      const off = await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
      assert.equal(off.statusCode, 200, off.body);
    } else {
      const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
      assert.equal(cleared.statusCode, 200, cleared.body);
    }
    g.release();
    const done = await running;
    assert.ok(done.kind === 'done' && done.invocation === 'recorded', JSON.stringify(done));
    if (stop === 'clear') {
      assert.deepEqual(done.outcome, { kind: 'discarded', reason: 'stale_epoch' });
      for (const table of ['background_inquiry', 'background_inquiry_continuation', 'semantic_proposal', 'bridge']) {
        assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [r.universeId])).rows[0].count), 0, `${table} erased`);
      }
    } else {
      assert.deepEqual(done.outcome, { kind: 'withdrawn', reason: 'consent_off' });
      const inquiry = await newestInquiry(r.universeId);
      assert.deepEqual([inquiry.status, inquiry.proposal_id, inquiry.dispatched], ['withdrawn', null, 2]);
      assert.deepEqual((await proposals(r)).map(p => p.status), ['rejected'], 'only the refused first proposal; the continuation never became one');
    }
  });
}

test('a continuation reply that lands after the lease was lost is discarded and never applied', async () => {
  mode = 'refused_then_valid';
  await quiesce();
  const r = await reader();
  assert.equal((await pass(fixture)).kind, 'done');
  const slow: InquiryTransport = { kind: 'fixture', async send(input) { await new Promise(resolve => setTimeout(resolve, 1_300)); return fixture.send(input); } };
  const late = await pass(slow, 'continuation-slow', 1_000);
  assert.ok(late.kind === 'done', JSON.stringify(late));
  assert.deepEqual(late.outcome, { kind: 'discarded', reason: 'lease_lost' });
  assert.ok(await sweep() >= 1);
  const inquiry = await newestInquiry(r.universeId);
  assert.deepEqual([inquiry.status, inquiry.reasons, inquiry.proposal_id, inquiry.dispatched], ['failed', ['apply_failed'], null, 2]);
  assert.deepEqual((await proposals(r)).map(p => p.status), ['rejected']);
});

test('the protected turn is never exposed, and Clear erases it', async () => {
  mode = 'refused_then_valid';
  await quiesce();
  const r = await reader();
  await drain(r);
  const inquiry = await newestInquiry(r.universeId);
  assert.equal(inquiry.status, 'admitted');
  const thought = 'Fixture thinking block';
  const exported = await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  assert.equal(exported.statusCode, 200, exported.body);
  for (const body of [exported.body, JSON.stringify(await list(r)),
    JSON.stringify((await pool.query('SELECT * FROM reasoning_receipt WHERE universe_id=$1', [r.universeId])).rows)]) {
    assert.ok(!body.includes(thought), 'never in a client view, an export or a receipt');
  }
  // Only a refused proposal's next Step may be recorded, and never edited.
  const row = (await pool.query('SELECT * FROM background_inquiry_continuation WHERE job_id=$1', [inquiry.job_id])).rows[0];
  await assert.rejects(pool.query(`UPDATE background_inquiry_continuation SET reasons='["x"]' WHERE step_id=$1`, [row.step_id]), /immutable/);
  await assert.rejects(pool.query('DELETE FROM background_inquiry_continuation WHERE step_id=$1', [row.step_id]), /erased only with its Step/);
  const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(Number((await pool.query('SELECT count(*) FROM background_inquiry_continuation WHERE universe_id=$1', [r.universeId])).rows[0].count), 0);
});
