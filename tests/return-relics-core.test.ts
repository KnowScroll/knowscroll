/**
 * #134 — the pure parts of the return (ADR-0039): ordering, the marker's exclusivity, the cap and
 * the count of the rest; the marker only moving forward; and the strict wire contracts that clients
 * parse (items newest first and after the marker; a Relic is `corrected` exactly when its
 * connection is no longer admitted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextMarker, selectAway } from '../packages/core/src/away.ts';
import { awayResponse } from '../packages/contracts/src/away.ts';
import { relicWire } from '../packages/contracts/src/relics.ts';

const c = (kind: string, at: string, key = kind) => ({ kind, at, key });

test('newest first, with a deterministic order for equal times', () => {
  const picked = selectAway([c('nothing_found', '2026-09-24T10:00:00.000Z'), c('connection_found', '2026-09-24T11:00:00.000Z'),
    c('place_changed', '2026-09-24T10:00:00.000Z', 'b'), c('place_changed', '2026-09-24T10:00:00.000Z', 'a')], null, 10, 4);
  assert.deepEqual(picked.items.map(i => `${i.kind}:${i.key}`), ['connection_found:connection_found', 'nothing_found:nothing_found', 'place_changed:a', 'place_changed:b']);
  assert.equal(picked.more, 0);
});

test('the marker is exclusive: what happened at or before it is not shown again', () => {
  const picked = selectAway([c('a', '2026-09-24T10:00:00.000Z'), c('b', '2026-09-24T10:00:00.001Z')], '2026-09-24T10:00:00.000Z', 10, 1);
  assert.deepEqual(picked.items.map(i => i.kind), ['b']);
});

test('the cap keeps the newest and counts the rest, including what a capped source did not pass', () => {
  const many = Array.from({ length: 12 }, (_, i) => c('connection_found', `2026-09-24T10:00:${String(i).padStart(2, '0')}.000Z`, `k${i}`));
  const picked = selectAway(many, null, 10, 15);
  assert.equal(picked.items.length, 10);
  assert.equal(picked.items[0]!.key, 'k11');
  assert.equal(picked.more, 5);
  assert.equal(selectAway(many, null, 10, 0).more, 2, 'never fewer than the candidates left out');
  assert.throws(() => selectAway(many, null, 0, 0));
});

test('a list that is not full left nothing out: "more" is 0 even when a source counted rows it could not show', () => {
  const picked = selectAway([c('nothing_found', '2026-09-24T10:00:00.000Z')], null, 10, 3);
  assert.deepEqual([picked.items.length, picked.more], [1, 0]);
});

test('a marker only moves forward', () => {
  assert.equal(nextMarker(null, '2026-09-24T10:00:00.000Z'), '2026-09-24T10:00:00.000Z');
  assert.equal(nextMarker('2026-09-24T10:00:00.000Z', '2026-09-24T10:00:01.000Z'), '2026-09-24T10:00:01.000Z');
  assert.equal(nextMarker('2026-09-24T10:00:00.000Z', '2026-09-24T10:00:00.000Z'), null);
  assert.equal(nextMarker('2026-09-24T10:00:01.000Z', '2026-09-24T10:00:00.000Z'), null);
});

const pair = { a: { code: 'astro.sun', name: 'The Sun' }, b: { code: 'physics.gravity', name: 'Gravity' } };
const found = {
  bridgeId: '11111111-1111-4111-8111-111111111111', bridgeStatus: 'admitted' as const, relationType: 'explains' as const,
  fromConcept: pair.b, toConcept: pair.a, sentence: 'Gravity holds the Sun together against the outward push of its heat.',
  evidence: [{ claimKey: 'k1', statement: 'Gravity binds stars.', supports: 'from' as const, sourceTitle: 'NASA', sourceUrl: 'https://science.nasa.gov/sun/' }],
};

test('the away contract: newest first, after the marker, and "more" only when the list is full', () => {
  const item = (at: string) => ({ kind: 'nothing_found', at, inquiryId: '22222222-2222-4222-8222-222222222222', pairs: [pair] });
  const ok = { privacyEpoch: 0, since: '2026-09-24T09:00:00.000Z', items: [item('2026-09-24T11:00:00.000Z'), item('2026-09-24T10:00:00.000Z')], more: 0, recordingPaused: false };
  assert.equal(awayResponse.safeParse(ok).success, true);
  assert.equal(awayResponse.safeParse({ ...ok, items: [...ok.items].reverse() }).success, false, 'oldest first is refused');
  assert.equal(awayResponse.safeParse({ ...ok, since: '2026-09-24T10:00:00.000Z' }).success, false, 'an item at the marker is refused');
  assert.equal(awayResponse.safeParse({ ...ok, more: 3 }).success, false, 'more with a short list is refused');
  assert.equal(awayResponse.safeParse({ ...ok, items: [{ ...item('2026-09-24T11:00:00.000Z'), extra: 1 }] }).success, false, 'strict');
  const place = { kind: 'place_changed', at: '2026-09-24T11:00:00.000Z', deltaId: '33333333-3333-4333-8333-333333333333', placeId: '44444444-4444-4444-8444-444444444444',
    change: 'foundation_withdrawn', line: 'Gravity no longer holds up the places around it.' };
  assert.equal(awayResponse.safeParse({ ...ok, items: [{ ...place, cause: 'source_correction' }] }).success, true);
  assert.equal(awayResponse.safeParse({ ...ok, items: [{ ...place, cause: 'personal_exploration' }] }).success, false, 'only what the reader did not cause');
});

test('a Relic is "corrected" exactly when its connection is no longer admitted', () => {
  const relic = { relicId: '55555555-5555-4555-8555-555555555555', kind: 'connection', keptAt: '2026-09-24T11:00:00.000Z', state: 'current',
    connection: found, provenance: { inquiryId: null, validatorVersion: 'bridge-validator-v1', citedClaimKeys: ['k1'] } };
  assert.equal(relicWire.safeParse(relic).success, true);
  assert.equal(relicWire.safeParse({ ...relic, state: 'doubted' }).success, true);
  assert.equal(relicWire.safeParse({ ...relic, state: 'corrected' }).success, false, 'an admitted connection is not corrected');
  const revoked = { ...relic, connection: { ...found, bridgeStatus: 'revoked' } };
  assert.equal(relicWire.safeParse({ ...revoked, state: 'corrected' }).success, true);
  assert.equal(relicWire.safeParse({ ...revoked, state: 'current' }).success, false, 'a correction is never hidden');
  assert.equal(relicWire.safeParse({ ...revoked, state: 'doubted' }).success, false);
});
