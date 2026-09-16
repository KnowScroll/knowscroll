import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  createSnapshot,
  enqueue,
  normalizedCharge,
  rolloverRateWindow,
  scheduleTick,
  settle,
  snapshotHash,
} from '../scripts/fairness/model.ts';
import {candidate, fixturePolicy, runScenario} from '../scripts/fairness/scenarios.ts';

function abundantPolicy() {
  return fixturePolicy({physical: [
    {key: 'budget', kind: 'budget', capacity: 100_000},
    {key: 'rate', kind: 'rate', capacity: 100_000},
    {key: 'remote', kind: 'remote', capacity: 100},
  ]});
}

test('charge is exact integer dominant share and admissions reject only M-sized excess', () => {
  const policy = abundantPolicy();
  assert.equal(normalizedCharge(policy, {tokens: 1, requests: 1}), 1);
  assert.equal(normalizedCharge(policy, {tokens: 51, requests: 1}), 51);
  assert.throws(() => normalizedCharge(policy, {tokens: 101, requests: 1}), /permanently_impossible_charge/);
  assert.equal(normalizedCharge(policy, {tokens: 101, requests: 1}, false), 101);
});

test('five class quanta are granted once, without squared class weights', () => {
  const policy = abundantPolicy();
  const work = [
    ...Array.from({length: 8}, (_, i) => candidate(`i${i}`, 'u-i', 'interactive', 100)),
    ...Array.from({length: 8}, (_, i) => candidate(`a${i}`, 'u-a', 'active_continuity', 100)),
    ...Array.from({length: 8}, (_, i) => candidate(`c${i}`, 'u-c', 'accumulated_interpretation', 100)),
    ...Array.from({length: 8}, (_, i) => candidate(`b${i}`, 'u-b', 'background_inquiry', 100)),
    ...Array.from({length: 8}, (_, i) => candidate(`h${i}`, 'u-h', 'housekeeping', 100)),
  ];
  let state = createSnapshot(policy);
  for (const item of work) state = enqueue(policy, state, item);
  const result = scheduleTick(policy, state, {maxAdmissionsPerTick: 20, maxScanPerTick: 64});
  const counts = new Map<string, number>();
  for (const decision of result.decisions.filter(d => d.kind === 'admitted')) {
    const klass = work.find(w => w.attemptId === decision.attemptId)!.class;
    counts.set(klass, (counts.get(klass) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), {
    interactive: 5, active_continuity: 6, accumulated_interpretation: 4,
    background_inquiry: 3, housekeeping: 2,
  });
});

test('an open visit survives small tick limits and cannot mint another quantum', () => {
  const policy = abundantPolicy();
  let state = enqueue(policy, createSnapshot(policy), candidate('1', 'u', 'interactive', 100));
  state = enqueue(policy, state, candidate('2', 'u', 'interactive', 100));
  state = scheduleTick(policy, state, {maxAdmissionsPerTick: 1, maxScanPerTick: 2}).snapshot;
  assert.equal(state.classLanes.interactive.credit, 400);
  state = scheduleTick(policy, state, {maxAdmissionsPerTick: 1, maxScanPerTick: 2}).snapshot;
  assert.equal(state.classLanes.interactive.credit, 300);
});

test('deterministic snapshot replay retains cursors, credits, and selection trace', () => {
  const policy = abundantPolicy();
  const work = [candidate('1', 'u-a'), candidate('2', 'u-b'), candidate('3', 'u-a', 'housekeeping')];
  const first = runScenario(policy, work, 4);
  const second = runScenario(policy, [...work].reverse(), 4);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.decisions, second.decisions);
  assert.equal(snapshotHash(first.snapshot), first.hash);
});

test('blocked work earns no quantum and another universe still makes progress', () => {
  const policy = abundantPolicy();
  let state = enqueue(policy, createSnapshot(policy), {...candidate('blocked', 'u-a'), blocked: true});
  state = enqueue(policy, state, candidate('ready', 'u-b'));
  const result = scheduleTick(policy, state);
  assert.ok(result.decisions.some(d => d.attemptId === 'attempt-ready' && d.kind === 'admitted'));
  assert.equal(result.snapshot.classLanes.interactive.credit, 0);
});

