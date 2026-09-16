import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  createSnapshot,
  enqueue,
  rolloverRateWindow,
  scheduleTick,
  settle,
  snapshotHash,
  type Candidate,
  type FairnessClass,
  type FairnessPolicy,
} from '../scripts/fairness/model.ts';

const weights: Record<FairnessClass, number> = {
  interactive: 5,
  active_continuity: 6,
  accumulated_interpretation: 4,
  background_inquiry: 3,
  housekeeping: 2,
};

function policy(overrides: Partial<FairnessPolicy> = {}): FairnessPolicy {
  return {
    version: 'adversarial-v1',
    quantum: 100,
    maxNormalizedRequest: 100,
    scale: 100,
    maxReadySetSize: 128,
    maxScanPerTick: 128,
    maxAdmissionsPerTick: 32,
    normalized: [
      {key: 'tokens', kind: 'tokens', basis: 100},
      {key: 'requests', kind: 'requests', basis: 100},
    ],
    physical: [
      {key: 'budget', kind: 'budget', capacity: 100_000},
      {key: 'rate', kind: 'rate', capacity: 100_000},
      {key: 'remote', kind: 'remote', capacity: 100},
    ],
    weights,
    ...overrides,
  };
}

function work(id: string, universeId: string, klass: FairnessClass, tokens: number): Candidate {
  return {
    attemptId: `attempt-${id}`,
    reservationId: `reservation-${id}`,
    universeId,
    class: klass,
    enqueue: Number(id.replace(/\D/g, '')) || 1,
    basisVersion: 'adversarial-basis-v1',
    demand: {tokens, requests: 1, budget: tokens, rate: tokens, remote: 1},
  };
}

function addAll(policyValue: FairnessPolicy, candidates: Candidate[]) {
  return candidates.reduce((state, item) => enqueue(policyValue, state, item), createSnapshot(policyValue));
}

test('sustained unequal class service retains class quanta and equal universe turns', () => {
  const policyValue = policy();
  const candidates = (Object.keys(weights) as FairnessClass[]).flatMap((klass) => [
    ...Array.from({length: 10}, (_, index) => work(`${klass}-a-${index}`, `${klass}-a`, klass, 100)),
    ...Array.from({length: 10}, (_, index) => work(`${klass}-b-${index}`, `${klass}-b`, klass, 100)),
  ]);
  const result = scheduleTick(policyValue, addAll(policyValue, candidates), {
    maxAdmissionsPerTick: 20,
    maxScanPerTick: 128,
  });
  const admitted = result.decisions.filter((decision) => decision.kind === 'admitted');
  const byClass = Object.fromEntries((Object.keys(weights) as FairnessClass[]).map((klass) => [
    klass,
    admitted.filter((decision) => decision.class === klass).length,
  ]));
  assert.deepEqual(byClass, weights);
  for (const klass of Object.keys(weights) as FairnessClass[]) {
    const counts = ['a', 'b'].map((suffix) =>
      admitted.filter((decision) => decision.universeId === `${klass}-${suffix}`).length,
    );
    assert.ok(Math.abs(counts[0]! - counts[1]!) <= 1, `${klass} universe turns diverged: ${counts}`);
  }
});

test('a zero-credit maximum request earns its first DRR quantum instead of lending its class forever', () => {
  const policyValue = policy();
  const result = scheduleTick(policyValue, addAll(policyValue, [work('maximum', 'u', 'interactive', 100)]));
  assert.deepEqual(
    result.decisions.filter((decision) => decision.kind === 'admitted').map((decision) => decision.attemptId),
    ['attempt-maximum'],
  );
  assert.equal(result.snapshot.universeLanes['interactive:u']!.credit, 0);
});

test('refunds stay capped while small ticks preserve the outer visit', () => {
  const policyValue = policy({maxAdmissionsPerTick: 1, maxScanPerTick: 16});
  let state = addAll(policyValue, Array.from({length: 6}, (_, index) => work(`refund-${index}`, 'u', 'interactive', 40)));
  const admitted = [] as Array<{attemptId: string; visitGeneration: number | undefined}>;
  for (let index = 0; index < 6; index += 1) {
    const tick = scheduleTick(policyValue, state, {maxAdmissionsPerTick: 1, maxScanPerTick: 16});
    state = tick.snapshot;
    const decision = tick.decisions.find((item) => item.kind === 'admitted');
    assert.ok(decision, `small tick ${index} did not admit work`);
    admitted.push({attemptId: decision.attemptId!, visitGeneration: decision.visitGeneration});
    state = settle(policyValue, state, decision.attemptId!, {
      receiptId: `refund-receipt-${index}`,
      actual: {tokens: 1, requests: 1, budget: 1, rate: 1, remote: 1},
      terminal: true,
    }).snapshot;
  }
  assert.equal(new Set(admitted.slice(0, 5).map((item) => item.visitGeneration)).size, 1);
  assert.equal(admitted[5]!.visitGeneration, admitted[4]!.visitGeneration);
});

test('exact not-sent receipt replay is a no-op after the reservation closes', () => {
  const policyValue = policy();
  let state = scheduleTick(policyValue, addAll(policyValue, [work('not-sent', 'u', 'interactive', 40)])).snapshot;
  const receipt = {receiptId: 'exact-not-sent', actual: {}, outcome: 'not_sent' as const};
  state = settle(policyValue, state, 'attempt-not-sent', receipt).snapshot;
  const before = snapshotHash(state);
  const replay = settle(policyValue, state, 'attempt-not-sent', receipt);
  assert.equal(snapshotHash(replay.snapshot), before);
  assert.equal(replay.snapshot.reservations['attempt-not-sent']!.frozen, false);
});

test('unknown remote work retains the slot through a rate rollover and cannot be replay-refunded', () => {
  const policyValue = policy({
    physical: [
      {key: 'budget', kind: 'budget', capacity: 100},
      {key: 'rate', kind: 'rate', capacity: 100},
      {key: 'remote', kind: 'remote', capacity: 1},
    ],
  });
  let state = scheduleTick(policyValue, addAll(policyValue, [work('unknown', 'u-a', 'interactive', 40)])).snapshot;
  const receipt = {receiptId: 'unknown-original', actual: {}, outcome: 'unknown' as const};
  state = settle(policyValue, state, 'attempt-unknown', receipt).snapshot;
  const afterUnknown = snapshotHash(state);
  assert.equal(snapshotHash(settle(policyValue, state, 'attempt-unknown', receipt).snapshot), afterUnknown);
  state = rolloverRateWindow(policyValue, state);
  state = enqueue(policyValue, state, work('later', 'u-b', 'interactive', 40));
  const tick = scheduleTick(policyValue, state);
  assert.ok(tick.decisions.some((decision) => decision.reason === 'capacity:remote'));
  assert.equal(tick.snapshot.reservations['attempt-later'], undefined);
});
