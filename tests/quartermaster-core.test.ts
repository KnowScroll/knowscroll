/**
 * #164 — the pure Quartermaster (`quartermaster-v1`, ADR-0046 §2): each decision from the facts that
 * make it — reuse a Scroll this reader was never shown, join an open request, fund one from unwritten
 * material, or say why the need cannot be met — and adapt recorded as having no v1 path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDemand, QUARTERMASTER_V1, type DemandFacts } from '../packages/core/src/inventory/quartermaster.ts';

const parents = new Map<string, string | null>([
  ['earth', null], ['earth.tides', 'earth'], ['earth.tides.spring', 'earth.tides'], ['physics.gravity', null],
]);

const facts = (over: Partial<DemandFacts> = {}): DemandFacts => ({
  concept: 'earth.tides', parents, scrolls: [], openRequestId: null, route: { id: 'route-v1', requestsLeft: 3 },
  candidates: [{ id: 'cand-1', conceptCodes: ['earth.tides', 'physics.gravity'], requested: false }], settled: [],
  ...over,
});

test('reuse: an eligible Scroll in the subtree this reader was never shown, the newest first', () => {
  const scrolls = [
    { assetId: 'written', primary: 'earth.tides.spring', shown: false },
    { assetId: 'older', primary: 'earth.tides', shown: false },
    { assetId: 'outside', primary: 'physics.gravity', shown: false },
  ];
  assert.deepEqual(decideDemand(facts({ scrolls, openRequestId: 'req-1' })),
    { version: QUARTERMASTER_V1, adapt: 'unavailable', decision: 'reuse', assetId: 'written' });
  // Shown to this reader is not reusable, however suitable; another concept's Scroll is not this need.
  const seen = scrolls.map(s => ({ ...s, shown: s.assetId !== 'outside' }));
  assert.equal(decideDemand(facts({ scrolls: seen })).decision, 'fund');
});

test('join: a shared request for the same concept is already open', () => {
  assert.deepEqual(decideDemand(facts({ openRequestId: 'req-1' })),
    { version: QUARTERMASTER_V1, adapt: 'unavailable', decision: 'join', requestId: 'req-1' });
  // Joining costs nothing, so neither a spent budget nor a missing route stops it.
  assert.equal(decideDemand(facts({ openRequestId: 'req-1', route: null })).decision, 'join');
});

test('fund: unwritten material for the concept, offering only its concepts within the subtree', () => {
  const decision = decideDemand(facts({
    candidates: [
      { id: 'written-before', conceptCodes: ['earth.tides'], requested: true },
      { id: 'elsewhere', conceptCodes: ['physics.gravity'], requested: false },
      { id: 'cand-2', conceptCodes: ['physics.gravity', 'earth.tides.spring', 'earth.tides'], requested: false },
    ],
  }));
  assert.deepEqual(decision, { version: QUARTERMASTER_V1, adapt: 'unavailable', decision: 'fund', candidateId: 'cand-2', offeredCodes: ['earth.tides.spring', 'earth.tides'] });
  // A refused request lets the Quartermaster fund the next candidate once.
  assert.equal(decideDemand(facts({ settled: ['refused'] })).decision, 'fund');
});

test('cannot meet, with the reason that stops it', () => {
  const reason = (over: Partial<DemandFacts>) => {
    const d = decideDemand(facts(over));
    return d.decision === 'cannot_meet' ? d.reason : d.decision;
  };
  assert.equal(reason({ route: null }), 'no_route');
  assert.equal(reason({ route: { id: 'route-v1', requestsLeft: 0 } }), 'no_budget');
  assert.equal(reason({ candidates: [] }), 'no_material');
  assert.equal(reason({ candidates: [{ id: 'cand-1', conceptCodes: ['earth.tides'], requested: true }] }), 'no_material');
  assert.equal(reason({ settled: ['refused', 'refused'] }), 'checks_failed');
  // A request whose one send was lost or failed is never followed by another for this demand.
  assert.equal(reason({ settled: ['failed'] }), 'request_failed');
  // No route outranks everything after it: nothing can be written without one.
  assert.equal(reason({ route: null, candidates: [], settled: ['failed'] }), 'no_route');
  assert.equal(reason({ route: { id: 'route-v1', requestsLeft: 0 }, settled: ['refused', 'refused'] }), 'no_budget');
});

test('the same facts always give the same decision, and adapt has no v1 path', () => {
  const f = facts({ scrolls: [{ assetId: 'b', primary: 'earth.tides', shown: false }, { assetId: 'a', primary: 'earth.tides', shown: false }] });
  assert.deepEqual(decideDemand(f), decideDemand(f));
  for (const over of [{}, { openRequestId: 'r' }, { route: null }]) assert.equal(decideDemand(facts(over)).adapt, 'unavailable');
});
