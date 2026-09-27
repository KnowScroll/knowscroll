/**
 * ADR-0045 — Idea Rooms over the real Fastify app, database and worker. A reader who asks about
 * gravity on two days, once Gravity is one of their places, finds a room there in their own words,
 * with the reader of record holding claims about it and every change a chronicle line with its
 * evidence -- and never a source. A qualified claim seats a doubter (two readings disagree); a source
 * correction unseats it while the reader is away, through the worker's catch-up, as away news. The
 * reader can set a room aside (never while paused; its Asks never reopen it) or set its place aside
 * (the room retires with it); Clear, Reset and export behave as for all private history; and the
 * schema refuses a room change without a delta, beyond a cap, or while paused.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { atlasResponseSchema } from '../packages/contracts/src/atlas.ts';
import { awayResponse } from '../packages/contracts/src/away.ts';
import { compareAway } from '../packages/core/src/away.ts';
import { roomDeltaResponse, roomResponse } from '../packages/contracts/src/rooms.ts';
import type { SubstrateSeed } from '../packages/contracts/src/semantic.ts';
import { pool, provisionIdentity, transaction } from '../packages/db/src/index.ts';
import { loadSubstrateSeed } from '../packages/db/src/semantic/seed.ts';
import { drain, withdraw } from './helpers/corrections.ts';
import { insertScroll } from './helpers/inquiry-fixture.ts';
import { askAbout, readFirstOffered, readScroll } from './helpers/reading.ts';
import { anchorGravityOnDayTwo, askOnDayOne, carryGravityQuestion, GRAVITY_QUESTIONS, yesterday } from './helpers/rooms.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Idea Room tests require a disposable knowscroll_test_* database');
const app = buildApp(randomBytes(32).toString('hex'));
await app.ready();
after(async () => { await app.close(); await pool.end(); });

type Identity = Awaited<ReturnType<typeof provisionIdentity>>;
type Reader = { universeId: string; headers: { authorization: string } };
const reader = async (): Promise<Reader> => {
  const i: Identity = await provisionIdentity();
  return { universeId: i.scope.universeId, headers: { authorization: `Bearer ${i.token}` } };
};

async function atlasOf(r: Reader) {
  const response = await app.inject({ url: '/v1/atlas', headers: r.headers });
  assert.equal(response.statusCode, 200, response.body);
  return atlasResponseSchema.parse(response.json());
}
async function roomOf(r: Reader, roomId: string) {
  const response = await app.inject({ url: `/v1/rooms/${roomId}`, headers: r.headers });
  assert.equal(response.statusCode, 200, response.body);
  // The strict wire contract the clients parse; and nothing in it says where a claim came from.
  assert.doesNotMatch(response.body, /sourceTitle|publisher|https?:|nasa|noaa/i);
  return roomResponse.parse(response.json());
}
const placeOf = async (r: Reader, code: string) => (await atlasOf(r)).places.find(p => p.anchor.code === code);
const count = async (table: string, r: Reader) => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE universe_id=$1`, [r.universeId])).rows[0].count);
const epoch = async (r: Reader) => (await app.inject({ url: '/v1/universe', headers: r.headers })).json().privacyEpoch as number;
const privacy = async (r: Reader, action: 'pause' | 'resume') =>
  assert.equal((await app.inject({ method: 'POST', url: `/v1/privacy/${action}`, headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: await epoch(r) } })).statusCode, 200);
const setAside = (r: Reader, roomId: string, expectedPrivacyEpoch: number, clientRequestId: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/v1/rooms/${roomId}/set-aside`, headers: r.headers, payload: { clientRequestId, expectedPrivacyEpoch } });

async function gravityRoom() {
  const r = await reader();
  const asks = await carryGravityQuestion(app, r.headers, r.universeId);
  const place = (await placeOf(r, 'physics.gravity'))!;
  assert.equal(place.rooms.length, 1, JSON.stringify(place.rooms));
  return { r, asks, place, room: place.rooms[0]! };
}

test('a question asked about gravity on two days opens a room there, in the reader\'s own words, holding claims and never a source', async () => {
  const r = await reader();
  const dayOne = await askOnDayOne(app, r.headers, r.universeId);
  const pull = await anchorGravityOnDayTwo(app, r.headers);
  const gravity = (await placeOf(r, 'physics.gravity'))!;
  assert.equal(gravity.kind, 'planet');
  assert.deepEqual(gravity.rooms, [], 'one Ask is not a carried question, whatever place it is in');
  const dayTwo = await askAbout(app, r.headers, pull, GRAVITY_QUESTIONS.dayTwo);

  const atlas = await atlasOf(r);
  const [room] = atlas.places.find(p => p.anchor.code === 'physics.gravity')!.rooms;
  assert.ok(room);
  assert.equal(room.question, GRAVITY_QUESTIONS.dayTwo, 'the latest Ask\'s own words');
  // Nothing about Gravity is qualified or contradicted, and no other place of theirs ties to it: the
  // reader of record sits alone, and the room is open, not arguing.
  assert.equal(room.state, 'opened');
  assert.deepEqual(room.inhabitants.map(i => [i.role, i.claims.map(c => c.key)]), [
    ['reader_of_record', ['clm.gravity.definition', 'clm.gravity.earth_pull', 'clm.gravity.mass_distance', 'clm.gravity.orbit']],
  ]);
  assert.ok(room.inhabitants[0]!.claims.every(c => c.supportKind === 'supports' && c.truthState === 'documented' && c.statement.length > 12));
  assert.ok(atlas.places.every(p => p.kind !== 'sighting' || p.rooms.length === 0));

  const detail = await roomOf(r, room.roomId);
  assert.deepEqual([detail.placeId, detail.placeName, detail.question, detail.state], [atlas.places.find(p => p.anchor.code === 'physics.gravity')!.placeId, 'Gravity', GRAVITY_QUESTIONS.dayTwo, 'opened']);
  assert.deepEqual(detail.chronicle.map(c => [c.kind, c.causalClass, c.role, c.line]).reverse(), [
    ['room_opened', 'personal_exploration', null, 'A question you keep asking opened a room on Gravity.'],
    ['inhabitant_seated', 'substrate_neighbourhood', 'reader_of_record', 'The reader of record took a seat with what is known about Gravity.'],
  ]);
  const opened = detail.chronicle.find(c => c.kind === 'room_opened')!;
  assert.deepEqual(opened.evidence.asks.map(a => a.askId), [dayOne, dayTwo]);
  assert.equal(new Set(opened.evidence.asks.map(a => a.day)).size, 2, 'carried over two days');
  assert.deepEqual(detail.chronicle.find(c => c.kind === 'inhabitant_seated')!.evidence.claims, room.inhabitants[0]!.claims);

  const one = await app.inject({ url: `/v1/rooms/deltas/${opened.deltaId}`, headers: r.headers });
  assert.equal(one.statusCode, 200, one.body);
  assert.deepEqual(roomDeltaResponse.parse(one.json()).evidence, opened.evidence);

  // Another universe cannot read it; a further refresh changes nothing.
  const other = await reader();
  assert.equal((await app.inject({ url: `/v1/rooms/${room.roomId}`, headers: other.headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `/v1/rooms/deltas/${opened.deltaId}`, headers: other.headers })).statusCode, 404);
  const deltas = await count('room_delta', r);
  await readFirstOffered(app, r.headers);
  assert.equal(await count('room_delta', r), deltas);
});

/**
 * Magnetism and Compass, each read on two days from two source families, both become planets.
 * Magnetism explains Compass (the connector's tie), a lab claim is about Magnetism (the reader of
 * record's) and a claim about it that its own source qualifies rests on a doubt source only.
 */
