/**
 * #131 — adversarial cases for the pure bridge validator (packages/core/src/semantic). The read
 * set is a small synthetic substrate shaped like the editorial one (gravity, orbits, tides,
 * seasons, stars, homeostasis) so each rule is exercised in isolation: one justified directional
 * bridge, one justified analogy through a shared mechanism concept, and the tempting-but-unsupported
 * connections a keyword or "sounds right" heuristic would accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeProposalPayload, type BridgeProposalPayload } from '../packages/contracts/src/semantic.ts';
import {
  readSetFromRecord,
  sliceReadSet,
  validateBridgeProposal,
  type BridgeReadSet,
  type ReadSetClaim,
  type ReadSetConcept,
  type ReadSetRelation,
} from '../packages/core/src/semantic/bridge-validator.ts';

const concept = (code: string, name: string, description: string, parentCode: string | null = null): ReadSetConcept => ({ code, name, description, parentCode });
const claim = (key: string, concepts: ReadSetClaim['concepts'], status: ReadSetClaim['status'] = 'supported'): ReadSetClaim => ({ key, status, concepts });

function readSet(overrides: { claims?: ReadSetClaim[]; relations?: ReadSetRelation[]; admitted?: BridgeReadSet['admittedBridges'] } = {}): BridgeReadSet {
  const concepts = [
    concept('physics', 'Physics', 'Matter, energy and forces'),
    concept('physics.gravity', 'Gravity', 'The attraction between masses', 'physics'),
    concept('astro', 'Astronomy', 'Objects and motion beyond Earth'),
    concept('astro.orbit', 'Orbit', 'The curved path of one body around another', 'astro'),
    concept('astro.orbit.ellipse', 'Elliptical orbit', 'An orbit whose distance from the Sun changes', 'astro.orbit'),
    concept('astro.orbit.period_distance', 'Period and distance', 'A bigger orbit takes longer', 'astro.orbit'),
    concept('astro.star', 'Star', 'A ball of hot gas held together by gravity', 'astro'),
    concept('astro.star.equilibrium', 'Stellar balance', 'Gravity pulls in while pressure pushes out, a balance', 'astro.star'),
    concept('astro.star.lifetime_mass', 'Mass and lifetime', 'Bigger stars burn faster and live shorter lives', 'astro.star'),
    concept('earth', 'Earth science', 'Our planet'),
    concept('earth.tides', 'Tides', 'The regular rise and fall of the sea', 'earth'),
    concept('earth.seasons', 'Seasons', 'Yearly changes in temperature and daylight', 'earth'),
    concept('earth.seasons.axial_tilt', 'Axial tilt', 'Earth leans on its axis', 'earth.seasons'),
    concept('bio', 'Biology', 'Living things'),
    concept('bio.homeostasis', 'Homeostasis', 'Keeping internal conditions stable, a balance', 'bio'),
    concept('bio.homeostasis.negative_feedback', 'Negative feedback', 'A sensor detects change and an effector reverses it', 'bio.homeostasis'),
    concept('idea', 'Cross-domain ideas', 'Patterns that recur across fields'),
    concept('idea.equilibrium', 'Equilibrium', 'A steady state kept by opposing effects', 'idea'),
  ];
  const claims = overrides.claims ?? [
    claim('clm.gravity.tides', [{ code: 'physics.gravity', role: 'mechanism' }, { code: 'earth.tides', role: 'subject' }]),
    claim('clm.gravity.attraction', [{ code: 'physics.gravity', role: 'subject' }]),
    claim('clm.tides.cycle', [{ code: 'earth.tides', role: 'subject' }]),
    claim('clm.orbit.ellipse', [{ code: 'astro.orbit.ellipse', role: 'subject' }]),
    claim('clm.seasons.tilt', [{ code: 'earth.seasons', role: 'subject' }, { code: 'earth.seasons.axial_tilt', role: 'mechanism' }]),
    claim('clm.seasons.not_distance', [{ code: 'earth.seasons', role: 'subject' }, { code: 'astro.orbit.ellipse', role: 'context' }]),
    claim('clm.star.balance', [{ code: 'astro.star.equilibrium', role: 'subject' }, { code: 'idea.equilibrium', role: 'mechanism' }]),
    claim('clm.body.stable', [{ code: 'bio.homeostasis', role: 'subject' }, { code: 'idea.equilibrium', role: 'mechanism' }]),
    claim('clm.body.feedback', [{ code: 'bio.homeostasis.negative_feedback', role: 'mechanism' }, { code: 'bio.homeostasis', role: 'subject' }]),
    claim('clm.star.lifetime', [{ code: 'astro.star.lifetime_mass', role: 'subject' }]),
    claim('clm.orbit.period', [{ code: 'astro.orbit.period_distance', role: 'subject' }]),
    claim('clm.star.hot_gas', [{ code: 'astro.star', role: 'subject' }]),
    claim('clm.body.definition', [{ code: 'bio.homeostasis', role: 'subject' }]),
    claim('clm.orbit.path', [{ code: 'astro.orbit', role: 'subject' }]),
  ];
  const relations = overrides.relations ?? [
    { from: 'astro.orbit.ellipse', to: 'earth.seasons', kind: 'contradicts', claimKey: 'clm.seasons.not_distance', active: true },
  ];
  return {
    concepts: new Map(concepts.map(c => [c.code, c])),
    claims: new Map(claims.map(c => [c.key, c])),
    relations,
    admittedBridges: overrides.admitted ?? [],
  };
}

const none = { disposition: 'searched_none_found' as const, searchedScope: 'synthetic substrate', claimKeys: [] };

function proposal(p: Omit<BridgeProposalPayload, 'prerequisites' | 'counterevidence'> & Partial<Pick<BridgeProposalPayload, 'prerequisites' | 'counterevidence'>>): BridgeProposalPayload {
  // Every fixture must be schema-valid: a rejection below is the validator's, never the schema's.
  return bridgeProposalPayload.parse({
    prerequisites: [{ statement: 'Know that masses attract one another' }],
    counterevidence: none,
    ...p,
  });
}

const gravityExplainsTides = () => proposal({
  fromConcept: 'physics.gravity', toConcept: 'earth.tides', relationType: 'explains',
  mechanism: 'The Moon and Sun pull on Earth\'s oceans with gravity; the side nearest the Moon is pulled more strongly, so water bulges and each coast passes through the bulges as Earth turns.',
  limitations: [{ kind: 'scope_limit', statement: 'Local coastline shape changes the timing and height of tides' }],
  evidence: [
    { claimKey: 'clm.gravity.attraction', supports: 'from' },
    { claimKey: 'clm.tides.cycle', supports: 'to' },
    { claimKey: 'clm.gravity.tides', supports: 'mechanism' },
  ],
});

const equilibriumAnalogy = () => proposal({
  fromConcept: 'astro.star.equilibrium', toConcept: 'bio.homeostasis', relationType: 'analogous_in',
  mechanism: 'Both are steady states held by opposing effects: inward gravity against outward pressure in a star, and changes pushed back toward a stable range in a body.',
  limitations: [{ kind: 'analogy_limit', statement: 'A star has no sensor, set point or control centre; its balance is passive' }],
  evidence: [
    { claimKey: 'clm.star.hot_gas', supports: 'from' },
    { claimKey: 'clm.body.definition', supports: 'to' },
    { claimKey: 'clm.star.balance', supports: 'mechanism' },
    { claimKey: 'clm.body.stable', supports: 'mechanism' },
  ],
});

test('a directional bridge whose own evidence connects both sides is admitted', () => {
  const decision = validateBridgeProposal(gravityExplainsTides(), readSet());
  assert.equal(decision.outcome, 'admitted', JSON.stringify(decision));
  assert.deepEqual(decision.outcome === 'admitted' && decision.supportingClaimKeys, ['clm.gravity.attraction', 'clm.gravity.tides', 'clm.tides.cycle']);
});

test('an analogy is admitted through one shared mechanism concept named by evidence on each side', () => {
  const decision = validateBridgeProposal(equilibriumAnalogy(), readSet());
  assert.equal(decision.outcome, 'admitted', JSON.stringify(decision));
  assert.ok(decision.notes.some(n => n.includes('shared mechanism concept: idea.equilibrium')));
  assert.ok(decision.notes.some(n => n.includes('shared vocabulary (not evidence)')), 'the shared word "balance" is reported, not counted');
});

test('tempting: "the elliptical orbit explains the seasons" is refused as contradicted and unevidenced', () => {
  const tempting = proposal({
    fromConcept: 'astro.orbit.ellipse', toConcept: 'earth.seasons', relationType: 'explains',
    mechanism: 'Earth is closer to the Sun at some points of its elliptical orbit and farther at others, so the changing distance would make some months warmer than others.',
    limitations: [{ kind: 'scope_limit', statement: 'Both hemispheres would share one season' }],
    evidence: [
      { claimKey: 'clm.orbit.ellipse', supports: 'from' },
      { claimKey: 'clm.seasons.tilt', supports: 'to' },
      { claimKey: 'clm.orbit.ellipse', supports: 'mechanism' },
    ],
  });
  const decision = validateBridgeProposal(tempting, readSet());
  assert.equal(decision.outcome, 'rejected');
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('mechanism_unsupported'));
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('counterevidence_ignored'));
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('contradicted_by_substrate'));

  // Listing the counterevidence honestly does not rescue a contradicted directional claim.
  const honest = proposal({ ...tempting, counterevidence: { disposition: 'listed', searchedScope: 'synthetic substrate', claimKeys: ['clm.seasons.not_distance'] } });
  const second = validateBridgeProposal(honest, readSet());
  assert.ok(second.outcome === 'rejected' && second.reasons.includes('contradicted_by_substrate'));
  assert.ok(second.outcome === 'rejected' && !second.reasons.includes('counterevidence_ignored'));
});

test('tempting: size-and-time scaling words without a shared mechanism are refused', () => {
  const tempting = proposal({
    fromConcept: 'astro.star.lifetime_mass', toConcept: 'astro.orbit.period_distance', relationType: 'analogous_in',
    mechanism: 'In both, being bigger means a different pace of time: a heavier star lives a shorter life and a wider orbit takes a longer year, so size sets the clock in each case.',
    limitations: [{ kind: 'analogy_limit', statement: 'One is about fuel and the other about motion' }],
    evidence: [
      { claimKey: 'clm.star.hot_gas', supports: 'from' },
      { claimKey: 'clm.orbit.path', supports: 'to' },
      { claimKey: 'clm.star.lifetime', supports: 'mechanism' },
      { claimKey: 'clm.orbit.period', supports: 'mechanism' },
    ],
  });
  const decision = validateBridgeProposal(tempting, readSet());
  assert.deepEqual(decision.outcome === 'rejected' && decision.reasons, ['mechanism_unsupported']);
});

test('tempting: claiming the star regulates itself by feedback cites no star-side feedback evidence', () => {
  const tempting = proposal({
    fromConcept: 'astro.star.equilibrium', toConcept: 'bio.homeostasis.negative_feedback', relationType: 'compares_mechanism',
    mechanism: 'A star senses when it shrinks and switches its fusion up to push back out, the same negative feedback loop a body uses to hold its temperature near a set point.',
    limitations: [{ kind: 'analogy_limit', statement: 'The timescales differ enormously' }],
    evidence: [
      { claimKey: 'clm.star.balance', supports: 'from' },
      { claimKey: 'clm.body.definition', supports: 'to' },
      { claimKey: 'clm.body.feedback', supports: 'mechanism' },
    ],
  });
  const decision = validateBridgeProposal(tempting, readSet());
  assert.deepEqual(decision.outcome === 'rejected' && decision.reasons, ['mechanism_unsupported']);
});

test('a mechanism that only restates the names is a label', () => {
  const labelled = { ...gravityExplainsTides(), mechanism: 'Gravity explains tides. Gravity explains tides. Gravity explains the tides here.' };
  const decision = validateBridgeProposal(labelled, readSet());
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('mechanism_is_label'));
});

test('a parent and its child are depth, not a bridge', () => {
  const p = { ...gravityExplainsTides(), fromConcept: 'earth.seasons', toConcept: 'earth.seasons.axial_tilt' };
  const decision = validateBridgeProposal(p, readSet());
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('hierarchy_not_bridge'));
});

test('an explains bridge whose connecting claim does not make the explainer the mechanism is refused', () => {
  const reversed = readSet({ claims: [
    claim('clm.gravity.tides', [{ code: 'physics.gravity', role: 'subject' }, { code: 'earth.tides', role: 'object' }]),
    claim('clm.gravity.attraction', [{ code: 'physics.gravity', role: 'subject' }]),
    claim('clm.tides.cycle', [{ code: 'earth.tides', role: 'subject' }]),
  ] });
  const decision = validateBridgeProposal(gravityExplainsTides(), reversed);
  assert.deepEqual(decision.outcome === 'rejected' && decision.reasons, ['direction_unsupported']);
});

test('a claim that lost its current source support cannot be cited', () => {
  const corrected = readSet();
  const claims = new Map(corrected.claims);
  claims.set('clm.gravity.tides', { ...claims.get('clm.gravity.tides')!, status: 'unsupported' });
  const decision = validateBridgeProposal(gravityExplainsTides(), { ...corrected, claims });
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('evidence_unsupported'));
  assert.ok(decision.outcome === 'rejected' && decision.reasons.includes('mechanism_unsupported'));
});

test('unknown claims, unknown concepts and missing analogy limits are named', () => {
  const unresolved = { ...gravityExplainsTides(), evidence: [...gravityExplainsTides().evidence, { claimKey: 'clm.invented', supports: 'mechanism' as const }] };
  assert.ok((d => d.outcome === 'rejected' && d.reasons.includes('evidence_unresolved'))(validateBridgeProposal(unresolved, readSet())));
  const unknown = { ...gravityExplainsTides(), toConcept: 'earth.volcanoes' };
  assert.deepEqual((d => d.outcome === 'rejected' && d.reasons)(validateBridgeProposal(unknown, readSet())), ['concept_unknown']);
  const noLimit = { ...equilibriumAnalogy(), limitations: [{ kind: 'scope_limit' as const, statement: 'Only for main-sequence stars' }] };
  assert.ok((d => d.outcome === 'rejected' && d.reasons.includes('analogy_limit_missing'))(validateBridgeProposal(noLimit, readSet())));
});

test('a bridge already admitted (in either direction for a symmetric type) is a duplicate', () => {
  const admitted = [{ id: 'b1', fromConcept: 'bio.homeostasis', toConcept: 'astro.star.equilibrium', relationType: 'analogous_in' }];
  const decision = validateBridgeProposal(equilibriumAnalogy(), readSet({ admitted }));
  assert.deepEqual(decision.outcome === 'rejected' && decision.reasons, ['duplicate_admitted']);
});

test('the same proposal and read set always produce the same decision', () => {
  const a = validateBridgeProposal(equilibriumAnalogy(), readSet());
  const b = validateBridgeProposal(equilibriumAnalogy(), readSet());
  assert.deepEqual(a, b);
});

test('the recorded read-set slice re-derives exactly the decision the full substrate produced', () => {
  const cases = [gravityExplainsTides(), equilibriumAnalogy(),
    { ...gravityExplainsTides(), fromConcept: 'astro.orbit.ellipse', toConcept: 'earth.seasons' }];
  for (const p of cases) {
    const full = readSet({ admitted: [{ id: 'b0', fromConcept: 'physics.gravity', toConcept: 'earth.tides', relationType: 'explains' }] });
    const record = JSON.parse(JSON.stringify(sliceReadSet(p, full)));
    assert.deepEqual(validateBridgeProposal(p, readSetFromRecord(record)), validateBridgeProposal(p, full));
    assert.ok(record.concepts.length < full.concepts.size, 'the slice is smaller than the substrate');
  }
});

// --- Review of PR #140: loopholes a sound validator must close ------------------------------------

test('evidence never generalises upward: a claim about star birth cannot admit a bridge to stars in general', () => {
  const rs = readSet({ claims: [
    ...[...readSet().claims.values()],
    claim('clm.gravity.star_birth', [{ code: 'physics.gravity', role: 'mechanism' }, { code: 'astro.star.equilibrium', role: 'subject' }]),
  ] });
  const p = proposal({
    fromConcept: 'physics.gravity', toConcept: 'astro.star', relationType: 'explains',
    mechanism: 'Gravity pulls a cloud of gas inward until it is dense and hot enough, and that inward pull is what shapes every star from then on.',
    limitations: [{ kind: 'scope_limit', statement: 'Only the gravitational part of the story' }],
    evidence: [{ claimKey: 'clm.gravity.attraction', supports: 'from' }, { claimKey: 'clm.star.hot_gas', supports: 'to' }, { claimKey: 'clm.gravity.star_birth', supports: 'mechanism' }],
  });
  const d = validateBridgeProposal(p, rs);
  assert.ok(d.outcome === 'rejected' && d.reasons.includes('mechanism_unsupported'), JSON.stringify(d));
});

test('a claim that argues against the connection cannot also be cited for it', () => {
  const p = proposal({
    fromConcept: 'astro.orbit.ellipse', toConcept: 'earth.seasons', relationType: 'compares_mechanism',
    mechanism: 'Both the changing distance along an elliptical orbit and the seasons are yearly cycles, so the one might be read as the rhythm of the other.',
    limitations: [{ kind: 'analogy_limit', statement: 'The source says distance does not cause the seasons' }],
    evidence: [
      { claimKey: 'clm.orbit.ellipse', supports: 'from' }, { claimKey: 'clm.seasons.tilt', supports: 'to' },
      { claimKey: 'clm.seasons.not_distance', supports: 'mechanism' },
    ],
    counterevidence: { disposition: 'listed', searchedScope: 'synthetic substrate', claimKeys: ['clm.seasons.not_distance'] },
  });
  const d = validateBridgeProposal(p, readSet());
  assert.ok(d.outcome === 'rejected' && d.reasons.includes('counterevidence_cited_as_support'), JSON.stringify(d));
});

test('a contradiction stored in the opposite orientation still refuses a directional bridge', () => {
  const reversed = readSet({ relations: [{ from: 'earth.seasons', to: 'astro.orbit.ellipse', kind: 'contradicts', claimKey: 'clm.seasons.not_distance', active: true }] });
  const p = proposal({
    fromConcept: 'astro.orbit.ellipse', toConcept: 'earth.seasons', relationType: 'prerequisite_for',
    mechanism: 'Knowing that the distance to the Sun changes along the orbit would come first, and then the warmer and cooler months would follow from it.',
    limitations: [{ kind: 'scope_limit', statement: 'Only for the orbit of Earth' }],
    evidence: [{ claimKey: 'clm.orbit.ellipse', supports: 'from' }, { claimKey: 'clm.seasons.tilt', supports: 'to' }, { claimKey: 'clm.seasons.tilt', supports: 'mechanism' }],
    counterevidence: { disposition: 'listed', searchedScope: 'synthetic substrate', claimKeys: ['clm.seasons.not_distance'] },
  });
  const d = validateBridgeProposal(p, reversed);
  assert.ok(d.outcome === 'rejected' && d.reasons.includes('contradicted_by_substrate'), JSON.stringify(d));
});

test('"applies to" needs a typed relation of that kind; claim roles alone cannot say which direction was meant', () => {
  const claims = [...readSet().claims.values(), claim('clm.feedback.setpoint', [{ code: 'bio.homeostasis.negative_feedback', role: 'subject' }, { code: 'earth.tides', role: 'object' }])];
  const p = proposal({
    fromConcept: 'bio.homeostasis.negative_feedback', toConcept: 'earth.tides', relationType: 'applies_to',
    mechanism: 'The corrective loop of sensing a change and acting against it is used to describe how a coastline returns toward its usual water level.',
    limitations: [{ kind: 'scope_limit', statement: 'An illustration of the pattern, not a measured loop' }],
    evidence: [{ claimKey: 'clm.body.definition', supports: 'from' }, { claimKey: 'clm.tides.cycle', supports: 'to' }, { claimKey: 'clm.feedback.setpoint', supports: 'mechanism' }],
  });
  const without = validateBridgeProposal(p, readSet({ claims }));
  assert.ok(without.outcome === 'rejected' && without.reasons.includes('direction_unsupported'), JSON.stringify(without));
  const typed = readSet({ claims, relations: [
    { from: 'astro.orbit.ellipse', to: 'earth.seasons', kind: 'contradicts', claimKey: 'clm.seasons.not_distance', active: true },
    { from: 'bio.homeostasis', to: 'earth', kind: 'applies_to', claimKey: 'clm.feedback.setpoint', active: true },
  ] });
  assert.equal(validateBridgeProposal(p, typed).outcome, 'admitted');
  // The relation's own claim must be among the evidence, or a correction to it could not reach
  // this bridge: an uncited relation carries no direction.
  const uncited = readSet({ claims: [...claims, claim('clm.feedback.applies', [{ code: 'bio.homeostasis', role: 'subject' }, { code: 'earth', role: 'object' }])],
    relations: [{ from: 'bio.homeostasis', to: 'earth', kind: 'applies_to', claimKey: 'clm.feedback.applies', active: true }] });
  const d = validateBridgeProposal(p, uncited);
  assert.ok(d.outcome === 'rejected' && d.reasons.includes('direction_unsupported'), JSON.stringify(d));
});

test('one claim cannot be the whole case: each side needs a claim of its own besides the connecting one', () => {
  const lone = { ...gravityExplainsTides(), evidence: [
    { claimKey: 'clm.gravity.tides', supports: 'from' as const }, { claimKey: 'clm.gravity.tides', supports: 'to' as const }, { claimKey: 'clm.gravity.tides', supports: 'mechanism' as const },
  ] };
  const d = validateBridgeProposal(lone, readSet());
  assert.ok(d.outcome === 'rejected' && d.reasons.includes('from_side_unsupported') && d.reasons.includes('to_side_unsupported'), JSON.stringify(d));
});
