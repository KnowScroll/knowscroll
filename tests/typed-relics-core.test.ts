/**
 * #165 — the pure parts of typed Relics (ADR-0044): one state rule over each kind's facts (corrected
 * beats doubted, which beats current), the total order and page cursors of the return and of the
 * Relic list (M7, M8), and the strict wire contracts clients parse (no source on the new kinds, a
 * withdrawn claim never shown as current, `nextPage` exactly when there is more).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { awayCursor, compareAway, parseAwayCursor } from '../packages/core/src/away.ts';
import { parseRelicCursor, relicCursor, relicState, type RelicFacts } from '../packages/core/src/relics.ts';
import { awayItem, awayResponse } from '../packages/contracts/src/away.ts';
import { objectionInput, passagesResponse, relicKeepInput, relicsResponse, relicWire } from '../packages/contracts/src/relics.ts';

type ScrollFacts = Extract<RelicFacts, { kind: 'passage' | 'answer' }>;
const scroll = (f: Partial<ScrollFacts> = {}): ScrollFacts => ({ kind: 'passage', keptRevision: 1, currentRevision: 1, unsupportedClaims: 0, seemsWrong: false, ...f });

test('a connection: corrected when its bridge no longer stands, doubted when the reader said it seems wrong', () => {
  assert.equal(relicState({ kind: 'connection', bridgeStatus: 'admitted', seemsWrong: false }), 'current');
  assert.equal(relicState({ kind: 'connection', bridgeStatus: 'admitted', seemsWrong: true }), 'doubted');
  assert.equal(relicState({ kind: 'connection', bridgeStatus: 'revoked', seemsWrong: false }), 'corrected');
  assert.equal(relicState({ kind: 'connection', bridgeStatus: 'superseded', seemsWrong: true }), 'corrected', 'corrected beats doubted');
});

test('a place: corrected by a source correction recorded after it was kept, doubted when set aside', () => {
  assert.equal(relicState({ kind: 'place', correctedSinceKept: false, setAside: false }), 'current');
  assert.equal(relicState({ kind: 'place', correctedSinceKept: false, setAside: true }), 'doubted');
  assert.equal(relicState({ kind: 'place', correctedSinceKept: true, setAside: false }), 'corrected');
  assert.equal(relicState({ kind: 'place', correctedSinceKept: true, setAside: true }), 'corrected', 'corrected beats doubted');
});

test('a passage or an answer: corrected by a newer revision or a claim that lost its support, doubted by the reader', () => {
  for (const kind of ['passage', 'answer'] as const) {
    assert.equal(relicState({ ...scroll(), kind }), 'current');
    assert.equal(relicState({ ...scroll({ seemsWrong: true }), kind }), 'doubted');
    assert.equal(relicState({ ...scroll({ currentRevision: 2 }), kind }), 'corrected', 'a newer revision');
    assert.equal(relicState({ ...scroll({ unsupportedClaims: 1 }), kind }), 'corrected', 'a claim lost its support');
    assert.equal(relicState({ ...scroll({ unsupportedClaims: 2, currentRevision: 3, seemsWrong: true }), kind }), 'corrected', 'corrected beats doubted');
  }
});

const at = (ms: number) => new Date(Date.UTC(2026, 8, 25, 10, 0, 0, ms)).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the return has one total order: newest first, then kind, then id, compared byte-wise', () => {
  const items = [
    { kind: 'place_changed', at: at(5), key: id(2) },
    { kind: 'place_changed', at: at(5), key: id(1) },
    { kind: 'connection_found', at: at(5), key: id(9) },
    { kind: 'nothing_found', at: at(7), key: id(3) },
  ];
  assert.deepEqual([...items].sort(compareAway).map(i => `${i.kind}:${i.key.slice(-1)}`),
    ['nothing_found:3', 'connection_found:9', 'place_changed:1', 'place_changed:2']);
  // Byte-wise, like SQL's COLLATE "C": an underscore sorts after capitals and before small letters.
  assert.ok(compareAway({ kind: 'a_b', at: at(0), key: id(0) }, { kind: 'ab', at: at(0), key: id(0) }) < 0);
});

test('a page cursor names one item exactly and refuses anything else', () => {
  const item = { kind: 'connection_corrected', at: at(123), key: id(4) };
  const cursor = awayCursor(item);
  assert.deepEqual(parseAwayCursor(cursor), item);
  for (const bad of ['', 'x', `${at(1)}|connection_corrected`, `${at(1)}|unknown_kind|${id(1)}`, `2026-09-25|place_changed|${id(1)}`, `${at(1)}|place_changed|not-a-uuid`]) {
    assert.equal(parseAwayCursor(bad), null, bad);
  }
  const relic = relicCursor('2026-09-25T10:00:00.123456Z', id(7));
  assert.deepEqual(parseRelicCursor(relic), { keptAt: '2026-09-25T10:00:00.123456Z', relicId: id(7) });
  assert.equal(parseRelicCursor(`2026-09-25T10:00:00.123Z|${id(7)}`), null, 'microseconds, as the database keeps them');
  assert.equal(parseRelicCursor(id(7)), null);
});

const concept = (code: string, name: string) => ({ code, name });
const evidence = { claimKey: 'k1', statement: 'Gravity binds stars together.', supports: 'from' as const, sourceTitle: 'Fixture', sourceUrl: 'https://example.test/a', withdrawn: false };
const found = {
  bridgeId: id(1), bridgeStatus: 'admitted' as const, relationType: 'explains' as const,
  fromConcept: concept('astro.gravity', 'Gravity'), toConcept: concept('astro.sun', 'The Sun'),
  sentence: 'Gravity holds the Sun together against the outward push of its heat.', evidence: [evidence],
};
const base = { relicId: id(2), keptAt: at(0), state: 'current' };
const place = { ...base, kind: 'place', place: { placeId: id(3), kind: 'sighting', anchor: concept('astro.tides', 'Tides'), formedAt: at(0), formation: 'Tides appeared near Gravity: Gravity explains Tides.' } };
const passage = { ...base, kind: 'passage', passage: { assetId: id(4), revision: 1, title: 'Gravity pulls', claim: { claimKey: 'clm.k1', statement: 'Every mass attracts every other mass.', withdrawn: false } } };
const answer = { ...base, kind: 'answer', answer: { askId: id(5), assetId: id(4), revision: 1, title: 'Gravity pulls', question: 'Why do things fall?', answer: 'Because masses attract.', basis: [{ quote: 'Every mass attracts every other mass' }], limits: 'Fixture limits.' } };

test('each kind has a strict wire with its kept form and state, and no source on the new kinds', () => {
  for (const relic of [place, passage, answer]) {
    assert.equal(relicWire.safeParse(relic).success, true, relic.kind);
    for (const state of ['doubted', 'corrected']) assert.equal(relicWire.safeParse({ ...relic, state }).success, true, `${relic.kind} ${state}`);
    assert.equal(relicWire.safeParse({ ...relic, sourceTitle: 'NASA' }).success, false, 'strict');
    assert.equal(relicWire.safeParse({ ...relic, provenance: { exposureId: id(9) } }).success, false, 'provenance is internal');
  }
  const deep = (o: Record<string, unknown>, key: string, extra: Record<string, unknown>) => ({ ...o, [key]: { ...(o[key] as object), ...extra } });
  assert.equal(relicWire.safeParse(deep(place, 'place', { sourceUrl: 'https://example.test' })).success, false);
  assert.equal(relicWire.safeParse(deep(answer, 'answer', { sourceTitle: 'NASA' })).success, false);
  assert.equal(relicWire.safeParse(deep(passage, 'passage', { claim: { ...passage.passage.claim, sourceTitle: 'NASA' } })).success, false);
  assert.equal(relicWire.safeParse({ ...base, kind: 'connection', connection: found, provenance: { inquiryId: null, validatorVersion: 'bridge-validator-v1', citedClaimKeys: ['k1'] } }).success, true, 'a connection keeps its ADR-0039 wire');
});

test('a withdrawn claim is never shown under a current or doubted passage (M4)', () => {
  const withdrawn = { ...passage, passage: { ...passage.passage, claim: { ...passage.passage.claim, withdrawn: true } } };
  assert.equal(relicWire.safeParse({ ...withdrawn, state: 'corrected' }).success, true);
  assert.equal(relicWire.safeParse(withdrawn).success, false);
  assert.equal(relicWire.safeParse({ ...withdrawn, state: 'doubted' }).success, false);
  assert.equal(relicWire.safeParse({ ...base, kind: 'connection', connection: { ...found, evidence: [{ ...evidence, withdrawn: undefined }] },
    provenance: { inquiryId: null, validatorVersion: 'bridge-validator-v1', citedClaimKeys: ['k1'] } }).success, false, 'every evidence claim says whether it was withdrawn');
});

test('keep and objection inputs name exactly one thing of their kind', () => {
  const common = { clientRequestId: id(10), expectedPrivacyEpoch: 0 };
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'connection', bridgeId: id(1) }).success, true);
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'place', placeId: id(3) }).success, true);
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'passage', assetId: id(4), revision: 1, claimKey: 'clm.k1' }).success, true);
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'answer', askId: id(5) }).success, true);
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'place', bridgeId: id(1) }).success, false);
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'passage', assetId: id(4), revision: 0, claimKey: 'clm.k1' }).success, false);
  assert.equal(relicKeepInput.safeParse({ ...common, kind: 'moon', placeId: id(3) }).success, false);
  assert.equal(objectionInput.safeParse({ ...common, kind: 'passage', assetId: id(4), claimKey: 'clm.k1' }).success, true);
  assert.equal(objectionInput.safeParse({ ...common, kind: 'answer', askId: id(5) }).success, true);
  assert.equal(objectionInput.safeParse({ ...common, kind: 'place', placeId: id(3) }).success, false, 'a place is doubted by setting it aside');
});

test('pages say there is more exactly when they carry a cursor (M7, M8)', () => {
  const list = { privacyEpoch: 0, relics: [place], recordingPaused: false };
  const cursor = relicCursor('2026-09-25T10:00:00.000001Z', id(2));
  assert.equal(relicsResponse.safeParse({ ...list, nextPage: null }).success, true);
  assert.equal(relicsResponse.safeParse({ ...list, nextPage: cursor }).success, false, 'a next page only after a full one');
  assert.equal(relicsResponse.safeParse({ ...list, relics: Array.from({ length: 100 }, () => place), nextPage: cursor }).success, true);
  assert.equal(relicsResponse.safeParse({ ...list, nextPage: 'anything' }).success, false);
  const item = (ms: number) => ({ kind: 'nothing_found', at: at(ms), inquiryId: id(ms), pairs: [{ a: concept('a.b', 'A'), b: concept('c.d', 'C') }] });
  const ten = Array.from({ length: 10 }, (_, i) => item(100 - i));
  const page = { privacyEpoch: 0, since: null, items: ten, more: 3, recordingPaused: false };
  assert.equal(awayResponse.safeParse({ ...page, nextPage: awayCursor({ kind: 'nothing_found', at: at(91), key: id(91) }) }).success, true);
  assert.equal(awayResponse.safeParse({ ...page, nextPage: null }).success, false, 'more without a way to see it');
  assert.equal(awayResponse.safeParse({ ...page, more: 0, nextPage: awayCursor({ kind: 'nothing_found', at: at(91), key: id(91) }) }).success, false);
  const passages = { privacyEpoch: 0, assetId: id(4), revision: 1, recordingPaused: false,
    passages: [{ claimKey: 'clm.k1', statement: 'Every mass attracts every other mass.', withdrawn: false, kept: false, seemsWrong: false }] };
  assert.equal(passagesResponse.safeParse(passages).success, true);
  assert.equal(passagesResponse.safeParse({ ...passages, passages: [{ ...passages.passages[0], sourceTitle: 'NASA' }] }).success, false);
});

test('found and corrected connections on the return say whether this reader objected (M5)', () => {
  assert.equal(awayItem.safeParse({ kind: 'connection_found', at: at(1), inquiryId: id(1), found, seemsWrong: true }).success, true);
  assert.equal(awayItem.safeParse({ kind: 'connection_found', at: at(1), inquiryId: id(1), found }).success, false);
  const corrected = { kind: 'connection_corrected', at: at(1), bridgeId: id(1), status: 'revoked', fromConcept: found.fromConcept, toConcept: found.toConcept };
  assert.equal(awayItem.safeParse({ ...corrected, seemsWrong: false }).success, true);
  assert.equal(awayItem.safeParse(corrected).success, false);
});