async function arguingNeighbourhood() {
  const tag = `r${randomBytes(5).toString('hex')}`;
  const codes = { magnetism: `${tag}.magnetism`, compass: `${tag}.compass` };
  const claims = { pull: `clm.${tag}.pull`, needle: `clm.${tag}.needle`, steers: `clm.${tag}.steers`, fades: `clm.${tag}.fades` };
  const sources = { lab: `src.${tag}.lab`, field: `src.${tag}.field`, doubt: `src.${tag}.doubt` };
  const url = (s: string) => `https://example.test/${tag}/${s}`;
  const scroll = (title: string, source: 'lab' | 'field') => insertScroll(pool, `${tag} ${title}`, `${source} fixture`, url(source));
  const scrolls = {
    magnetism: [await scroll('A pull without touching', 'lab'), await scroll('Iron filings draw the field', 'lab'), await scroll('Magnets in the field', 'field')],
    compass: [await scroll('A needle on a pin', 'lab'), await scroll('Why a compass points north', 'field'), await scroll('Walking by compass', 'field')],
  };
  const quote = (n: number) => `A verbatim passage number ${n}, long enough to be a quote.`;
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-09-25.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [
      { key: `fam.${tag}.lab`, kind: 'publisher', description: 'Synthetic room test family' },
      { key: `fam.${tag}.field`, kind: 'publisher', description: 'A second synthetic room test family' },
    ],
    sources: (['lab', 'field', 'doubt'] as const).map(s => ({
      key: sources[s], url: url(s), title: `${s} fixture`, publisher: 'Fixture',
      familyKey: s === 'field' ? `fam.${tag}.field` : `fam.${tag}.lab`, retrievedAt: '2026-09-25', contentSha256: randomBytes(32).toString('hex'),
    })),
    concepts: [
      { code: tag, name: 'Room fixture root', description: 'Root of a synthetic room test substrate', kind: 'idea', parentCode: null },
      { code: codes.magnetism, name: 'Magnetism', description: 'The force between magnets and moving charges', kind: 'phenomenon', parentCode: tag },
      { code: codes.compass, name: 'Compass', description: 'A needle that lines up with a magnetic field', kind: 'object', parentCode: tag },
    ],
    claims: [
      { key: claims.pull, statement: 'A magnet pulls on iron without touching it.', truthState: 'documented', concepts: [{ code: codes.magnetism, role: 'subject' }],
        support: [{ sourceKey: sources.lab, quote: quote(1), supportKind: 'supports' }] },
      { key: claims.needle, statement: 'A compass needle is a small magnet balanced on a pin.', truthState: 'documented', concepts: [{ code: codes.compass, role: 'subject' }],
        support: [{ sourceKey: sources.field, quote: quote(2), supportKind: 'supports' }] },
      { key: claims.steers, statement: 'The magnetic field of the Earth turns a compass needle to point north.', truthState: 'documented',
        concepts: [{ code: codes.magnetism, role: 'mechanism' }, { code: codes.compass, role: 'subject' }], support: [{ sourceKey: sources.field, quote: quote(3), supportKind: 'supports' }] },
      { key: claims.fades, statement: 'A magnet reaches across empty space with the same pull at any distance.', truthState: 'documented',
        concepts: [{ code: codes.magnetism, role: 'subject' }],
        support: [{ sourceKey: sources.doubt, quote: quote(4), supportKind: 'supports' }, { sourceKey: sources.doubt, quote: quote(5), supportKind: 'qualifies' }] },
    ],
    relations: [{ from: codes.magnetism, to: codes.compass, kind: 'explains', claimKey: claims.steers }],
    assets: [
      ...scrolls.magnetism.map(assetId => ({ assetId, concepts: [{ code: codes.magnetism, role: 'primary' as const }], claims: [claims.pull] })),
      ...scrolls.compass.map(assetId => ({ assetId, concepts: [{ code: codes.compass, role: 'primary' as const }], claims: [claims.needle] })),
    ],
    bridgeProposals: [],
  };
  const loaded = await transaction(client => loadSubstrateSeed(client, JSON.stringify(seed)));
  if (loaded.status !== 'loaded') throw new Error('room fixture substrate did not load');

  const r = await reader();
  const [lab, labAgain, field] = scrolls.magnetism as [string, string, string];
  await askAbout(app, r.headers, await readScroll(app, r.headers, lab, true), 'Does a magnet pull as hard from far away?');
  await readScroll(app, r.headers, scrolls.compass[0]!, true);
  await yesterday(r.universeId);
  await readScroll(app, r.headers, labAgain, true);
  const fieldExposure = await readScroll(app, r.headers, field, true);
  for (const assetId of scrolls.compass.slice(1)) await readScroll(app, r.headers, assetId, true);
  await askAbout(app, r.headers, fieldExposure, 'How far does a magnet really reach?');
  return { r, codes, claims, sources };
}