test('a physically impossible request is explicit while transient capacity is merely blocked', () => {
  const policy = fixturePolicy({physical: [{key: 'budget', kind: 'budget', capacity: 100}, {key: 'rate', kind: 'rate', capacity: 100}, {key: 'remote', kind: 'remote', capacity: 1}]});
  let state = enqueue(policy, createSnapshot(policy), {...candidate('impossible', 'u', 'interactive', 50), demand: {tokens: 50, requests: 1, budget: 101, rate: 50, remote: 1}});
  const result = scheduleTick(policy, state);
  assert.ok(result.decisions.some(d => d.kind === 'impossible'));
});

test('estimate correction refunds only retained lanes and overage creates debt and pause', () => {
  const policy = abundantPolicy();
  let state = enqueue(policy, createSnapshot(policy), candidate('1', 'u', 'interactive', 100));
  state = scheduleTick(policy, state).snapshot;
  state = settle(policy, state, 'attempt-1', {receiptId: 'r1', actual: {tokens: 40, requests: 1, budget: 120, rate: 120, remote: 1}, terminal: true}).snapshot;
  assert.equal(state.classLanes.interactive.credit, 460);
  assert.ok(state.pausedDimensions.includes('budget'));
  const before = snapshotHash(state);
  assert.equal(snapshotHash(settle(policy, state, 'attempt-1', {receiptId: 'r1', actual: {tokens: 40, requests: 1, budget: 120, rate: 120, remote: 1}, terminal: true}).snapshot), before);
});

test('possible dispatch cannot be closed as not_sent and contradictory receipts freeze', () => {
  const policy = abundantPolicy();
  let state = enqueue(policy, createSnapshot(policy), candidate('1', 'u'));
  state = scheduleTick(policy, state).snapshot;
  state = settle(policy, state, 'attempt-1', {receiptId: 'consumed', actual: {}, outcome: 'consumed'}).snapshot;
  const frozen = settle(policy, state, 'attempt-1', {receiptId: 'not-sent', actual: {}, outcome: 'not_sent'});
  assert.equal(frozen.snapshot.reservations['attempt-1']!.frozen, true);
});

test('unknown remote hold survives rate rollover, while rate is the only released dimension', () => {
  const policy = fixturePolicy({physical: [{key: 'budget', kind: 'budget', capacity: 100}, {key: 'rate', kind: 'rate', capacity: 100}, {key: 'remote', kind: 'remote', capacity: 1}]});
  let state = enqueue(policy, createSnapshot(policy), candidate('1', 'u', 'interactive', 50));
  state = scheduleTick(policy, state).snapshot;
  state = settle(policy, state, 'attempt-1', {receiptId: 'unknown', actual: {}, outcome: 'unknown'}).snapshot;
  state = rolloverRateWindow(policy, state);
  state = enqueue(policy, state, candidate('2', 'v', 'interactive', 50));
  const result = scheduleTick(policy, state);
  assert.ok(result.decisions.some(d => d.reason === 'capacity:remote'));
});

test('finite ready and scan bounds reject excess and expose scan exhaustion without mutation', () => {
  const policy = abundantPolicy();
  let state = createSnapshot(policy);
  for (let i = 0; i < 64; i += 1) state = enqueue(policy, state, candidate(`${i}`, `u-${i}`, 'interactive', 100));
  assert.throws(() => enqueue(policy, state, candidate('over', 'u-over')), /ready_set_bound/);
  const result = scheduleTick(policy, state, {maxScanPerTick: 1, maxAdmissionsPerTick: 1});
  assert.ok(result.decisions.length > 0);
});

test('a policy basis mutation cannot reuse a same-version fairness snapshot', () => {
  const policy = abundantPolicy();
  const snapshot = createSnapshot(policy);
  const changed = fixturePolicy({normalized: [{key: 'tokens', kind: 'tokens', basis: 200}, {key: 'requests', kind: 'requests', basis: 100}]});
  assert.throws(() => scheduleTick(changed, snapshot), /policy_version_mismatch/);
});

test('expired work is recorded before a saturated physical gate can hide it', () => {
  const policy = fixturePolicy({physical: [{key: 'budget', kind: 'budget', capacity: 100}, {key: 'rate', kind: 'rate', capacity: 100}, {key: 'remote', kind: 'remote', capacity: 1}]});
  let state = enqueue(policy, createSnapshot(policy), {...candidate('expired', 'u'), deadline: 10});
  state = enqueue(policy, state, candidate('hold', 'v'));
  state = scheduleTick(policy, state).snapshot;
  const result = scheduleTick(policy, enqueue(policy, state, {...candidate('late', 'w'), deadline: 10}), {now: 20});
  assert.ok(result.decisions.some(d => d.kind === 'deadline_missed' && d.attemptId === 'attempt-late'));
});
