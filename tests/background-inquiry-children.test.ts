/**
 * #166 — optional bounded child inquiries (ADR-0042 §4), through the real app, the real Cartographer,
 * the real reasoning primitives and validator and the worker's inquiry pass, over the labelled fixture
 * transport. Proves: a due inquiry with several pairs becomes a parent whose waiting Job holds the
 * family's one budget, with one child per pair (each its own Job, context, Step and request, binding
 * the parent's budget); each child is decided by the validator on its own; the parent settles with its
 * last child; withdrawal reaches the whole family; the reader sees the children and today's limit
 * counts the family once; the schema keeps a family honest. No provider is called.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { buildApp } from '../apps/api/src/app.ts';
import { inquiriesResponse } from '../packages/contracts/src/inquiries.ts';
import { pool, transaction } from '../packages/db/src/index.ts';
import { openDueInquiries, resolveInquiryPolicy } from '../packages/db/src/reasoning-inquiries.ts';
import { settleInquiries } from '../packages/db/src/reasoning-inquiry-execution.ts';
import { runInquiryPass, type InquiryTransport } from '../apps/worker/src/reasoning/inquiry-worker.ts';
import { createFixtureInquiryTransport, type InquiryFixtureMode } from '../apps/worker/src/providers/inquiry-fixture.ts';
import {
  consentingReader, formPlaces, installFixtureInquiryRoute, loadInquiryFixture, useInquiryRoute, type InquiryFixture, type InquiryReader,
} from './helpers/inquiry-fixture.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Inquiry tests require a disposable knowscroll_test_* database');

const app = buildApp(randomBytes(32).toString('hex'));
const FAMILY = 'children-test-v1';
const SINGLE = 'children-test-single-v1';
let mode: InquiryFixtureMode = 'proposal';
const fixture = createFixtureInquiryTransport(() => mode);
const signal = new AbortController().signal;
let f: InquiryFixture;

before(async () => {
  f = await loadInquiryFixture(pool);
  await installFixtureInquiryRoute(SINGLE);
  await installFixtureInquiryRoute(FAMILY, { maxChildren: 3 });
});
after(async () => { await app.close(); await pool.end(); });

const pass = (transport: InquiryTransport = fixture) => runInquiryPass({ pool, owner: 'children-worker', leaseMs: 60_000, transports: { fixture: transport }, signal });
const sweep = () => settleInquiries(pool, { owner: 'children-worker' });
async function drain(r: InquiryReader, transport: InquiryTransport = fixture) {
  for (let i = 0; i < 16; i += 1) {
    if (!(await pool.query(`SELECT 1 FROM background_inquiry WHERE universe_id=$1 AND status IN ('pending','queued')`, [r.universeId])).rowCount) return;
    await pass(transport);
    await sweep();
  }
}
async function quiesce() {
  for (let i = 0; i < 24 && (await pool.query(`SELECT 1 FROM background_inquiry WHERE status IN ('pending','queued')`)).rowCount; i += 1) { await pass(); await sweep(); }
}
/** A reader whose Gravity, Sun and Moon give two candidate pairs, opened into Jobs without running them. */
async function family(): Promise<InquiryReader> {
  const r = await consentingReader(app);
  await formPlaces(r.universeId, [f.codes.gravity, f.codes.sun, f.codes.moon]);
  await openDueInquiries(pool, { limit: 50 });
  return r;
}
const rows = async (r: InquiryReader) => (await pool.query(
  `SELECT i.*, j.status AS job_status, j.class, j.wake_kind, j.deadline, j.through_sequence::text AS job_through, j.budget_owner_id,
     (SELECT count(*)::int FROM reasoning_step s WHERE s.job_id = i.job_id) AS steps,
     (SELECT count(*)::int FROM reasoning_attempt a JOIN reasoning_accounting ac ON ac.attempt_id = a.id WHERE a.job_id = i.job_id AND ac.dispatch_id IS NOT NULL) AS dispatched
   FROM background_inquiry i JOIN reasoning_job j ON j.id = i.job_id WHERE i.universe_id=$1 ORDER BY i.role DESC, i.pairs::text`, [r.universeId])).rows;