test('two readings disagree: a qualified claim seats the doubter, and a correction unseats it while the reader is away, as away news', async () => {
  const { r, codes, claims, sources } = await arguingNeighbourhood();
  const atlas = await atlasOf(r);
  assert.ok(atlas.places.some(p => p.anchor.code === codes.compass && p.kind === 'planet'), JSON.stringify(atlas.places.map(p => [p.anchor.code, p.kind])));
  const [room] = atlas.places.find(p => p.anchor.code === codes.magnetism)!.rooms;
  assert.ok(room);
  assert.equal(room.question, 'How far does a magnet really reach?');
  assert.equal(room.state, 'arguing');
  assert.deepEqual(room.inhabitants.map(i => [i.role, i.claims.map(c => [c.key, c.supportKind])]), [
    ['reader_of_record', [[claims.pull, 'supports']]],
    ['doubter', [[claims.fades, 'qualifies']]],
    ['connector', [[claims.steers, 'supports']]],
  ]);

  // The doubt's source is withdrawn while the reader does nothing; the worker catches them up.
  const events = await count('ledger', r);
  await withdraw(sources.doubt);
  assert.equal((await placeOf(r, codes.magnetism))!.rooms[0]!.state, 'arguing', 'nothing reaches the room until a refresh');
  assert.ok((await drain()).refreshed.has(r.universeId));
  assert.equal(await count('ledger', r), events, 'the reader did nothing');

  const after = (await placeOf(r, codes.magnetism))!.rooms[0]!;
  assert.equal(after.state, 'opened', 'one reading again');
  assert.deepEqual(after.inhabitants.map(i => i.role), ['reader_of_record', 'connector']);
  const detail = await roomOf(r, room.roomId);
  const left = detail.chronicle[0]!;
  assert.deepEqual([left.kind, left.role, left.causalClass, left.line], ['inhabitant_unseated', 'doubter', 'source_correction', 'The doubter left: what its claims were based on changed.']);
  assert.deepEqual(left.evidence.claims.map(c => c.key), [claims.fades], 'the evidence keeps what it held');

  const away = await app.inject({ url: '/v1/away', headers: r.headers });
  assert.equal(away.statusCode, 200, away.body);
  const item = awayResponse.parse(away.json()).items.find(i => i.kind === 'room_changed');
  assert.ok(item && item.kind === 'room_changed', 'the change is away news');
  assert.deepEqual([item.deltaId, item.roomId, item.change, item.cause, item.line],
    [left.deltaId, room.roomId, 'inhabitant_unseated', 'source_correction', 'The doubter left: what its claims were based on changed.']);
});

