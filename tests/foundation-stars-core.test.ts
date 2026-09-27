/**
 * #131/#134 — foundation Stars (target 07 §1, ADR-0037): a live place becomes load-bearing only when
 * its anchor explains, or is a prerequisite for, at least three things across at least two of the
 * reader's other live places, each connection sourced. Edge count triggers it; attention never does.
 * It is withdrawn, with its cause, when that stops being true.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFoundations, planPlaces, planRejection, type ConceptNode, type PlaceAccount, type PlaceView, type TypedRelation } from '../packages/core/src/atlas/cartographer.ts';

const concepts: ConceptNode[] = ['physics.gravity', 'earth.tides', 'astro.orbit', 'astro.star.birth', 'idea.other'].map(code => ({ code, parent: null, name: code }));
const rel = (to: string, kind: TypedRelation['kind'] = 'explains', ref: TypedRelation['ref'] = { claimId: `claim-${to}` }): TypedRelation => ({ from: 'physics.gravity', to, kind, ref });
const relations: TypedRelation[] = [rel('earth.tides'), rel('astro.orbit'), rel('astro.star.birth'), rel('astro.orbit', 'prerequisite_for', { claimId: 'claim-orbit-pre' })];
const account = (concept: string): PlaceAccount => ({ concept, state: 'anchored', episodes: 5, daysActive: 3, voluntary: 3, sourceFamilies: 2, mass: 9, evidence: { episodeIds: ['e'], markIds: ['m'] } });
const planet = (anchor: string, extra: Partial<PlaceView> = {}): PlaceView => ({ placeId: `p-${anchor}`, anchor, kind: 'planet', parentAnchor: null, state: 'live', basis: null, ...extra });
const plan = (places: PlaceView[], rels = relations) => planPlaces({ concepts, relations: rels, accounts: places.map(p => account(p.anchor)), places, rejectedAnchors: [] });
const foundations = (deltas: ReturnType<typeof planPlaces>) => deltas.filter(d => d.kind === 'foundation_recognised' || d.kind === 'foundation_withdrawn');

test('three sourced connections across two of the reader\'s places make a foundation, with what it holds up as evidence', () => {
  const deltas = foundations(plan([planet('physics.gravity'), planet('earth.tides'), planet('astro.orbit')]));
  assert.equal(deltas.length, 1);
  const d = deltas[0]!;
  assert.equal(d.kind, 'foundation_recognised');
  assert.equal(d.anchor, 'physics.gravity');
  assert.equal(d.causalClass, 'substrate_neighbourhood');
  assert.deepEqual(d.kind === 'foundation_recognised' && d.evidence.holdsUp, ['astro.orbit', 'earth.tides']);
  assert.equal(d.kind === 'foundation_recognised' && d.evidence.relations.length, 3);
});

test('edge count alone is not enough: fewer than two places, or fewer than three connections, is no foundation', () => {
  assert.deepEqual(foundations(plan([planet('physics.gravity'), planet('astro.orbit')])), [], 'two connections, one place');
  assert.deepEqual(foundations(plan([planet('physics.gravity'), planet('earth.tides'), planet('astro.orbit')], [rel('earth.tides'), rel('astro.orbit')])), [], 'two connections, two places');
  // A claim and a bridge for the same connection count once.
  assert.deepEqual(foundations(plan([planet('physics.gravity'), planet('earth.tides'), planet('astro.orbit')],
    [rel('earth.tides'), rel('earth.tides', 'explains', { bridgeId: 'b1' }), rel('astro.orbit')])), []);
  // Direction matters: being explained by others is not holding them up.
  const reversed = relations.map(r => ({ ...r, from: r.to, to: r.from }));
  assert.deepEqual(foundations(plan([planet('physics.gravity'), planet('earth.tides'), planet('astro.orbit')], reversed)), []);
  // Sightings are not places the foundation holds up.
  // (The sighting has no attention account: it has not been met, so it is not promoted.)
  const withSighting: PlaceView[] = [planet('physics.gravity'), planet('earth.tides'), { ...planet('astro.orbit'), kind: 'sighting', parentAnchor: 'physics.gravity', basis: rel('astro.orbit') }];
  assert.deepEqual(foundations(planPlaces({ concepts, relations, accounts: [account('physics.gravity'), account('earth.tides')], places: withSighting, rejectedAnchors: [] })), []);
});

test('a foundation is withdrawn when what it held up goes: a revoked source, or a place set aside', () => {
  const standing = planet('physics.gravity', { loadBearing: true, foundationBasis: [rel('earth.tides'), rel('astro.orbit'), rel('astro.orbit', 'prerequisite_for', { claimId: 'claim-orbit-pre' })] });
  const revoked = foundations(plan([standing, planet('earth.tides'), planet('astro.orbit')], [rel('earth.tides'), rel('astro.orbit')]));
  assert.deepEqual(revoked.map(d => [d.kind, d.causalClass]), [['foundation_withdrawn', 'source_correction']]);
  const setAside = foundations(plan([standing, planet('earth.tides')]));
  assert.deepEqual(setAside.map(d => [d.kind, d.causalClass]), [['foundation_withdrawn', 'reader_correction']]);
  assert.deepEqual(foundations(plan([standing, planet('earth.tides'), planet('astro.orbit')])), [], 'still standing: nothing changes');
});

test('only explaining or coming before counts: other typed connections never make a foundation', () => {
  const places = [planet('physics.gravity'), planet('earth.tides'), planet('astro.orbit'), planet('astro.star.birth')];
  for (const kind of ['contradicts', 'analogous_in', 'applies_to', 'compares_mechanism'] as const) {
    const others = ['earth.tides', 'astro.orbit', 'astro.star.birth'].map(to => rel(to, kind, { claimId: `claim-${kind}-${to}` }));
    assert.deepEqual(foundations(plan(places, others)), [], kind);
  }
});

test('a standing foundation is re-recorded when its connections change: it grows, a held-up place goes, or a source changes', () => {
  const basis = [rel('earth.tides'), rel('astro.orbit'), rel('astro.orbit', 'prerequisite_for', { claimId: 'claim-orbit-pre' })];
  const standing = planet('physics.gravity', { loadBearing: true, foundationBasis: basis });
  const holdsUp = (d: ReturnType<typeof planPlaces>[number]) => (d.kind === 'foundation_recognised' ? d.evidence.holdsUp : null);
  // It grows: Star formation becomes one of the reader's places.
  const grown = foundations(plan([standing, planet('earth.tides'), planet('astro.orbit'), planet('astro.star.birth')]));
  assert.deepEqual(grown.map(d => [d.kind, d.causalClass]), [['foundation_recognised', 'substrate_neighbourhood']]);
  assert.deepEqual(holdsUp(grown[0]!), ['astro.orbit', 'astro.star.birth', 'earth.tides']);
  // A held-up place goes, but three connections across two places remain (review I1a).
  const four = planet('physics.gravity', { loadBearing: true, foundationBasis: [...basis, rel('astro.star.birth')] });
  const reduced = foundations(plan([four, planet('astro.orbit'), planet('astro.star.birth')]));
  assert.deepEqual(reduced.map(d => [d.kind, d.causalClass]), [['foundation_recognised', 'reader_correction']]);
  assert.deepEqual(holdsUp(reduced[0]!), ['astro.orbit', 'astro.star.birth']);
  // A claim is revoked but a bridge keeps the connection: the bridge is what is cited now (review I1b).
  const bridged = [rel('earth.tides', 'explains', { bridgeId: 'b-tides' }), rel('astro.orbit'), rel('astro.orbit', 'prerequisite_for', { claimId: 'claim-orbit-pre' })];
  const corrected = foundations(plan([standing, planet('earth.tides'), planet('astro.orbit')], bridged));
  assert.deepEqual(corrected.map(d => [d.kind, d.causalClass]), [['foundation_recognised', 'source_correction']]);
  assert.ok(corrected[0]!.kind === 'foundation_recognised' && corrected[0]!.evidence.relations.some(r => 'bridgeId' in r.ref));
});

test('the foundation step alone plans only foundation changes (what setting a place aside re-evaluates)', () => {
  const deltas = planFoundations({ relations, places: [planet('physics.gravity'), planet('earth.tides'), planet('astro.orbit')] });
  assert.deepEqual(deltas.map(d => [d.kind, d.anchor]), [['foundation_recognised', 'physics.gravity']]);
  // An anchored-looking neighbour with no place is not the foundation step's business.
  assert.deepEqual(planFoundations({ relations, places: [planet('earth.tides')] }), []);
});

test('setting a foundation itself aside withdraws it first, as the reader\'s correction (review M1)', () => {
  const standing = planet('physics.gravity', { loadBearing: true, foundationBasis: [rel('earth.tides'), rel('astro.orbit'), rel('astro.orbit', 'prerequisite_for', { claimId: 'claim-orbit-pre' })] });
  const deltas = planRejection([standing, planet('earth.tides'), planet('astro.orbit')], 'p-physics.gravity');
  assert.deepEqual(deltas.map(d => [d.kind, d.causalClass]), [['foundation_withdrawn', 'reader_correction'], ['place_rejected', 'reader_correction']]);
  // Its evidence says the foundation itself was set aside, not that it lost connections.
  assert.equal(deltas[0]!.kind === 'foundation_withdrawn' && deltas[0]!.evidence.setAside, true);
});
