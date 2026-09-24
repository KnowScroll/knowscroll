/**
 * ADR-0036 — the pure Cartographer: anchored concepts become planets or regions, typed relations
 * offer sightings, corrections retire them, and a reader's rejection is final. No I/O.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CARTOGRAPHER_V1, planPlaces, planRejection,
  type CartographerInput, type ConceptNode, type PlaceView, type PlaceAccount, type TypedRelation,
} from '../packages/core/src/atlas/cartographer.ts';

const concepts: ConceptNode[] = [
  { code: 'earth', parent: null, name: 'Earth' },
  { code: 'earth.ocean', parent: 'earth', name: 'Ocean' },
  { code: 'earth.ocean.tides', parent: 'earth.ocean', name: 'Tides' },
  { code: 'earth.ocean.tides.spring', parent: 'earth.ocean.tides', name: 'Spring tides' },
  { code: 'astro', parent: null, name: 'Astronomy' },
  { code: 'astro.moon', parent: 'astro', name: 'The Moon' },
  { code: 'physics', parent: null, name: 'Physics' },
  { code: 'physics.gravity', parent: 'physics', name: 'Gravity' },
  { code: 'physics.resonance', parent: 'physics', name: 'Resonance' },
];
const relations: TypedRelation[] = [
  { from: 'physics.gravity', to: 'earth.ocean.tides', kind: 'explains', ref: { claimId: 'claim-g-t' } },
  { from: 'astro.moon', to: 'earth.ocean.tides', kind: 'explains', ref: { bridgeId: 'bridge-m-t' } },
  { from: 'physics.resonance', to: 'earth.ocean.tides', kind: 'analogous_in', ref: { claimId: 'claim-r-t' } },
  { from: 'physics.gravity', to: 'astro.moon', kind: 'explains', ref: { claimId: 'claim-g-m' } },
];
const anchored = (concept: string, extra: Partial<PlaceAccount> = {}): PlaceAccount => ({
  concept, state: 'anchored', episodes: 4, daysActive: 2, voluntary: 2, sourceFamilies: 2, mass: 5.2,
  evidence: { episodeIds: [`e-${concept}-1`, `e-${concept}-2`], markIds: [`m-${concept}`] }, ...extra,
});
const seen = (concept: string): PlaceAccount => ({ ...anchored(concept), state: 'seen', mass: 1 });
const input = (over: Partial<CartographerInput> = {}): CartographerInput => ({
  concepts, relations, accounts: [], places: [], rejectedAnchors: [], ...over,
});

test('an anchored concept with no anchored ancestor becomes a free planet, with its account as evidence', () => {
  const plan = planPlaces(input({ accounts: [anchored('earth.ocean.tides')] }));
  const formed = plan.filter(d => d.kind === 'place_formed');
  assert.equal(formed.length, 1);
  assert.deepEqual({ ...formed[0], evidence: undefined }, { kind: 'place_formed', causalClass: 'personal_exploration', anchor: 'earth.ocean.tides', placeKind: 'planet', parentAnchor: null, evidence: undefined, policyVersion: CARTOGRAPHER_V1 });
  assert.deepEqual(formed[0]!.evidence, { account: { state: 'anchored', episodes: 4, daysActive: 2, voluntary: 2, sourceFamilies: 2, mass: 5.2, episodeIds: ['e-earth.ocean.tides-1', 'e-earth.ocean.tides-2'], markIds: ['m-earth.ocean.tides'] } });
});

test('a concept whose ancestor within two hops is already a place becomes its region; shallower concepts are placed first', () => {
  const plan = planPlaces(input({ accounts: [anchored('earth.ocean.tides.spring'), anchored('earth.ocean')] }));
  const formed = plan.filter(d => d.kind === 'place_formed');
  assert.deepEqual(formed.map(d => [d.anchor, d.kind === 'place_formed' && d.placeKind, d.parentAnchor]), [
    ['earth.ocean', 'planet', null],
    ['earth.ocean.tides.spring', 'region', 'earth.ocean'],
  ]);
  // Three hops away is too far: a free planet.
  const far = planPlaces(input({ accounts: [anchored('earth.ocean.tides.spring')], places: [{ placeId: 'p-earth', anchor: 'earth', kind: 'planet', parentAnchor: null, state: 'live', basis: null }] }));
  assert.deepEqual(far.filter(d => d.kind === 'place_formed').map(d => d.parentAnchor), [null]);
});

test('only anchored accounts form places; existing and rejected anchors never form again', () => {
  assert.equal(planPlaces(input({ accounts: [seen('earth.ocean.tides')] })).length, 0);
  const existing: PlaceView = { placeId: 'p1', anchor: 'earth.ocean.tides', kind: 'planet', parentAnchor: null, state: 'live', basis: null };
  assert.equal(planPlaces(input({ accounts: [anchored('earth.ocean.tides')], places: [existing] })).filter(d => d.kind === 'place_formed').length, 0);
  assert.equal(planPlaces(input({ accounts: [anchored('earth.ocean.tides')], rejectedAnchors: ['earth.ocean.tides'] })).length, 0);
});

test('a place offers sightings one typed relation away that the reader has never been shown, capped and ranked by degree', () => {
  const plan = planPlaces(input({ accounts: [anchored('earth.ocean.tides'), seen('physics.resonance')] }));
  const sightings = plan.filter(d => d.kind === 'sighting_appeared');
  // The Moon and Gravity tie on degree (2), so code order decides; Resonance was already shown.
  assert.deepEqual(sightings.map(d => d.anchor), ['astro.moon', 'physics.gravity']);
  assert.ok(sightings.every(d => d.parentAnchor === 'earth.ocean.tides' && d.causalClass === 'substrate_neighbourhood'));
  const moon = sightings.find(d => d.anchor === 'astro.moon')!;
  assert.deepEqual(moon.kind === 'sighting_appeared' && moon.evidence, { relation: { from: 'astro.moon', to: 'earth.ocean.tides', kind: 'explains', ref: { bridgeId: 'bridge-m-t' } } });
  // The hierarchy is not a sighting relation; a sighting is not offered twice.
  const again = planPlaces(input({
    accounts: [anchored('earth.ocean.tides')],
    places: [
      { placeId: 'p1', anchor: 'earth.ocean.tides', kind: 'planet', parentAnchor: null, state: 'live', basis: null },
      { placeId: 's1', anchor: 'astro.moon', kind: 'sighting', parentAnchor: 'earth.ocean.tides', state: 'live', basis: relations[1]! },
    ],
  }));
  assert.deepEqual(again.map(d => d.anchor), ['physics.gravity', 'physics.resonance']);
  const many = Array.from({ length: 8 }, (_, i) => ({ code: `idea.n${i}`, parent: null, name: `N${i}` }));
  const capped = planPlaces({ concepts: [...concepts, ...many], relations: many.map(n => ({ from: n.code, to: 'earth.ocean.tides', kind: 'applies_to' as const, ref: { claimId: `c-${n.code}` } })),
    accounts: [anchored('earth.ocean.tides')], places: [], rejectedAnchors: [] });
  assert.equal(capped.filter(d => d.kind === 'sighting_appeared').length, 5);
  // Degree outranks code order: a well-connected neighbour is offered before an isolated one.
  const hub = [{ code: 'aaa', parent: null, name: 'A' }, { code: 'zzz', parent: null, name: 'Z' }, { code: 'mmm', parent: null, name: 'M' }];
  const ranked = planPlaces({ concepts: [...concepts, ...hub], accounts: [anchored('earth.ocean.tides')], places: [], rejectedAnchors: [], relations: [
    { from: 'aaa', to: 'earth.ocean.tides', kind: 'applies_to', ref: { claimId: 'c1' } },
    { from: 'zzz', to: 'earth.ocean.tides', kind: 'applies_to', ref: { claimId: 'c2' } },
    { from: 'zzz', to: 'mmm', kind: 'explains', ref: { claimId: 'c3' } },
  ] });
  assert.deepEqual(ranked.filter(d => d.kind === 'sighting_appeared').map(d => d.anchor), ['zzz', 'aaa']);
});

test('a sighting that becomes anchored is promoted into a place', () => {
  const plan = planPlaces(input({
    accounts: [anchored('earth.ocean.tides'), anchored('astro.moon')],
    places: [
      { placeId: 'p1', anchor: 'earth.ocean.tides', kind: 'planet', parentAnchor: null, state: 'live', basis: null },
      { placeId: 's1', anchor: 'astro.moon', kind: 'sighting', parentAnchor: 'earth.ocean.tides', state: 'live', basis: relations[1]! },
    ],
  }));
  const moon = plan.find(d => d.anchor === 'astro.moon')!;
  assert.equal(moon.kind, 'place_formed');
  assert.equal(moon.kind === 'place_formed' && moon.promotesPlaceId, 's1');
});

test('a sighting whose relation is no longer active retires as a source correction', () => {
  const revoked = relations.filter(r => r.from !== 'astro.moon');
  const plan = planPlaces(input({
    relations: revoked, accounts: [anchored('earth.ocean.tides')],
    places: [
      { placeId: 'p1', anchor: 'earth.ocean.tides', kind: 'planet', parentAnchor: null, state: 'live', basis: null },
      { placeId: 's1', anchor: 'astro.moon', kind: 'sighting', parentAnchor: 'earth.ocean.tides', state: 'live', basis: relations[1]! },
    ],
  }));
  const retired = plan.filter(d => d.kind === 'sighting_retired');
  assert.deepEqual(retired.map(d => [d.anchor, d.causalClass, d.kind === 'sighting_retired' && d.placeId]), [['astro.moon', 'source_correction', 's1']]);
  assert.ok(!plan.some(d => d.kind === 'sighting_appeared' && d.anchor === 'astro.moon'), 'not re-offered through the revoked relation');
});

test('the plan is deterministic regardless of input order', () => {
  const a = planPlaces(input({ accounts: [anchored('earth.ocean.tides'), anchored('physics.gravity'), anchored('earth.ocean')] }));
  const b = planPlaces(input({ accounts: [anchored('earth.ocean'), anchored('physics.gravity'), anchored('earth.ocean.tides')], relations: [...relations].reverse(), concepts: [...concepts].reverse() }));
  assert.deepEqual(a, b);
});

test('rejecting a planet retires its sightings and releases its regions as free planets', () => {
  const places: PlaceView[] = [
    { placeId: 'p1', anchor: 'earth.ocean', kind: 'planet', parentAnchor: null, state: 'live', basis: null },
    { placeId: 'r1', anchor: 'earth.ocean.tides', kind: 'region', parentAnchor: 'earth.ocean', state: 'live', basis: null },
    { placeId: 's1', anchor: 'physics.gravity', kind: 'sighting', parentAnchor: 'earth.ocean', state: 'live', basis: relations[0]! },
    { placeId: 's2', anchor: 'astro.moon', kind: 'sighting', parentAnchor: 'earth.ocean.tides', state: 'live', basis: relations[1]! },
  ];
  const plan = planRejection(places, 'p1');
  assert.deepEqual(plan.map(d => [d.kind, d.anchor, d.causalClass]), [
    ['place_rejected', 'earth.ocean', 'reader_correction'],
    ['place_released', 'earth.ocean.tides', 'reader_correction'],
    ['sighting_retired', 'physics.gravity', 'reader_correction'],
  ]);
  assert.throws(() => planRejection(places, 'nope'), /not a live place/);
});

test('review B1: a sighting the reader has now been shown retires as their own exploration; an anchored one is promoted instead', () => {
  const places: PlaceView[] = [
    { placeId: 'p1', anchor: 'earth.ocean.tides', kind: 'planet', parentAnchor: null, state: 'live', basis: null },
    { placeId: 's1', anchor: 'astro.moon', kind: 'sighting', parentAnchor: 'earth.ocean.tides', state: 'live', basis: relations[1]! },
  ];
  const met = planPlaces(input({ accounts: [anchored('earth.ocean.tides'), seen('astro.moon')], places }));
  const retired = met.filter(d => d.kind === 'sighting_retired');
  assert.deepEqual(retired.map(d => [d.anchor, d.causalClass, d.kind === 'sighting_retired' && d.placeId]), [['astro.moon', 'personal_exploration', 's1']]);
  assert.ok(!met.some(d => d.kind === 'sighting_appeared' && d.anchor === 'astro.moon'), 'not offered again: it has been shown');
  const promoted = planPlaces(input({ accounts: [anchored('earth.ocean.tides'), anchored('astro.moon')], places }));
  assert.ok(!promoted.some(d => d.kind === 'sighting_retired'));
  assert.equal(promoted.find(d => d.anchor === 'astro.moon')?.kind, 'place_formed');
});

test('review I1: the five-sighting cap counts the sightings a place already has', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ code: `idea.n${String(i).padStart(2, '0')}`, parent: null, name: `N${i}` }));
  const hub = { concepts: [...concepts, ...many], relations: many.map(n => ({ from: n.code, to: 'earth.ocean.tides', kind: 'applies_to' as const, ref: { claimId: `c-${n.code}` } })),
    accounts: [anchored('earth.ocean.tides')], rejectedAnchors: [] as string[] };
  const first = planPlaces({ ...hub, places: [] });
  const live: PlaceView[] = [{ placeId: 'p1', anchor: 'earth.ocean.tides', kind: 'planet', parentAnchor: null, state: 'live', basis: null },
    ...first.filter(d => d.kind === 'sighting_appeared').map((d, i) => ({ placeId: `s${i}`, anchor: d.anchor, kind: 'sighting' as const, parentAnchor: 'earth.ocean.tides', state: 'live' as const,
      basis: d.kind === 'sighting_appeared' ? d.evidence.relation : null }))];
  assert.equal(live.length, 6);
  assert.deepEqual(planPlaces({ ...hub, places: live }), [], 'a second refresh adds nothing');
  assert.equal(planPlaces({ ...hub, places: live.slice(0, 4) }).filter(d => d.kind === 'sighting_appeared').length, 2, 'three live → two more');
});

test('review M1: a claim is preferred over a bridge as a sighting\'s basis, and a pair counts once towards degree', () => {
  const both: TypedRelation[] = [
    { from: 'physics.gravity', to: 'earth.ocean.tides', kind: 'explains', ref: { bridgeId: 'bridge-g-t' } },
    { from: 'physics.gravity', to: 'earth.ocean.tides', kind: 'explains', ref: { claimId: 'claim-g-t' } },
    { from: 'physics.resonance', to: 'earth.ocean.tides', kind: 'analogous_in', ref: { claimId: 'claim-r-t' } },
    { from: 'physics.resonance', to: 'astro.moon', kind: 'analogous_in', ref: { claimId: 'claim-r-m' } },
  ];
  const plan = planPlaces(input({ relations: both, accounts: [anchored('earth.ocean.tides')] }));
  const gravity = plan.find(d => d.kind === 'sighting_appeared' && d.anchor === 'physics.gravity');
  assert.deepEqual(gravity?.kind === 'sighting_appeared' && gravity.evidence.relation.ref, { claimId: 'claim-g-t' });
  // Gravity's duplicate pair is one connection: resonance (two distinct neighbours) ranks first.
  assert.deepEqual(plan.filter(d => d.kind === 'sighting_appeared').map(d => d.anchor), ['physics.resonance', 'physics.gravity']);
});