test('pages reach room and place changes exactly once, even inside one millisecond at a page\'s edge (ADR-0044 M7)', async () => {
  const { r, place, room } = await gravityRoom();
  const away = async (page?: string) => {
    const response = await app.inject({ url: page ? `/v1/away?page=${encodeURIComponent(page)}` : '/v1/away', headers: r.headers });
    assert.equal(response.statusCode, 200, response.body);
    return awayResponse.parse(response.json());
  };
  assert.deepEqual((await away()).items, [], 'nothing yet that the reader did not cause');
  // 24 source corrections a second apart, places and the room alternating, except six that share one
  // millisecond across the first page's edge, so that page ends on a room's change. One base time for
  // all: each insert reading the clock itself could split the six across two milliseconds.
  const base = (await pool.query<{ t: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS t")).rows[0]!.t;
  for (let i = 24; i >= 1; i -= 1) {
    const at = `$5::timestamptz - make_interval(secs => $3) + make_interval(secs => $4::double precision / 1000000)`;
    const secs = i >= 7 && i <= 12 ? 7 : i;
    if (i % 2) await pool.query(`INSERT INTO atlas_delta(id,universe_id,place_id,kind,causal_class,policy_version,evidence,before,after,created_at)
      VALUES(gen_random_uuid(),$1,$2,'place_released','source_correction','cartographer-v2','{}','{}','{}',${at})`, [r.universeId, place.placeId, secs, i, base]);
    else await pool.query(`INSERT INTO room_delta(id,universe_id,room_id,kind,causal_class,policy_version,evidence,after,created_at)
      VALUES(gen_random_uuid(),$1,$2,'room_retired','source_correction','keeper-v1','{}','{}',${at})`, [r.universeId, room.roomId, secs, i, base]);
  }
  const pages = [await away()];
  while (pages.at(-1)!.nextPage) pages.push(await away(pages.at(-1)!.nextPage!));
  assert.match(pages[0]!.nextPage!, /\|room_changed\|/);
  assert.deepEqual(pages.map(p => [p.items.length, p.more]), [[10, 14], [10, 4], [4, 0]]);
  const items = pages.flatMap(p => p.items).map(i => ({ kind: i.kind, at: i.at, key: 'deltaId' in i ? i.deltaId : '' }));
  assert.equal(new Set(items.map(i => i.key)).size, 24, 'no item twice, none skipped');
  assert.deepEqual(items, [...items].sort(compareAway), 'one order across pages');
});

test('the reader sets a room aside: never while paused or on a stale epoch, once, and its Asks never reopen a room', async () => {
  const { r, room } = await gravityRoom();
  const e = await epoch(r);
  assert.equal((await setAside(r, room.roomId, e + 1)).statusCode, 409, 'stale epoch');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/rooms/${room.roomId}/set-aside`, headers: r.headers, payload: { expectedPrivacyEpoch: e } })).statusCode, 400);
  await privacy(r, 'pause');
  const paused = await setAside(r, room.roomId, e);
  assert.deepEqual([paused.statusCode, paused.json().error], [409, 'Recording is paused'], 'nothing personal is recorded while paused');
  await privacy(r, 'resume');
  assert.equal((await roomOf(r, room.roomId)).state, 'opened');

  const done = await setAside(r, room.roomId, e);
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(atlasResponseSchema.parse(done.json()).places.find(p => p.anchor.code === 'physics.gravity')!.rooms, [], 'the answer is the atlas without it');
  const detail = await roomOf(r, room.roomId);
  assert.deepEqual([detail.state, detail.inhabitants, detail.chronicle[0]!.line, detail.chronicle[0]!.causalClass], ['set_aside', [], 'You set this room aside.', 'reader_correction']);
  assert.equal(Number((await pool.query('SELECT count(*) FROM room_inhabitant WHERE room_id=$1 AND seated', [room.roomId])).rows[0].count), 0, 'unseated with it');
  assert.equal((await setAside(r, room.roomId, e)).statusCode, 200, 'setting aside twice is the same answer');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/rooms/${randomUUID()}/set-aside`, headers: r.headers, payload: { clientRequestId: randomUUID(), expectedPrivacyEpoch: e } })).statusCode, 404);

  const deltas = await count('room_delta', r);
  await readFirstOffered(app, r.headers);
  assert.deepEqual((await placeOf(r, 'physics.gravity'))!.rooms, [], 'the Asks it held never reopen a room');
  assert.equal(await count('room_delta', r), deltas);
});

