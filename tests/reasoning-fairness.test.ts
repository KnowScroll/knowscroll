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

test('an unfinished inner turn survives an outer spend cap without another quantum', () => {
  const policy = abundantPolicy();
  let state = createSnapshot(policy);
  for (let i = 0; i < 14; i++) state = enqueue(policy, state, candidate(`inner-${i}`, 'u', 'accumulated_interpretation', 40));
  const admitted = [] as Array<{ innerGeneration?: number; visitGeneration?: number }>;
  let creditBeforeBoundary = 0;
  for (let i = 0; i < 13; i++) {
    if (i === 12) creditBeforeBoundary = state.universeLanes['accumulated_interpretation:u']!.credit;
    const result = scheduleTick(policy, state, {maxAdmissionsPerTick: 1, maxScanPerTick: 128});
    state = result.snapshot;
    const selection = result.decisions.find(d => d.kind === 'admitted')!;
    admitted.push(selection);
    state = settle(policy, state, selection.attemptId!, {
      receiptId: `inner-refund-${i}`, actual: {tokens: 1, budget: 1, rate: 1}, terminal: true,
    }).snapshot;
  }
  // Capped class spend is 500; twelve C40 reservations spend 480. The
  // third inner turn has spent only 80 of its 200 allowance, so it resumes
  // after the outer turn changes. Its credit must not earn another quantum.
  assert.ok(admitted[12]!.visitGeneration! > admitted[11]!.visitGeneration!);
  assert.equal(admitted[12]!.innerGeneration, admitted[11]!.innerGeneration);
  assert.equal(state.universeLanes['accumulated_interpretation:u']!.credit, creditBeforeBoundary - 1);
});

test('closed not_sent and terminal states cannot be reopened by a new receipt', () => {
  const policy = abundantPolicy();
  const base = scheduleTick(policy, enqueue(policy, createSnapshot(policy), candidate('closed', 'u'))).snapshot;
  const notSent = settle(policy, base, 'attempt-closed', {receiptId: 'ns', actual: {}, outcome: 'not_sent'}).snapshot;
  for (const outcome of ['consumed', 'unknown', 'terminal'] as const) {
    const result = settle(policy, notSent, 'attempt-closed', {receiptId: `bad-${outcome}`, actual: {}, outcome});
    assert.equal(result.snapshot.reservations['attempt-closed']!.status, 'not_sent');
    assert.equal(result.snapshot.reservations['attempt-closed']!.settledCharge, 0);
    assert.equal(result.snapshot.reservations['attempt-closed']!.frozen, true);
  }
  const terminal = settle(policy, base, 'attempt-closed', {receiptId: 'terminal', actual: {}, terminal: true}).snapshot;
  const contradicted = settle(policy, terminal, 'attempt-closed', {receiptId: 'consumed-again', actual: {}, outcome: 'consumed'});
  assert.equal(contradicted.snapshot.reservations['attempt-closed']!.status, 'terminal');
  assert.equal(contradicted.snapshot.reservations['attempt-closed']!.frozen, true);
});

test('policy binding applies to enqueue, settlement and rate rollover as well as selection', () => {
  const policy = abundantPolicy();
  const base = scheduleTick(policy, enqueue(policy, createSnapshot(policy), candidate('bound', 'u'))).snapshot;
  const changed = {...policy, scale: 50};
  assert.throws(() => enqueue(changed, base, candidate('new', 'v')), /policy_version_mismatch/);
  assert.throws(() => settle(changed, base, 'attempt-bound', {receiptId: 'r', actual: {}}), /policy_version_mismatch/);
  assert.throws(() => rolloverRateWindow(changed, base), /policy_version_mismatch/);
});

test('late original-window usage does not consume renewed rate capacity or release budget uncertainty', () => {
  const policy = fixturePolicy({physical: [
    {key: 'budget', kind: 'budget', capacity: 1000},
    {key: 'rate', kind: 'rate', capacity: 100},
    {key: 'remote', kind: 'remote', capacity: 2},
  ]});
  let state = scheduleTick(policy, enqueue(policy, createSnapshot(policy), candidate('old-window', 'a', 'interactive', 100))).snapshot;
  state = settle(policy, state, 'attempt-old-window', {receiptId: 'old-terminal', actual: {}, terminal: true}).snapshot;
  state = rolloverRateWindow(policy, state);
  state = settle(policy, state, 'attempt-old-window', {receiptId: 'late-usage', actual: {tokens: 80, rate: 80}}).snapshot;
  assert.equal(state.reservations['attempt-old-window']!.rateWindowId, 0);
  assert.equal(state.rateWindowId, 1);
  assert.equal(state.reservations['attempt-old-window']!.actual.budget, undefined);
  state = enqueue(policy, state, candidate('new-window', 'b', 'interactive', 100));
  state = scheduleTick(policy, state).snapshot;
  assert.ok(state.reservations['attempt-new-window']);
});

test('virtual time cannot regress or disappear between ticks, and empty probes count', () => {
  const policy = abundantPolicy();
  let state = enqueue(policy, createSnapshot(policy), {...candidate('delayed', 'u', 'housekeeping'), notBefore: 10});
  const first = scheduleTick(policy, state, {now: 5, maxScanPerTick: 1});
  state = first.snapshot;
  assert.equal(state.classCursor, 1);
  assert.ok(first.decisions.some(d => d.kind === 'scan_exhausted'));
  assert.throws(() => scheduleTick(policy, state, {now: 4}), /clock_regression/);
  assert.throws(() => scheduleTick(policy, state, {now: Number.NaN}), /invalid_now/);
  state = scheduleTick(policy, state).snapshot;
  assert.equal(state.now, 5);
  assert.equal(state.reservations['attempt-delayed'], undefined);
});

test('refund caps record discarded credit and do not bank a second windfall', () => {
  const policy = abundantPolicy();
  let state = createSnapshot(policy);
  for (let i = 0; i < 7; i++) state = enqueue(policy, state, candidate(`cap-${i}`, 'u', 'interactive', 100));
  state = scheduleTick(policy, state, {maxAdmissionsPerTick: 16, maxScanPerTick: 128}).snapshot;
  state = scheduleTick(policy, state).snapshot; // Empty lanes drop positive idle credit.
  let classDiscarded = 0, universeDiscarded = 0;
  for (let i = 0; i < 7; i++) {
    const result = settle(policy, state, `attempt-cap-${i}`, {
      receiptId: `cap-refund-${i}`, actual: {tokens: 1, budget: 1, rate: 1}, terminal: true,
    });
    state = result.snapshot;
    classDiscarded += result.decisions[0]!.classRefundDiscarded!;
    universeDiscarded += result.decisions[0]!.universeRefundDiscarded!;
  }
  assert.equal(state.classLanes.interactive.credit, 600);
  assert.equal(state.universeLanes['interactive:u']!.credit, 200);
  assert.equal(classDiscarded, 93);
  assert.equal(universeDiscarded, 493);
});