const pairCodes = (row: { pairs: { a: { code: string }; b: { code: string } }[] }) => row.pairs.map(p => `${p.a.code}~${p.b.code}`);
const list = async (r: InquiryReader) => inquiriesResponse.parse((await app.inject({ url: '/v1/inquiries', headers: r.headers })).json());

test('a due inquiry with several pairs becomes a parent: its waiting Job holds the one budget, and each pair is a child of its own', async () => {
  mode = 'proposal';
  await useInquiryRoute(FAMILY);
  const r = await family();
  const [parent, ...children] = await rows(r);
  assert.deepEqual([parent.role, parent.status, parent.job_status, parent.steps, parent.step_id, parent.request_hash], ['parent', 'queued', 'waiting', 0, null, null]);
  assert.deepEqual(pairCodes(parent), [`${f.codes.gravity}~${f.codes.moon}`, `${f.codes.gravity}~${f.codes.sun}`]);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.deepEqual([child.role, child.parent_id, child.status, child.job_status, child.steps, child.job_bucket_id], ['child', parent.id, 'queued', 'queued', 1, null]);
    // The parent's budget owner, class, epoch, deadline and cause, and its route.
    assert.deepEqual([child.class, child.wake_kind, child.budget_owner_id, child.privacy_epoch, child.deadline.getTime(), child.job_through, child.policy_version],
      [parent.class, parent.wake_kind, parent.budget_owner_id, parent.privacy_epoch, parent.deadline.getTime(), parent.job_through, parent.policy_version]);
    const policy = await transaction(client => resolveInquiryPolicy(client, { universeId: r.universeId, privacyEpoch: 0, jobId: child.job_id })) as { buckets: { dimension: string; bucketId: string }[] };
    assert.equal(policy.buckets.find(b => b.dimension === 'job_budget')!.bucketId, parent.job_bucket_id, 'a child binds the parent\'s budget, never its own');
  }
  assert.deepEqual(children.map(pairCodes).flat().sort(), pairCodes(parent).sort(), 'one pair each');

  await drain(r);
  const [settled, ...done] = await rows(r);
  assert.deepEqual([settled.status, settled.job_status, settled.sent], ['settled', 'completed', false]);
  assert.deepEqual(done.map(c => [c.status, c.dispatched, c.sent]), [['admitted', 1, true], ['admitted', 1, true]]);
  const bridges = (await pool.query(`SELECT b.status FROM bridge b JOIN background_inquiry i ON i.proposal_id = b.proposal_id WHERE i.universe_id=$1`, [r.universeId])).rows;
  assert.equal(bridges.length, 2, 'one admitted bridge per pair');
  const spent = (await pool.query(`SELECT DISTINCT rr.bucket_id FROM reasoning_reservation rr JOIN reasoning_attempt a ON a.id = rr.attempt_id
    JOIN reasoning_bucket b ON b.id = rr.bucket_id WHERE a.universe_id=$1 AND b.dimension='job_budget'`, [r.universeId])).rows;
  assert.deepEqual(spent, [{ bucket_id: parent.job_bucket_id }], 'every child drew on the parent\'s budget');

  const listed = await list(r);
  assert.equal(listed.inquiries.length, 2, 'the reader sees the children, never the parent');
  assert.deepEqual(listed.inquiries.map(i => [i.status, i.pairs.length]), [['found', 1], ['found', 1]]);
  assert.equal(listed.consent.usedToday, 1, 'the family counts once against today\'s limit');
});

test('with a route that allows no children, several pairs stay one inquiry', async () => {
  mode = 'none';
  await useInquiryRoute(SINGLE);
  try {
    const r = await family();
    const [single] = await rows(r);
    assert.deepEqual([single.role, single.parent_id, single.pairs.length, single.steps], ['single', null, 2, 1]);
    await drain(r);
    assert.equal((await rows(r))[0].status, 'none');
  } finally { await useInquiryRoute(FAMILY); }
});