test('setting the room\'s place aside retires the room in the same transaction', async () => {
  const { r, place, room } = await gravityRoom();
  const rejected = await app.inject({ method: 'POST', url: `/v1/atlas/places/${place.placeId}/reject`, headers: r.headers, payload: { expectedPrivacyEpoch: await epoch(r) } });
  assert.equal(rejected.statusCode, 200, rejected.body);
  const detail = await roomOf(r, room.roomId);
  assert.deepEqual([detail.state, detail.inhabitants, detail.chronicle[0]!.kind, detail.chronicle[0]!.causalClass, detail.chronicle[0]!.line],
    ['retired', [], 'room_retired', 'reader_correction', 'This room closed: you set Gravity aside.']);
  assert.equal((await setAside(r, room.roomId, await epoch(r))).statusCode, 409, 'only a live room can be set aside');
});

test('export carries rooms, their inhabitants and deltas; Clear and Reset erase them (account deletion: tests/account-deletion.test.ts)', async () => {
  for (const [url, confirmation] of [['/v1/history/clear', 'clear-scroll-history'], ['/v1/privacy/reset', 'reset-personal-universe']] as const) {
    const { r, room } = await gravityRoom();
    const e = await epoch(r);
    const exported = (await app.inject({ method: 'POST', url: '/v1/privacy/export', headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: e } })).json();
    assert.deepEqual(exported.personalModel.rooms.map((x: { id: string }) => x.id), [room.roomId]);
    assert.equal(exported.personalModel.roomInhabitants.length, 1);
    assert.equal(exported.personalModel.roomDeltas.length, 2);
    const done = await app.inject({ method: 'POST', url, headers: r.headers, payload: { requestId: randomUUID(), expectedPrivacyEpoch: e, confirmation } });
    assert.equal(done.statusCode, 200, done.body);
    assert.deepEqual([await count('room', r), await count('room_inhabitant', r), await count('room_delta', r)], [0, 0, 0], url);
  }
});

