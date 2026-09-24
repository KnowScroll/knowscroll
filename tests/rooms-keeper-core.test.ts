/**
 * ADR-0045 — the pure Keeper: a question the reader carries over two days opens a room on the
 * place it is at home in, inhabitants are seated only by the evidence they have access to, the
 * ladder follows the evidence, and every change carries its cause. No I/O.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConceptNode, TypedRelation } from '../packages/core/src/atlas/cartographer.ts';
import {
  KEEPER_POLICY, openingRef, planRetirements, planRooms, planSetAside, roomChronicleLine,
  type KeeperAsk, type KeeperClaim, type KeeperInput, type KeeperPlace, type RoomDelta, type RoomView,
} from '../packages/core/src/rooms/keeper.ts';

const concepts: ConceptNode[] = [
  { code: 'physics', parent: null, name: 'Physics' },
  { code: 'physics.gravity', parent: 'physics', name: 'Gravity' },
  { code: 'physics.gravity.weight', parent: 'physics.gravity', name: 'Weight' },
  { code: 'earth.tides', parent: null, name: 'Tides' },
  { code: 'astro.orbit', parent: null, name: 'Orbit' },
  { code: 'astro.star', parent: null, name: 'Star' },
  { code: 'astro.moon', parent: null, name: 'The Moon' },
];
const claim = (claimId: string, key: string, about: string[], doubt: KeeperClaim['doubt'] = null): KeeperClaim => ({ claimId, key, about, doubt });
const claims: KeeperClaim[] = [
  claim('c-def', 'clm.gravity.definition', ['physics.gravity']),
  claim('c-pull', 'clm.gravity.earth_pull', ['physics.gravity']),
  claim('c-mass', 'clm.gravity.mass_distance', ['physics.gravity']),
  claim('c-orbit', 'clm.gravity.orbit', ['physics.gravity', 'astro.orbit']),
  claim('c-weight', 'clm.gravity.weight', ['physics.gravity.weight', 'physics.gravity']),
  claim('c-doubt', 'clm.gravity.doubt', ['physics.gravity'], 'qualifies'),
  claim('c-tides', 'clm.tides.cause', ['earth.tides', 'physics.gravity']),
  claim('c-counter', 'clm.tides.counter', ['earth.tides']),
];
const relations: TypedRelation[] = [
  { from: 'physics.gravity', to: 'earth.tides', kind: 'explains', ref: { claimId: 'c-tides' } },
  { from: 'physics.gravity', to: 'astro.orbit', kind: 'explains', ref: { bridgeId: 'b-orbit' } },
];
const bridges = new Map([['b-orbit', { cites: ['c-orbit'], counterevidence: ['c-counter'] }]]);
const gravity: KeeperPlace = { placeId: 'p-gravity', anchor: 'physics.gravity', kind: 'planet', state: 'live' };
const tides: KeeperPlace = { placeId: 'p-tides', anchor: 'earth.tides', kind: 'planet', state: 'live' };
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 8, 23, 10);
const ask = (askId: string, days: number, concept: string | null = 'physics.gravity', hours = 0): KeeperAsk =>
  ({ askId, atMs: T0 + days * DAY_MS + hours * 3_600_000, assetId: `scroll-${askId}`, concept });
const input = (over: Partial<KeeperInput> = {}): KeeperInput => ({
  concepts, relations, bridges, claims, places: [gravity], asks: [], rooms: [], ...over,
});
const room = (roomId: string, over: Partial<RoomView> = {}): RoomView => ({
  roomId, placeId: 'p-gravity', state: 'opened', openedAtMs: T0, askIds: [`${roomId}-a`, `${roomId}-b`], seats: {}, ...over,
});
const opened = (plan: RoomDelta[]) => plan.filter(d => d.kind === 'room_opened');
const of = <K extends RoomDelta['kind']>(plan: RoomDelta[], kind: K) => plan.filter((d): d is Extract<RoomDelta, { kind: K }> => d.kind === kind);

test('one Ask, or two on the same day, carry nothing; two on two days open a room in the latest Ask\'s words', () => {
  assert.deepEqual(planRooms(input({ asks: [ask('a1', 0)] })), []);
  assert.deepEqual(planRooms(input({ asks: [ask('a1', 0), ask('a2', 0, 'physics.gravity', 5)] })), []);

  const plan = planRooms(input({ asks: [ask('a2', 1), ask('a1', 0)] }));
  const [open] = opened(plan);
  assert.deepEqual(open, {
    room: openingRef('a2'), kind: 'room_opened', causalClass: 'personal_exploration', policyVersion: KEEPER_POLICY,
    placeId: 'p-gravity', questionAskId: 'a2', askIds: ['a1', 'a2'],
    evidence: { asks: [{ askId: 'a1', day: '2026-09-23', assetId: 'scroll-a1' }, { askId: 'a2', day: '2026-09-24', assetId: 'scroll-a2' }] },
  });
  assert.equal(plan[0], open, 'the room opens before anyone is seated in it');
});

test('an Ask counts at the nearest live planet or region on its Scroll\'s concept chain, and nowhere else', () => {
  const weightAsks = [ask('a1', 0, 'physics.gravity.weight'), ask('a2', 1, 'physics.gravity.weight')];
  assert.deepEqual(opened(planRooms(input({ asks: weightAsks }))).map(d => d.kind === 'room_opened' && d.placeId), ['p-gravity']);
  const weight: KeeperPlace = { placeId: 'p-weight', anchor: 'physics.gravity.weight', kind: 'region', state: 'live' };
  assert.deepEqual(opened(planRooms(input({ places: [gravity, weight], asks: weightAsks }))).map(d => d.kind === 'room_opened' && d.placeId), ['p-weight'],
    'a region is nearer than its planet, so the same question never opens two rooms');
  // No live place on the chain, no primary concept, or only a sighting there: nothing carries.
  assert.deepEqual(planRooms(input({ asks: [ask('a1', 0, 'astro.star'), ask('a2', 1, 'astro.star')] })), []);
  assert.deepEqual(planRooms(input({ asks: [ask('a1', 0, null), ask('a2', 1, null)] })), []);
  const sighting: KeeperPlace = { placeId: 'p-star', anchor: 'astro.star', kind: 'sighting', state: 'live' };
  assert.deepEqual(planRooms(input({ places: [sighting], asks: [ask('a1', 0, 'astro.star'), ask('a2', 1, 'astro.star')] })), []);
});

test('Asks a room already holds never carry again: a set-aside room keeps them, a newly carried question opens another room', () => {
  const held = room('r1', { askIds: ['a1', 'a2'], seats: { reader_of_record: [{ claimId: 'c-def', supportKind: 'supports' }] } });
  assert.deepEqual(opened(planRooms(input({ rooms: [held], asks: [ask('a1', 0), ask('a2', 1)] }))), []);
  assert.deepEqual(opened(planRooms(input({ rooms: [held], asks: [ask('a1', 0), ask('a2', 1), ask('a3', 2)] }))), [], 'one new Ask is not a carried question');
  const second = opened(planRooms(input({ rooms: [held], asks: [ask('a1', 0), ask('a2', 1), ask('a3', 2), ask('a4', 3)] })));
  assert.deepEqual(second.map(d => d.kind === 'room_opened' && [d.questionAskId, d.askIds]), [['a4', ['a3', 'a4']]]);

  const setAside = room('r1', { state: 'set_aside', askIds: ['a1', 'a2'] });
  assert.deepEqual(planRooms(input({ rooms: [setAside], asks: [ask('a1', 0), ask('a2', 1)] })), [], 'what the reader set aside never reopens');
});

test('beyond three live rooms at a place a carried question joins its most recent one; beyond twelve in the universe it waits', () => {
  const three = [room('r1', { openedAtMs: T0 }), room('r3', { openedAtMs: T0 + 2 }), room('r2', { openedAtMs: T0 + 1 }), room('r0', { state: 'set_aside', openedAtMs: T0 + 9 })];
  const plan = planRooms(input({ rooms: three, asks: [ask('a5', 4), ask('a6', 5)] }));
  assert.deepEqual(opened(plan), []);
  assert.deepEqual(of(plan, 'question_joined'), [{
    room: 'r3', kind: 'question_joined', causalClass: 'personal_exploration', policyVersion: KEEPER_POLICY,
    askIds: ['r3-a', 'r3-b', 'a5', 'a6'],
    evidence: { asks: [{ askId: 'a5', day: '2026-09-27', assetId: 'scroll-a5' }, { askId: 'a6', day: '2026-09-28', assetId: 'scroll-a6' }] },
  }]);

  const places = [gravity, ...['astro.orbit', 'astro.star', 'astro.moon', 'physics'].map((anchor, n) => ({ placeId: `p${n + 1}`, anchor, kind: 'planet' as const, state: 'live' as const }))];
  const twelve = [1, 2, 3, 4].flatMap(n => [1, 2, 3].map(m => room(`r${n}${m}`, { placeId: `p${n}` })));
  assert.deepEqual(planRooms(input({ places, rooms: twelve, asks: [ask('a5', 4), ask('a6', 5)] })).filter(d => d.kind === 'room_opened' || d.kind === 'question_joined'), [],
    'no room of its own to join: the question waits');
  const withOne = [...twelve.slice(1), room('rg', { openedAtMs: T0 })];
  assert.deepEqual(planRooms(input({ places, rooms: withOne, asks: [ask('a5', 4), ask('a6', 5)] })).filter(d => d.kind === 'room_opened' || d.kind === 'question_joined').map(d => [d.kind, d.room]),
    [['question_joined', 'rg']]);
  // A room this plan opens counts against the universe's cap at once.
  const eleven = twelve.slice(1);
  const two = planRooms(input({ places: [...places, tides], rooms: eleven, asks: [ask('a5', 4), ask('a6', 5), ask('t1', 4, 'earth.tides'), ask('t2', 5, 'earth.tides')] }));
  assert.equal(opened(two).length, 1);
});

test('a room seats the reader of record, the doubter and the connector, each only with its evidence, up to four claims in key order', () => {
  const plan = planRooms(input({ places: [gravity, tides], asks: [ask('a1', 0), ask('a2', 1)] }));
  const ref = openingRef('a2');
  assert.deepEqual(of(plan, 'inhabitant_seated'), [
    { room: ref, kind: 'inhabitant_seated', role: 'reader_of_record', causalClass: 'substrate_neighbourhood', policyVersion: KEEPER_POLICY, state: 'opened',
      claims: ['c-def', 'c-pull', 'c-mass', 'c-orbit'].map(claimId => ({ claimId, supportKind: 'supports' })),
      evidence: { claims: ['c-def', 'c-pull', 'c-mass', 'c-orbit'].map(claimId => ({ claimId, supportKind: 'supports' })) } },
    // A qualified claim about the anchor, and the counterevidence recorded against one of its relations.
    { room: ref, kind: 'inhabitant_seated', role: 'doubter', causalClass: 'substrate_neighbourhood', policyVersion: KEEPER_POLICY, state: 'arguing',
      claims: [{ claimId: 'c-doubt', supportKind: 'qualifies' }, { claimId: 'c-counter', supportKind: 'contradicts' }],
      evidence: { claims: [{ claimId: 'c-doubt', supportKind: 'qualifies' }, { claimId: 'c-counter', supportKind: 'contradicts' }] } },
    // What ties Gravity to Tides, another of the reader's live places; never held twice.
    { room: ref, kind: 'inhabitant_seated', role: 'connector', causalClass: 'substrate_neighbourhood', policyVersion: KEEPER_POLICY, state: 'arguing',
      claims: [{ claimId: 'c-tides', supportKind: 'supports' }], evidence: { claims: [{ claimId: 'c-tides', supportKind: 'supports' }] } },
  ]);

  // A tie is the connector's even when its key would lead the reader of record's position.
  const early = claims.map(c => (c.claimId === 'c-tides' ? { ...c, key: 'clm.a.tides_cause' } : c));
  const [reader] = of(planRooms(input({ claims: early, places: [gravity, tides], asks: [ask('a1', 0), ask('a2', 1)] })), 'inhabitant_seated');
  assert.ok(!reader!.claims.some(c => c.claimId === 'c-tides'));

  // Orbit is not one of the reader's places: its bridge ties Gravity to nothing they have, so no connector.
  const alone = of(planRooms(input({ asks: [ask('a1', 0), ask('a2', 1)] })), 'inhabitant_seated');
  assert.deepEqual(alone.map(d => d.role), ['reader_of_record', 'doubter']);
  // Nothing qualifies or contradicts: no doubter, and the room is open, not arguing.
  const calm = of(planRooms(input({ claims: claims.filter(c => c.claimId !== 'c-doubt'), bridges: new Map(), asks: [ask('a1', 0), ask('a2', 1)] })), 'inhabitant_seated');
  assert.deepEqual(calm.map(d => [d.role, d.state]), [['reader_of_record', 'opened']]);
});

test('a second plan over what the first recorded changes nothing', () => {
  const seats = {
    reader_of_record: ['c-def', 'c-pull', 'c-mass', 'c-orbit'].map(claimId => ({ claimId, supportKind: 'supports' as const })),
    doubter: [{ claimId: 'c-doubt', supportKind: 'qualifies' as const }, { claimId: 'c-counter', supportKind: 'contradicts' as const }],
    connector: [{ claimId: 'c-tides', supportKind: 'supports' as const }],
  };
  assert.deepEqual(planRooms(input({ places: [gravity, tides], rooms: [room('r1', { state: 'arguing', askIds: ['a1', 'a2'], seats })], asks: [ask('a1', 0), ask('a2', 1)] })), []);
});

const arguing = room('r1', {
  state: 'arguing',
  seats: {
    reader_of_record: ['c-def', 'c-pull', 'c-mass', 'c-orbit'].map(claimId => ({ claimId, supportKind: 'supports' as const })),
    doubter: [{ claimId: 'c-doubt', supportKind: 'qualifies' as const }, { claimId: 'c-counter', supportKind: 'contradicts' as const }],
    connector: [{ claimId: 'c-tides', supportKind: 'supports' as const }],
  },
});

test('a source correction changes positions with its cause: the doubter leaves, and the room is open again', () => {
  // The doubt's source is withdrawn and the bridge that recorded the counterevidence is revoked;
  // the definition loses its support too.
  const corrected = input({
    places: [gravity, tides], rooms: [arguing],
    claims: claims.filter(c => c.claimId !== 'c-doubt' && c.claimId !== 'c-def'),
    relations: relations.filter(r => !('bridgeId' in r.ref)), bridges: new Map(),
  });
  assert.deepEqual(planRooms(corrected).map(d => [d.kind, 'role' in d ? d.role : null, d.causalClass, 'state' in d ? d.state : null]), [
    ['position_changed', 'reader_of_record', 'source_correction', 'arguing'],
    ['inhabitant_unseated', 'doubter', 'source_correction', 'opened'],
  ]);
  const [changed, left] = planRooms(corrected) as [RoomDelta, RoomDelta];
  assert.deepEqual(changed.kind === 'position_changed' && changed.evidence, {
    claims: ['c-pull', 'c-mass', 'c-orbit', 'c-weight'].map(claimId => ({ claimId, supportKind: 'supports' })),
    previous: arguing.seats.reader_of_record,
  });
  assert.deepEqual(left.kind === 'inhabitant_unseated' && left.evidence, { claims: arguing.seats.doubter });
});

test('the reader setting a connected place aside unseats the connector as their own correction; a newer claim displaces by the neighbourhood', () => {
  const rejected = planRooms(input({ places: [gravity, { ...tides, state: 'rejected' }], rooms: [arguing] }));
  assert.deepEqual(rejected.map(d => [d.kind, 'role' in d ? d.role : null, d.causalClass]), [['inhabitant_unseated', 'connector', 'reader_correction']]);

  const newer = planRooms(input({ places: [gravity, tides], rooms: [arguing], claims: [...claims, claim('c-a', 'clm.gravity.a_first', ['physics.gravity'])] }));
  assert.deepEqual(newer.map(d => [d.kind, 'role' in d ? d.role : null, d.causalClass]), [['position_changed', 'reader_of_record', 'substrate_neighbourhood']]);
});

test('a room whose place is no longer live retires, as the reader\'s correction or the source\'s, and is not seated again', () => {
  const places = (state: KeeperPlace['state']) => [{ ...gravity, state }, tides];
  assert.deepEqual(planRooms(input({ places: places('rejected'), rooms: [arguing, room('r2', { state: 'set_aside' })], asks: [ask('a1', 0), ask('a2', 1)] })), [
    { room: 'r1', kind: 'room_retired', causalClass: 'reader_correction', policyVersion: KEEPER_POLICY, evidence: { placeId: 'p-gravity', placeState: 'rejected' } },
  ]);
  assert.deepEqual(planRetirements([arguing], places('retired')).map(d => d.causalClass), ['source_correction']);
  assert.deepEqual(planRetirements([arguing], places('live')), []);
});

test('the reader sets a live room aside, once', () => {
  assert.deepEqual(planSetAside(arguing, 'request-1'), {
    room: 'r1', kind: 'room_set_aside', causalClass: 'reader_correction', policyVersion: KEEPER_POLICY, evidence: { clientRequestId: 'request-1' },
  });
  assert.throws(() => planSetAside(room('r2', { state: 'set_aside' }), 'request-2'), /not a live room/);
});

test('each change is one quiet line in the Keeper\'s own words, never naming a source', () => {
  const line = (kind: string, causalClass: string, role: 'reader_of_record' | 'doubter' | 'connector' | null = null) => roomChronicleLine({ kind, causalClass, role, placeName: 'Gravity' });
  assert.equal(line('room_opened', 'personal_exploration'), 'A question you keep asking opened a room on Gravity.');
  assert.equal(line('question_joined', 'personal_exploration'), 'Another of your questions about Gravity joined this room.');
  assert.equal(line('inhabitant_seated', 'substrate_neighbourhood', 'reader_of_record'), 'The reader of record took a seat with what is known about Gravity.');
  assert.equal(line('inhabitant_seated', 'substrate_neighbourhood', 'doubter'), 'The doubter took a seat: two readings of Gravity disagree.');
  assert.equal(line('inhabitant_seated', 'substrate_neighbourhood', 'connector'), 'The connector took a seat with what ties Gravity to your other places.');
  assert.equal(line('position_changed', 'source_correction', 'reader_of_record'), 'The reader of record changed position: what a claim was based on changed.');
  assert.equal(line('position_changed', 'reader_correction', 'connector'), 'The connector changed position after you set a place aside.');
  assert.equal(line('position_changed', 'substrate_neighbourhood', 'reader_of_record'), 'The reader of record took up a new position.');
  assert.equal(line('inhabitant_unseated', 'source_correction', 'doubter'), 'The doubter left: what its claims were based on changed.');
  assert.equal(line('inhabitant_unseated', 'reader_correction', 'connector'), 'The connector left after you set a place aside.');
  assert.equal(line('room_set_aside', 'reader_correction'), 'You set this room aside.');
  assert.equal(line('room_retired', 'reader_correction'), 'This room closed: you set Gravity aside.');
  assert.equal(line('room_retired', 'source_correction'), 'This room closed: what Gravity was based on changed.');
  for (const kind of ['room_opened', 'inhabitant_seated', 'position_changed', 'inhabitant_unseated', 'room_retired'])
    for (const cause of ['source_correction', 'reader_correction', 'substrate_neighbourhood'])
      assert.doesNotMatch(line(kind, cause, 'doubter'), /source|publisher|http/i);
});
