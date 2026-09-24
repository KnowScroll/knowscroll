/**
 * #132 — the pure background bridge inquiry boundary (ADR-0038 §5 and §7): which pairs of the
 * reader's places a model may be shown, the exact request bytes, and what provider text may become.
 * Each selection rule below has a test that turns red when the rule is removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BRIDGE_INQUIRY_LIMITS,
  parseBridgeInquiryReply,
  selectInquiryPairs,
  serializeBridgeInquiryRequest,
  type InquiryCandidateInput,
  type InquiryPair,
  type InquirySubstrateClaim,
} from '../packages/core/src/reasoning/bridge-inquiry.ts';

const place = (code: string, name: string) => ({ placeId: `00000000-0000-4000-8000-${createHash('sha256').update(code).digest('hex').slice(0, 12)}`, code, name });
const claim = (key: string, links: [string, 'subject' | 'object' | 'mechanism' | 'context'][], supported = true): InquirySubstrateClaim => ({
  key, statement: `Statement of ${key} that is long enough.`, sourceTitle: `Source for ${key}`, supported, links: links.map(([code, role]) => ({ code, role })),
});

const parentOf = new Map<string, string | null>([
  ['x.gravity', null], ['x.gravity.weight', 'x.gravity'], ['x.star', null], ['x.sun', 'x.star'], ['x.tides', null], ['x.body', null], ['x.moon', null],
]);
const places = [place('x.gravity', 'Gravity'), place('x.sun', 'The Sun'), place('x.tides', 'Tides'), place('x.body', 'Body')];
const claims: InquirySubstrateClaim[] = [
  claim('c.gravity.def', [['x.gravity', 'subject']]),
  claim('c.gravity.tides', [['x.gravity', 'mechanism'], ['x.tides', 'subject']]),
  claim('c.sun.identity', [['x.sun', 'subject']]),
  claim('c.star.hot', [['x.star', 'subject']]),
  claim('c.sun.held', [['x.gravity', 'mechanism'], ['x.sun', 'subject']]),
  claim('c.sun.context', [['x.sun', 'context']]),
  claim('c.sun.unsupported', [['x.sun', 'subject']], false),
  claim('c.tides.cycle', [['x.tides', 'subject']]),
  claim('c.body.stable', [['x.body', 'subject']]),
];
const base: InquiryCandidateInput = { places, parentOf, claims, connections: [{ from: 'x.gravity', to: 'x.tides' }], suppressed: [], asked: [] };
const codes = (pairs: InquiryPair[]) => pairs.map(p => `${p.a.code}~${p.b.code}`);
// A second admissible pair: Body explains Moon, and Moon has a claim of its own.
const withMoon: InquiryCandidateInput = { ...base, places: [...places, place('x.moon', 'Moon')],
  claims: [...claims, claim('c.body.moon', [['x.body', 'mechanism'], ['x.moon', 'subject']]), claim('c.moon.own', [['x.moon', 'subject']])] };
const keys = (list: { key: string }[]) => list.map(c => c.key);

test('only pairs the validator could admit are offered: a claim naming both, and each side a claim of its own (review I1)', () => {
  const pairs = selectInquiryPairs(base);
  // Body has claims of its own but none naming it with anyone: its pairs could only ever be refused.
  assert.deepEqual(codes(pairs), ['x.gravity~x.sun']);
  // A naming claim alone is not enough: The Sun also needs a claim that is its own.
  const noSunOwn = selectInquiryPairs({ ...base, claims: claims.filter(c => !['c.sun.identity', 'c.star.hot'].includes(c.key)) });
  assert.ok(!codes(noSunOwn).includes('x.gravity~x.sun'));
});

test('pairs that name both anchors come first, then concept codes; never more than three', () => {
  const pairs = selectInquiryPairs(withMoon);
  assert.deepEqual(codes(pairs), ['x.body~x.moon', 'x.gravity~x.sun']);
  assert.ok(pairs.length <= BRIDGE_INQUIRY_LIMITS.maxPairs);
  const first = pairs.find(p => p.a.code === 'x.gravity');
  // Claims about each anchor (exact concept first, then broader), supported only, never a context mention.
  assert.deepEqual(keys(first!.claimsA), ['c.gravity.def', 'c.gravity.tides']);
  assert.deepEqual(keys(first!.claimsB), ['c.sun.identity', 'c.star.hot']);
  assert.deepEqual(keys(first!.both), ['c.sun.held']);
  assert.deepEqual(first!.claimsB[0], { key: 'c.sun.identity', statement: 'Statement of c.sun.identity that is long enough.', sourceTitle: 'Source for c.sun.identity' });
});

test('the order is deterministic whatever order the inputs arrive in', () => {
  const shuffled = { ...base, places: [...places].reverse(), claims: [...claims].reverse() };
  assert.deepEqual(selectInquiryPairs(shuffled), selectInquiryPairs(base));
});

test('a pair already connected, in either direction, is never offered', () => {
  const without = selectInquiryPairs({ ...base, connections: [] });
  assert.deepEqual(codes(without).slice(0, 2), ['x.gravity~x.sun', 'x.gravity~x.tides'], 'without the relation, that pair names both and is offered');
  assert.ok(!codes(selectInquiryPairs(base)).includes('x.gravity~x.tides'));
  const reversed = selectInquiryPairs({ ...base, connections: [{ from: 'x.sun', to: 'x.gravity' }, { from: 'x.gravity', to: 'x.tides' }] });
  assert.ok(!codes(reversed).includes('x.gravity~x.sun'));
});

test('a pair the reader said seems wrong, or one already put to an inquiry this epoch, is not offered again', () => {
  assert.ok(!codes(selectInquiryPairs({ ...base, suppressed: [{ from: 'x.sun', to: 'x.gravity' }] })).includes('x.gravity~x.sun'));
  assert.ok(!codes(selectInquiryPairs({ ...base, asked: [['x.gravity', 'x.sun']] })).includes('x.gravity~x.sun'));
  assert.ok(!codes(selectInquiryPairs({ ...base, asked: [['x.sun', 'x.gravity']] })).includes('x.gravity~x.sun'), 'either order');
});

test('a place and its own parent or ancestor are depth, not a pair', () => {
  const pairs = selectInquiryPairs({ ...base, places: [place('x.gravity', 'Gravity'), place('x.gravity.weight', 'Weight')],
    claims: [...claims, claim('c.weight', [['x.gravity.weight', 'subject']])] });
  assert.deepEqual(pairs, []);
});

test('a side with no supported claim about it cannot be bridged, so its pairs are not offered', () => {
  const pairs = selectInquiryPairs({ ...base, places: [...places, place('x.moon', 'The Moon')] });
  assert.ok(pairs.every(p => p.a.code !== 'x.moon' && p.b.code !== 'x.moon'));
  const unsupportedOnly = selectInquiryPairs({ ...base, places: [place('x.sun', 'The Sun'), place('x.moon', 'The Moon')],
    claims: [...claims, claim('c.moon.only', [['x.moon', 'subject']], false)] });
  assert.deepEqual(unsupportedOnly, []);
});

test('at most eight claims per anchor and eight naming both', () => {
  const many = Array.from({ length: 12 }, (_, i) => claim(`c.body.${String(i).padStart(2, '0')}`, [['x.body', 'subject']]));
  const bridging = Array.from({ length: 11 }, (_, i) => claim(`c.body.sun.${String(i).padStart(2, '0')}`, [['x.body', 'subject'], ['x.sun', 'object']]));
  const pairs = selectInquiryPairs({ ...base, places: [place('x.body', 'Body'), place('x.sun', 'The Sun')], claims: [...claims, ...many, ...bridging] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.claimsA.length, BRIDGE_INQUIRY_LIMITS.claimsPerAnchor);
  assert.equal(pairs[0]!.both.length, BRIDGE_INQUIRY_LIMITS.claimsBoth);
  assert.equal(pairs[0]!.claimsA[0]!.key, 'c.body.00');
});

const route = { model: 'MiniMax-M3', maxOutputTokens: 2048 };

test('the request bytes are a deterministic function of the sealed pairs and the route, and carry no identifiers', () => {
  const pairs = selectInquiryPairs(withMoon);
  const a = serializeBridgeInquiryRequest(pairs, route);
  const b = serializeBridgeInquiryRequest(structuredClone(pairs), { ...route });
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
  const request = JSON.parse(new TextDecoder().decode(a));
  assert.equal(request.model, 'MiniMax-M3');
  assert.equal(request.max_tokens, 2048);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.messages.length, 1);
  assert.match(request.system, /exactly one JSON object/);
  assert.match(request.system, /\{"none": true\}/);
  assert.match(request.system, /"proposal"/);
  assert.match(request.system, /all offered for that pair/i);
  const content: string = request.messages[0].content;
  for (const c of [...pairs[0]!.claimsA, ...pairs[0]!.both]) assert.ok(content.includes(c.statement) && content.includes(c.key));
  assert.ok(pairs.every(p => !content.includes(p.a.placeId) && !content.includes(p.b.placeId)), 'no place ids leave the process');
  const changed = serializeBridgeInquiryRequest(pairs.slice(0, 1), route);
  assert.notEqual(Buffer.compare(Buffer.from(a), Buffer.from(changed)), 0);
});

const pairs = selectInquiryPairs(base);
const sunGravity = pairs.findIndex(p => p.a.code === 'x.gravity' && p.b.code === 'x.sun');
const compare = (pair: InquiryPair) => pair.admissible.findIndex(r => r.relationType === 'compares_mechanism');
// Reply v2 (prompt v4): indexes, cited keys and prose; the system composes the typed proposal.
const proposal = (over: Record<string, unknown> = {}) => ({
  pair: sunGravity, relation: compare(pairs[sunGravity]!),
  mechanism: 'The Sun keeps Earth on a closed path because its gravity bends the planet toward it every moment of the year.',
  prerequisites: [{ statement: 'Masses attract one another' }],
  limitations: [{ kind: 'analogy_limit', statement: 'The comparison stops at the scale of the solar system' }],
  cite: ['c.sun.identity', 'c.gravity.def', 'c.sun.held'],
  counterevidence: { disposition: 'searched_none_found', searchedScope: 'the offered claims', claimKeys: [] },
  ...over,
});
const reply = (value: unknown) => JSON.stringify(value);

test('the system composes the typed proposal: the direction from the chosen admissible entry, each side from where a claim was offered', () => {
  const parsed = parseBridgeInquiryReply(reply({ proposal: proposal() }), pairs);
  assert.equal(parsed.kind, 'proposal');
  if (parsed.kind !== 'proposal') return;
  assert.deepEqual([parsed.payload.relationType, parsed.payload.fromConcept, parsed.payload.toConcept], ['compares_mechanism', 'x.gravity', 'x.sun']);
  assert.deepEqual(parsed.payload.evidence, [
    { claimKey: 'c.sun.identity', supports: 'to' }, { claimKey: 'c.gravity.def', supports: 'from' }, { claimKey: 'c.sun.held', supports: 'mechanism' },
  ]);
  // "explains" goes only the way the claims carry it: Gravity explains The Sun, never the reverse.
  const explains = pairs[sunGravity]!.admissible.findIndex(r => r.relationType === 'explains');
  const e = parseBridgeInquiryReply(reply({ proposal: proposal({ relation: explains }) }), pairs);
  assert.ok(e.kind === 'proposal' && e.payload.fromConcept === 'x.gravity' && e.payload.toConcept === 'x.sun');
});

test('"none" is an honest answer; reasoning blocks and one fenced block are tolerated like the answer path', () => {
  assert.deepEqual(parseBridgeInquiryReply('{"none": true}', pairs), { kind: 'none' });
  assert.deepEqual(parseBridgeInquiryReply('<think>maybe gravity?</think>\n{"none":true}', pairs), { kind: 'none' });
  assert.equal(parseBridgeInquiryReply('```json\n' + reply({ proposal: proposal() }) + '\n```', pairs).kind, 'proposal');
});

test('anything else is a shape rejection, and says which rule it broke', () => {
  const shape = (text: string) => { const r = parseBridgeInquiryReply(text, pairs); return r.kind === 'shape' ? r.reasons : r.kind; };
  assert.deepEqual(shape('I think gravity connects them. {"none": true}'), ['shape', 'not_one_json_object']);
  assert.deepEqual(shape('{"none": true}{"none": true}'), ['shape', 'not_one_json_object']);
  assert.deepEqual(shape('[{"none": true}]'), ['shape', 'not_one_json_object']);
  assert.deepEqual(shape('{"none": false}'), ['shape', 'reply_keys']);
  assert.deepEqual(shape('{"none": true, "why": "nothing"}'), ['shape', 'reply_keys']);
  assert.deepEqual(shape(reply({ proposal: proposal({ mechanism: 'too short' }) })), ['shape', 'payload_invalid']);
  assert.deepEqual(shape(reply({ proposal: proposal({ extra: 1 }) })), ['shape', 'payload_invalid']);
  assert.deepEqual(shape(reply({ proposal: proposal({ fromConcept: 'x.gravity' }) })), ['shape', 'payload_invalid'], 'the model never names the direction itself');
  assert.deepEqual(shape(reply({ proposal: proposal({ pair: 9 }) })), ['shape', 'pair_not_offered']);
  assert.deepEqual(shape(reply({ proposal: proposal({ relation: 9 }) })), ['shape', 'relation_not_admissible']);
  assert.deepEqual(shape(reply({ proposal: proposal({ cite: ['c.sun.identity', 'c.gravity.def', 'c.gravity.invented'] }) })), ['shape', 'claim_not_offered']);
  assert.deepEqual(shape(reply({ proposal: proposal({ counterevidence: { disposition: 'listed', searchedScope: 'offered claims', claimKeys: ['c.body.stable'] } }) })), ['shape', 'claim_not_offered'],
    'a claim offered for another pair is not offered for this one');
  assert.deepEqual(shape(reply({ proposal: proposal({ cite: ['c.sun.held'] }) })), ['shape', 'payload_invalid'], 'fewer than three distinct cited claims');
});

test('the request tells the model what the validator judges: each side\'s role in a claim naming both, and only admissible relation types', () => {
  const pair = selectInquiryPairs(base).find(p => p.a.code === 'x.gravity' && p.b.code === 'x.sun')!;
  const held = pair.both.find(c => c.key === 'c.sun.held')!;
  assert.deepEqual(held.roles, { 'x.gravity': 'mechanism', 'x.sun': 'subject' });
  const request = JSON.parse(new TextDecoder().decode(serializeBridgeInquiryRequest([pair], { model: 'm', maxOutputTokens: 100 })));
  const offered = JSON.parse(String(request.messages[0].content).split('\n').slice(1).join('\n'));
  assert.deepEqual(offered[0].claimsNamingBoth.find((c: { key: string }) => c.key === 'c.sun.held').roles, { 'x.gravity': 'mechanism', 'x.sun': 'subject' });
  // A new pair has no recorded relation, so "applies_to"/"prerequisite_for" could never be admitted.
  assert.doesNotMatch(request.system, /applies_to|prerequisite_for/);
  assert.match(request.system, /never one you cite/);
});

test('the request offers each pair only the relations its claims can carry, directions included, by index', () => {
  const pair = selectInquiryPairs(base).find(p => p.a.code === 'x.gravity' && p.b.code === 'x.sun')!;
  // c.sun.held gives Gravity the mechanism role and The Sun the subject role: only Gravity explains The Sun.
  assert.deepEqual(pair.admissible, [
    { relationType: 'explains', fromConcept: 'x.gravity', toConcept: 'x.sun' },
    { relationType: 'compares_mechanism', fromConcept: 'x.gravity', toConcept: 'x.sun' },
    { relationType: 'analogous_in', fromConcept: 'x.gravity', toConcept: 'x.sun' },
  ]);
  const request = JSON.parse(new TextDecoder().decode(serializeBridgeInquiryRequest([pair], { model: 'm', maxOutputTokens: 100 })));
  const offered = JSON.parse(String(request.messages[0].content).split('\n').slice(1).join('\n'));
  assert.deepEqual(offered[0].admissible, pair.admissible.map((r, index) => ({ index, ...r })));
  assert.equal(offered[0].index, 0);
  assert.match(request.system, /the index of one of that pair's "admissible" entries/);
});