test('the schema refuses a room change without a delta, an edited delta, a fourth live room at a place, a settled room\'s change and any change while paused', async () => {
  const { r, place, room } = await gravityRoom();
  const refuse = async (statements: [string, unknown[]][], pattern: RegExp) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(async () => { for (const [sql, params] of statements) await client.query(sql, params); await client.query('COMMIT'); }, pattern);
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  };
  await refuse([["UPDATE room_delta SET causal_class='reader_correction' WHERE room_id=$1", [room.roomId]]], /immutable/);
  await refuse([["UPDATE room SET state='arguing' WHERE id=$1", [room.roomId]]], /delta that says why/);
  const asks = (await pool.query<{ ask_ids: string[] }>('SELECT ask_ids::text[] FROM room WHERE id=$1', [room.roomId])).rows[0]!.ask_ids;
  const another = [`INSERT INTO room(id,universe_id,privacy_epoch,place_id,question_ask_id,ask_ids,policy_version) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'keeper-v1')`,
    [r.universeId, await epoch(r), place.placeId, asks[0], asks]] as [string, unknown[]];
  await refuse([another, another, another], /at most 3 live rooms/);
  await refuse([["INSERT INTO room(id,universe_id,privacy_epoch,place_id,question_ask_id,ask_ids,policy_version) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'keeper-v1')",
    [r.universeId, await epoch(r), place.placeId, asks[0], [asks[0], randomUUID()]]]], /own universe's Asks/);

  await privacy(r, 'pause');
  await refuse([["UPDATE room SET state='set_aside' WHERE id=$1", [room.roomId]]], /Recording is paused/);
  await privacy(r, 'resume');
  assert.equal((await setAside(r, room.roomId, await epoch(r))).statusCode, 200);
  await refuse([["UPDATE room SET state='opened' WHERE id=$1", [room.roomId]]], /no longer live/);
  await refuse([["UPDATE room_inhabitant SET seated=true, claims='[{\"claimId\":\"x\",\"supportKind\":\"supports\"}]' WHERE room_id=$1", [room.roomId]]], /Only a live room seats/);
});
