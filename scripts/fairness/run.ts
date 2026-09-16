/** Executable scenario assertions. Names alone are never evidence of a fault or transition. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CLASSES, createSnapshot, enqueue, normalizedCharge, rolloverRateWindow,
  scheduleTick, settle, snapshotHash,
  type Candidate, type Decision, type FairnessClass, type FairnessPolicy,
  type FairnessSnapshot, type Receipt, type ScheduleLimits,
} from './model.ts';
import { candidate, fixturePolicy } from './scenarios.ts';

const abundant = (overrides: Partial<FairnessPolicy> = {}) => fixturePolicy({
  maxReadySetSize: 1024, maxScanPerTick: 128, maxAdmissionsPerTick: 16,
  physical: [
    { key: 'budget', kind: 'budget', capacity: 1_000_000 },
    { key: 'rate', kind: 'rate', capacity: 1_000_000 },
    { key: 'remote', kind: 'remote', capacity: 4096 },
  ], ...overrides,
});
class Scenario {
  state: FairnessSnapshot;
  events: unknown[] = [];
  observations: unknown[] = [];
  decisions: Decision[] = [];
  constructor(readonly name: string, readonly policy = abundant()) {
    this.state = createSnapshot(policy);
  }
  add(...work: Candidate[]) {
    for (const job of work) this.state = enqueue(this.policy, this.state, job);
    this.events.push({ op: 'enqueue', work });
  }
  tick(limits: ScheduleLimits = {}) {
    const result = scheduleTick(this.policy, this.state, limits);
    this.state = result.snapshot;
    this.decisions.push(...result.decisions);
    this.events.push({ op: 'tick', limits });
    return result.decisions;
  }
  receipt(id: string, receipt: Receipt) {
    const result = settle(this.policy, this.state, id, receipt);
    this.state = result.snapshot;
    this.decisions.push(...result.decisions);
    this.events.push({ op: 'receipt', id, receipt });
  }
  drain(limit = 100) {
    for (let i = 0; this.state.ready.length && i < limit; i++) this.tick();
    assert.equal(this.state.ready.length, 0, `${this.name}: ready backlog did not drain`);
  }
  observe(label: string, detail: unknown = {}) {
    this.observations.push({ label, hash: snapshotHash(this.state), detail,
      classCredit: Object.fromEntries(CLASSES.map(c => [c, this.state.classLanes[c].credit])),
      universeCredit: Object.fromEntries(Object.entries(this.state.universeLanes).map(([k, v]) => [k, v.credit])),
      queued: this.state.ready.map(j => j.attemptId), paused: this.state.pausedDimensions,
      openVisit: this.state.openVisit,
    });
  }
  finish() {
    const serviceByClass: Record<string, number> = {};
    const serviceByUniverse: Record<string, number> = {};
    const admissionsByClass: Record<string, number> = {};
    for (const d of this.decisions.filter(d => d.kind === 'admitted')) {
      assert.ok(d.class && d.universeId && d.charge);
      serviceByClass[d.class] = (serviceByClass[d.class] ?? 0) + d.charge;
      serviceByUniverse[d.universeId] = (serviceByUniverse[d.universeId] ?? 0) + d.charge;
      admissionsByClass[d.class] = (admissionsByClass[d.class] ?? 0) + 1;
    }
    return { name: this.name, passed: true, policy: this.policy, events: this.events,
      observations: this.observations, decisions: this.decisions, serviceByClass,
      serviceByUniverse, admissionsByClass, finalHash: snapshotHash(this.state) };
  }
}
const jobs = (prefix: string, count: number, universe: string, klass: FairnessClass, cost: number) =>
  Array.from({ length: count }, (_, i) => candidate(`${prefix}${i}`, universe, klass, cost));
const admitted = (ds: Decision[]) => ds.filter(d => d.kind === 'admitted');
const traces: ReturnType<Scenario['finish']>[] = [];

// Arrivals happen between scheduling intervals, rather than one initial smoke queue.
{
  const s = new Scenario('steady-load');
  for (let time = 0; time < 8; time++) {
    s.add(...CLASSES.map((c, i) => candidate(`steady-${time}-${i}`, `u${i}`, c, 20 + i * 20)));
    s.drain();
    s.observe(`arrival-batch-${time}-drained`);
  }
  assert.equal(admitted(s.decisions).length, 40);
  traces.push(s.finish());
}
// Different costs force service-unit accounting; equal request counts would fail.
{
  const s = new Scenario('saturated-classes');
  const costs = [25, 50, 40, 75, 100];
  CLASSES.forEach((c, i) => s.add(...jobs(`sat-${i}-`, 60, `u${i}`, c, costs[i]!)));
  for (let tick = 0; tick < 100 && new Set(admitted(s.decisions).map(d => d.visitGeneration)).size < 6; tick++) s.tick();
  assert.ok(new Set(admitted(s.decisions).map(d => d.visitGeneration)).size >= 6, 'class traversal stalled');
  const firstTurns = admitted(s.decisions).filter(d => d.visitGeneration! <= 5);
  const totals = Object.fromEntries(CLASSES.map(c => [c,
    firstTurns.filter(d => d.class === c).reduce((sum, d) => sum + d.charge!, 0)]));
  assert.deepEqual(totals, { interactive: 500, active_continuity: 600,
    accumulated_interpretation: 400, background_inquiry: 300, housekeeping: 200 });
  s.observe('first-complete-class-traversal', { service: totals, expectedTotal: 2000 });
  traces.push(s.finish());
}
{
  const s = new Scenario('large-active-universe-versus-sparse');
  s.add(...jobs('flood-', 100, 'a-flood', 'interactive', 40),
    candidate('sparse-max', 'b-sparse', 'interactive', 100),
    candidate('sparse-small', 'c-sparse', 'interactive', 70));
  s.drain();
  const order = admitted(s.decisions);
  const index = order.findIndex(d => d.attemptId === 'attempt-sparse-max');
  assert.ok(index >= 0 && index <= 2, 'maximum sparse request must not wait for cheap flood');
  s.observe('sparse-service', { maximumIndex: index, totalAdmissions: order.length });
  traces.push(s.finish());
}
{
  const s = new Scenario('borrowing-then-renewed-demand');
  s.add(...jobs('borrow-', 80, 'borrower', 'background_inquiry', 20));
  assert.equal(admitted(s.tick({ maxAdmissionsPerTick: 10, maxScanPerTick: 128 })).length, 10);
  const borrowedVisit = s.state.visitGeneration;
  s.observe('only-borrower-uses-admission-opportunities', { borrowedVisit });
  s.add(candidate('returner', 'returner', 'interactive', 100));
  for (let i = 0; i < 100 && !s.state.reservations['attempt-returner']; i++) {
    s.tick({ maxAdmissionsPerTick: 1, maxScanPerTick: 128 });
  }
  const returned = admitted(s.decisions).find(d => d.attemptId === 'attempt-returner');
  assert.ok(returned, 'returner must be served before borrower queue drains');
  assert.ok(returned.visitGeneration! <= borrowedVisit + 5);
  assert.ok(s.state.ready.some(c => c.universeId === 'borrower'));
  s.observe('returner-served-before-borrower-drains', { returned });
  traces.push(s.finish());
}
{
  const s = new Scenario('idle-return-credit-cap');
  s.add(candidate('before-idle', 'idle', 'interactive', 40));
  s.drain();
  for (let i = 0; i < 100; i++) s.tick();
  const lane = s.state.universeLanes['interactive:idle']!;
  assert.equal(lane.credit, 0, 'empty lane must lose positive credit');
  s.observe('after-100-empty-polls');
  s.add(candidate('after-idle', 'idle', 'interactive', 100));
  s.drain();
  assert.ok(s.state.universeLanes['interactive:idle']!.credit <= 200);
  s.observe('return-without-idle-windfall');
  traces.push(s.finish());
}
{
  const s = new Scenario('maximum-request-and-impossible-head');
  s.add(candidate('too-large', 'a', 'interactive', 101),
    candidate('max-valid', 'a', 'interactive', 100));
  s.drain();
  assert.ok(s.decisions.some(d => d.kind === 'impossible' && d.attemptId === 'attempt-too-large'));
  assert.equal(s.state.reservations['attempt-too-large'], undefined);
  assert.ok(s.state.reservations['attempt-max-valid']);
  s.observe('impossible-rejected-and-maximum-served');
  traces.push(s.finish());
}
{
  const s = new Scenario('unknown-call-hold-and-overload-deadline', fixturePolicy({ physical: [
    { key: 'budget', kind: 'budget', capacity: 100 },
    { key: 'rate', kind: 'rate', capacity: 100 },
    { key: 'remote', kind: 'remote', capacity: 1 },
  ] }));
  s.add(candidate('unknown', 'a', 'interactive', 50));
  s.tick();
  s.receipt('attempt-unknown', { receiptId: 'consumed', actual: {}, outcome: 'consumed' });
  s.receipt('attempt-unknown', { receiptId: 'unknown', actual: {}, outcome: 'unknown' });
  s.add({ ...candidate('waiting', 'b', 'interactive', 50), deadline: 10 });
  s.state = rolloverRateWindow(s.policy, s.state);
  s.events.push({ op: 'rate-rollover' });
  s.state = JSON.parse(JSON.stringify(s.state)) as FairnessSnapshot;
  s.events.push({ op: 'restart-from-snapshot' });
  s.tick({ now: 9 });
  assert.equal(s.state.reservations['attempt-waiting'], undefined);
  s.observe('after-rollover-and-restart-slot-still-held', s.state.reservations['attempt-unknown']);
  s.tick({ now: 11 });
  assert.ok(s.decisions.some(d => d.kind === 'deadline_missed' && d.attemptId === 'attempt-waiting'));
  s.receipt('attempt-unknown', { receiptId: 'terminal-unknown-usage', actual: {}, terminal: true });
  s.add(candidate('budget-blocked', 'c', 'interactive', 60));
  s.tick({ now: 12 });
  assert.equal(s.state.reservations['attempt-budget-blocked'], undefined);
  s.observe('terminal-frees-slot-but-retains-unknown-budget', s.state.reservations['attempt-unknown']);
  traces.push(s.finish());
}
{
  const s = new Scenario('estimate-correction-and-overage');
  s.add(candidate('under', 'under', 'interactive', 20));
  s.tick({ maxAdmissionsPerTick: 1 });
  const receipt: Receipt = { receiptId: 'actual-90', actual: { tokens: 90, budget: 90, rate: 90 }, terminal: true };
  s.receipt('attempt-under', receipt);
  assert.equal(s.state.reservations['attempt-under']!.settledCharge, 90);
  assert.ok(s.state.pausedDimensions.includes('budget'));
  const before = snapshotHash(s.state);
  s.receipt('attempt-under', receipt);
  assert.equal(snapshotHash(s.state), before);
  s.observe('underestimate-recorded-once-and-paused', s.state.reservations['attempt-under']);
  const refund = new Scenario('overestimate-cannot-refill-rate-window', fixturePolicy({ physical: [
    { key: 'budget', kind: 'budget', capacity: 1000 },
    { key: 'rate', kind: 'rate', capacity: 100 },
    { key: 'remote', kind: 'remote', capacity: 2 },
  ] }));
  refund.add(candidate('over', 'over', 'interactive', 100));
  refund.tick({ maxAdmissionsPerTick: 1 });
  refund.receipt('attempt-over', { receiptId: 'actual-10', actual: { tokens: 10, budget: 10, rate: 10 }, terminal: true });
  refund.add(candidate('later-rate', 'other', 'interactive', 10));
  refund.tick();
  assert.equal(refund.state.reservations['attempt-later-rate'], undefined);
  refund.observe('original-rate-reservation-still-consumed');
  refund.state = rolloverRateWindow(refund.policy, refund.state);
  refund.events.push({ op: 'rate-rollover' });
  refund.drain();
  assert.ok(refund.state.reservations['attempt-later-rate']);
  traces.push(s.finish(), refund.finish());
}
{
  const s = new Scenario('restart-mid-visit-and-receipt-replay');
  s.add(...jobs('replay-', 12, 'a', 'interactive', 40), candidate('replay-b', 'b', 'interactive', 100));
  s.tick({ maxAdmissionsPerTick: 1, maxScanPerTick: 2 });
  const original = s.state;
  const restored = JSON.parse(JSON.stringify(original)) as FairnessSnapshot;
  const limits = { maxAdmissionsPerTick: 1, maxScanPerTick: 2 };
  assert.deepEqual(scheduleTick(s.policy, original, limits), scheduleTick(s.policy, restored, limits));
  s.state = restored;
  s.events.push({ op: 'restart-from-snapshot' });
  s.tick(limits);
  const id = admitted(s.decisions)[0]!.attemptId!;
  const receipt: Receipt = { receiptId: 'replay-receipt', actual: { tokens: 20, budget: 20, rate: 20 }, terminal: true };
  s.receipt(id, receipt);
  const after = snapshotHash(s.state);
  s.receipt(id, receipt);
  assert.equal(snapshotHash(s.state), after);
  s.observe('same-continuation-and-idempotent-receipt');
  traces.push(s.finish());
}
{
  const s = new Scenario('bounded-blocked-scan');
  s.add(...Array.from({ length: 8 }, (_, i) => ({ ...candidate(`blocked-${i}`, `u${i}`), blocked: true })),
    candidate('ready-after-blocked', 'u9'));
  for (let tick = 0; tick < 100 && !s.state.reservations['attempt-ready-after-blocked']; tick++) {
    s.tick({ maxScanPerTick: 2, maxAdmissionsPerTick: 1 });
  }
  assert.ok(s.state.reservations['attempt-ready-after-blocked']);
  assert.equal(Object.keys(s.state.reservations).length, 1);
  s.observe('persistent-scan-found-ready-universe');
  traces.push(s.finish());
}
// Cross-resource normalization is a directly reproducible calculation, not a sum of unlike units.
const vectorPolicy = abundant({ normalized: [
  { key: 'requests', kind: 'requests', basis: 100 },
  { key: 'input', kind: 'tokens', basis: 100 },
  { key: 'output', kind: 'tokens', basis: 100 },
  { key: 'combined', kind: 'tokens', basis: 200 },
] });
assert.equal(normalizedCharge(vectorPolicy, { requests: 1, input: 90, output: 10, combined: 100 }), 90);
assert.equal(normalizedCharge(vectorPolicy, { requests: 1, input: 60, output: 60, combined: 120 }), 60);
console.log(JSON.stringify({ model: 'bounded-two-level-drr-v1', traces,
  traceSha256: createHash('sha256').update(JSON.stringify(traces)).digest('hex'),
  vectorNormalization: { policy: vectorPolicy, charges: [90, 60] },
}, null, 2));