for (const stop of ['consent_off', 'pause', 'clear'] as const) {
  test(`${stop.replace('_', ' ')} reaches the whole family before anything is sent`, async () => {
    await quiesce();
    const r = await family();
    if (stop === 'consent_off') await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    if (stop === 'pause') await app.inject({ method: 'POST', url: '/v1/privacy/pause', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0 } });
    if (stop === 'clear') {
      const cleared = await app.inject({ method: 'POST', url: '/v1/history/clear', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: 0, confirmation: 'clear-scroll-history' } });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(Number((await pool.query('SELECT count(*) FROM background_inquiry WHERE universe_id=$1', [r.universeId])).rows[0].count), 0);
      assert.equal(Number((await pool.query('SELECT count(*) FROM reasoning_job WHERE universe_id=$1', [r.universeId])).rows[0].count), 0);
    } else {
      const reason = stop === 'pause' ? 'recording_paused' : 'consent_off';
      assert.deepEqual((await rows(r)).map(i => [i.role, i.status, i.reasons, i.job_status]),
        [['parent', 'withdrawn', [reason], 'cancelled'], ['child', 'withdrawn', [reason], 'cancelled'], ['child', 'withdrawn', [reason], 'cancelled']]);
    }
    await pass(); await sweep();
    assert.equal(Number((await pool.query('SELECT count(*) FROM reasoning_accounting WHERE universe_id=$1 AND dispatch_id IS NOT NULL', [r.universeId])).rows[0].count), 0, 'nothing was sent');
  });
}

test('a child in flight when consent goes off is discarded at apply; the parent is withdrawn, never settled', async () => {
  mode = 'proposal';
  await quiesce();
  const r = await family();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const held: InquiryTransport = { kind: 'fixture', async send(input) { started = true; await gate; return fixture.send(input); } };
  const running = pass(held);
  for (let i = 0; i < 500 && !started; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(started, 'one child is in flight');
  await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
  release();
  const done = await running;
  assert.ok(done.kind === 'done', JSON.stringify(done));
  assert.deepEqual(done.outcome, { kind: 'withdrawn', reason: 'consent_off' });
  const [parent, ...children] = await rows(r);
  assert.deepEqual([parent.status, parent.job_status], ['withdrawn', 'cancelled']);
  assert.deepEqual(children.map(c => c.status), ['withdrawn', 'withdrawn']);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM bridge WHERE universe_id=$1`, [r.universeId])).rows[0].count), 0);
});

test('the schema keeps a family honest', async () => {
  await quiesce();
  const r = await family();
  const [parent, child] = await rows(r);
  const insertChild = (over: Record<string, unknown>) => transaction(async client => {
    const v = { pairs: JSON.stringify([parent.pairs[0]]), ...over };
    // Everything else is the parent's own, so only the pair can be refused.
    await client.query(`INSERT INTO background_inquiry(id,universe_id,privacy_epoch,kind,status,role,parent_id,first_mail_at,policy_version,job_id,step_id,context_id,request_id,through_sequence,pairs)
      SELECT $1,universe_id,privacy_epoch,kind,'queued','child',id,first_mail_at,policy_version,$3,$4,$5,$6,through_sequence,$7 FROM background_inquiry WHERE id=$2`,
      [randomUUID(), parent.id, randomUUID(), randomUUID(), randomUUID(), randomUUID(), v.pairs]);
  });
  await assert.rejects(insertChild({}), /one pair of its own queued parent/, 'a pair a sibling already asks');
  await assert.rejects(insertChild({ pairs: JSON.stringify([{ a: { code: f.codes.sun, name: 'The Sun' }, b: { code: f.codes.moon, name: 'The Moon' } }]) }), /one pair of its own queued parent/, 'a pair the parent never offered');
  await assert.rejects(pool.query(`UPDATE background_inquiry SET status='settled' WHERE id=$1`, [parent.id]), /settles only once every child has closed/);
  await assert.rejects(pool.query(`UPDATE background_inquiry SET status='settled' WHERE id=$1`, [child.id]), /Illegal inquiry transition|background_inquiry_parent_status/);
  await app.inject({ method: 'PUT', url: '/v1/inquiries/consent', headers: r.headers, payload: { enabled: false, clientRequestId: randomUUID(), expectedPrivacyEpoch: 0 } });
});
