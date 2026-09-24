/**
 * #162 — the pure Scroll-writing boundary (ADR-0041 §3–§5): the request is bounded and offers the
 * plan's concepts and the material; the reply must be exactly one JSON object; and every
 * deterministic check refuses what it names. The material and every draft here are hand-written
 * fixtures, not page text and not model output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkScrollDraft, judgeScrollReply, MATERIAL_MARKER, OFFERED_CONCEPTS_MARKER, parseScrollReply, SCROLL_LIMITS,
  SCROLL_WRITING_VERSIONS, scrollPlanItem, serializeScrollWritingRequest, type ScrollDraft,
} from '../packages/core/src/scrolls/writing.ts';
import { normalizeSnapshotText } from '../packages/core/src/semantic/source-text.ts';

const MATERIAL = normalizeSnapshotText(`Fixture material, written by hand for tests. The Moon pulls on the whole Earth, but it pulls hardest on the side that faces it.
  Water on that side is drawn into a bulge, and a second bulge forms on the far side, where the pull is weakest.
  As Earth turns, a coast passes through both bulges, so many shores see two high tides and two low tides every day.
  When the Sun and the Moon line up, their pulls add together and the tides grow larger; these are called spring tides.
  When the two pull at right angles, the tides are smaller; these are called neap tides.
  The shape of a coastline and the depth of the water change how high a local tide can rise.`);
const OFFERED = [
  { code: 'earth.tides', name: 'Tides', description: 'The regular rise and fall of the ocean surface at the coast.' },
  { code: 'physics.gravity', name: 'Gravity', description: 'The attractive force between any two objects that have mass.' },
];
const KNOWN = new Set(['earth.tides', 'physics.gravity', 'astro.sun']);
const context = { material: MATERIAL, offered: OFFERED.map(c => c.code), known: KNOWN };
const route = { model: 'MiniMax-M3', maxOutputTokens: SCROLL_LIMITS.maxOutputTokens };

const draft = (): ScrollDraft => ({
  title: 'Two bulges, one turning planet',
  summary: 'Why most coasts get two high tides a day, not one.',
  beats: [
    'Picture the ocean as a loose coat around Earth. The Moon tugs on everything, yet it tugs a little harder on whatever sits closest.',
    'That uneven tug stretches the coat into two swellings: one toward the Moon and one on the opposite face.',
    'Earth spins beneath both swellings, so a harbour rides up and down twice as the day goes by.',
  ],
  concepts: [{ code: 'earth.tides', role: 'primary' }, { code: 'physics.gravity', role: 'secondary' }],
  claims: [
    { statement: 'The Moon pulls hardest on the side of Earth that faces it.', truthState: 'documented',
      concepts: [{ code: 'physics.gravity', role: 'mechanism' }, { code: 'earth.tides', role: 'subject' }],
      quote: 'it pulls hardest on the side that faces it', supportKind: 'supports' },
    { statement: 'Many coasts have two high tides and two low tides each day.', truthState: 'documented',
      concepts: [{ code: 'earth.tides', role: 'subject' }],
      quote: 'many shores see two high tides and two low tides every day', supportKind: 'supports' },
  ],
});
const reasonsOf = (change: (d: ScrollDraft) => void) => {
  const d = draft();
  change(d);
  const verdict = checkScrollDraft(d, context);
  return verdict.ok ? [] : verdict.reasons;
};

test('the request is at most 16 KB, offers the concepts, and trims the material at a word', () => {
  const long = Array.from({ length: 60 }, (_, i) => `${MATERIAL} (${i})`).join(' ');
  const { body, materialChars } = serializeScrollWritingRequest({ material: long, concepts: OFFERED }, route);
  assert.ok(body.length <= SCROLL_LIMITS.requestBytes, `${body.length} bytes`);
  assert.ok(body.length > SCROLL_LIMITS.requestBytes - 200, 'the budget is used, not wasted');
  const request = JSON.parse(new TextDecoder().decode(body)) as { model: string; max_tokens: number; thinking: unknown; messages: { content: string }[] };
  assert.equal(request.model, 'MiniMax-M3');
  assert.equal(request.max_tokens, 4096);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  const content = request.messages[0]!.content;
  const offered = content.slice(content.indexOf(`${MATERIAL_MARKER}\n`) + MATERIAL_MARKER.length + 1);
  assert.equal(offered.length, materialChars);
  assert.ok(long.startsWith(offered), 'an exact prefix of the material');
  assert.equal(long[materialChars], ' ', 'cut between words');
  const concepts = JSON.parse(content.slice(content.indexOf(`${OFFERED_CONCEPTS_MARKER}\n`) + OFFERED_CONCEPTS_MARKER.length + 1, content.indexOf(`\n\n${MATERIAL_MARKER}`)));
  assert.deepEqual(concepts, OFFERED.map(c => ({ code: c.code, description: c.description, name: c.name })));
  assert.deepEqual(serializeScrollWritingRequest({ material: long, concepts: OFFERED }, route).body, body, 'equal inputs, equal bytes');

  const short = serializeScrollWritingRequest({ material: MATERIAL, concepts: OFFERED }, route);
  assert.equal(short.materialChars, MATERIAL.length, 'a short page is offered whole');
});

test('a plan item names an https URL and one to eight distinct concept codes', () => {
  assert.ok(scrollPlanItem.safeParse({ url: 'https://science.nasa.gov/sun/facts/', conceptCodes: ['astro.sun'] }).success);
  for (const bad of [
    { url: 'https://science.nasa.gov/sun/facts/', conceptCodes: [] },
    { url: 'https://science.nasa.gov/sun/facts/', conceptCodes: ['astro.sun', 'astro.sun'] },
    { url: 'https://science.nasa.gov/sun/facts/', conceptCodes: Array.from({ length: 9 }, (_, i) => `c${i}`) },
    { url: 'https://science.nasa.gov/sun/facts/', conceptCodes: ['Not A Code'] },
    { url: 'https://science.nasa.gov/sun/facts/', conceptCodes: ['astro.sun'], extra: 1 },
  ]) assert.equal(scrollPlanItem.safeParse(bad).success, false, JSON.stringify(bad));
});

test('the reply is exactly one JSON object: bare, fenced, or after a think block; nothing else', () => {
  const json = JSON.stringify(draft());
  assert.equal(parseScrollReply(json).kind, 'draft');
  assert.equal(parseScrollReply(`\`\`\`json\n${json}\n\`\`\``).kind, 'draft');
  assert.equal(parseScrollReply(`<think>tides, bulges</think>\n${json}`).kind, 'draft');
  assert.deepEqual(parseScrollReply(`Here is the Scroll: ${json}`), { kind: 'shape', reason: 'not_one_json_object' });
  assert.deepEqual(parseScrollReply('[]'), { kind: 'shape', reason: 'not_one_json_object' });
  assert.deepEqual(parseScrollReply(JSON.stringify({ ...draft(), source: 'x' })), { kind: 'shape', reason: 'reply_keys' });
  assert.deepEqual(parseScrollReply(JSON.stringify({ ...draft(), beats: 'one long beat' })), { kind: 'shape', reason: 'shape_invalid' });
  const claims = draft().claims;
  assert.deepEqual(parseScrollReply(JSON.stringify({ ...draft(), claims: [{ ...claims[0], truthState: 'synthesis' }, claims[1]] })), { kind: 'shape', reason: 'shape_invalid' });
  assert.deepEqual(parseScrollReply(JSON.stringify({ ...draft(), concepts: [{ code: 'earth.tides', role: 'mentioned' }] })), { kind: 'shape', reason: 'shape_invalid' });
  assert.deepEqual(parseScrollReply(JSON.stringify({ ...draft(), title: 'A\u0000B title here' })), { kind: 'shape', reason: 'shape_invalid' });
  assert.deepEqual(judgeScrollReply('not json', context), { ok: false, reasons: ['not_one_json_object'], checksVersion: SCROLL_WRITING_VERSIONS.checks });
});

test('a good draft passes, normalized, with the beats as its paragraphs', () => {
  const d = draft();
  d.title = '  Two bulges, one turning   planet ';
  d.claims[0]!.quote = 'it pulls   hardest on the side that faces it';
  const verdict = checkScrollDraft(d, context);
  assert.ok(verdict.ok, JSON.stringify(verdict));
  assert.equal(verdict.checksVersion, 'scroll-checks-v1');
  assert.equal(verdict.scroll.title, 'Two bulges, one turning planet');
  assert.equal(verdict.scroll.claims[0]!.quote, 'it pulls hardest on the side that faces it', 'the stored quote is an exact passage');
  assert.equal(verdict.scroll.body, draft().beats.join('\n\n'));
});

test('quote_not_in_material: a claim quote that is not an exact passage of the stored material', () => {
  assert.deepEqual(reasonsOf(d => { d.claims[1]!.quote = 'many shores see three high tides every single day'; }), ['quote_not_in_material']);
  // Word for word but with a changed word order is still not the material.
  assert.deepEqual(reasonsOf(d => { d.claims[0]!.quote = 'it pulls hardest on the side facing it'; }), ['quote_not_in_material']);
});

test('copied_passage: more than 8 consecutive words of the material in the title, summary or a beat', () => {
  // 8 shared words in a row is the bench limit and passes; 9 is copying.
  assert.deepEqual(reasonsOf(d => { d.beats[2] = 'While Earth turns a coast passes through both bulges, and the harbour water climbs twice.'; }), []);
  assert.deepEqual(reasonsOf(d => { d.beats[2] = 'As Earth turns, a coast passes through both bulges, and the harbour water climbs twice.'; }), ['copied_passage']);
  // Case and punctuation do not disguise a copy.
  assert.deepEqual(reasonsOf(d => { d.summary = 'WHEN THE TWO PULL AT RIGHT-ANGLES, THE TIDES ARE SMALLER.'; }), ['copied_passage']);
  assert.deepEqual(reasonsOf(d => { d.title = 'The shape of a coastline and the depth of the water'; }), ['copied_passage']);
  // The claims are exempt: their quotes are verbatim by design and their statements are the checked facts.
  assert.deepEqual(reasonsOf(d => { d.claims[1]!.statement = 'As Earth turns, a coast passes through both bulges, so many shores see two high tides.'; }), []);
});

test('mentions_web_address: readers never see a source', () => {
  assert.deepEqual(reasonsOf(d => { d.beats[1] = 'Read more at https://example.test/tides about the two swellings on each side.'; }), ['mentions_web_address']);
  assert.deepEqual(reasonsOf(d => { d.summary = 'See www.example.test for why coasts get two tides.'; }), ['mentions_web_address']);
});

test('length and shape limits', () => {
  assert.deepEqual(reasonsOf(d => { d.title = 'Tides'; }), ['title_length']);
  assert.deepEqual(reasonsOf(d => { d.title = 'T'.repeat(91); }), ['title_length']);
  assert.deepEqual(reasonsOf(d => { d.summary = 'Two a day.'; }), ['summary_length']);
  assert.deepEqual(reasonsOf(d => { d.beats = d.beats.slice(0, 2); }), ['beat_count']);
  assert.deepEqual(reasonsOf(d => { d.beats = Array.from({ length: 8 }, (_, i) => `Beat number ${i + 1} walks the reader one small step further along.`); }), ['beat_count']);
  assert.deepEqual(reasonsOf(d => { d.beats[0] = 'Too short a beat.'; }), ['beat_length']);
  assert.deepEqual(reasonsOf(d => { d.beats[0] = 'word '.repeat(141); }), ['beat_length']);
  assert.deepEqual(reasonsOf(d => { d.claims = d.claims.slice(0, 1); }), ['claim_count']);
  assert.deepEqual(reasonsOf(d => { d.claims = Array.from({ length: 7 }, () => draft().claims[1]!); }), ['claim_count']);
  assert.deepEqual(reasonsOf(d => { d.claims[0]!.statement = 'Tides.'; }), ['statement_length']);
  assert.deepEqual(reasonsOf(d => { d.claims[0]!.quote = 'faces it'; }), ['quote_length']);
});

test('concepts: known, offered, exactly one primary, no duplicates, and every claim names an offered one', () => {
  assert.deepEqual(reasonsOf(d => { d.concepts.push({ code: 'earth.volcanoes', role: 'secondary' }); }), ['concept_unknown', 'concept_not_offered']);
  assert.deepEqual(reasonsOf(d => { d.claims[0]!.concepts.push({ code: 'earth.volcanoes', role: 'context' }); }), ['concept_unknown']);
  assert.deepEqual(reasonsOf(d => { d.concepts.push({ code: 'astro.sun', role: 'secondary' }); }), ['concept_not_offered']);
  assert.deepEqual(reasonsOf(d => { d.concepts[1]!.role = 'primary'; }), ['primary_not_one']);
  assert.deepEqual(reasonsOf(d => { d.concepts[0]!.role = 'secondary'; }), ['primary_not_one']);
  assert.deepEqual(reasonsOf(d => { d.concepts.push({ code: 'physics.gravity', role: 'secondary' }); }), ['duplicate_concept']);
  assert.deepEqual(reasonsOf(d => { d.claims[1]!.concepts.push({ code: 'earth.tides', role: 'subject' }); }), ['duplicate_concept']);
  // A claim may also name a known concept that was not offered, but it must name an offered one.
  assert.deepEqual(reasonsOf(d => { d.claims[1]!.concepts = [{ code: 'astro.sun', role: 'subject' }]; }), ['claim_concept_not_offered']);
  assert.deepEqual(reasonsOf(d => { d.claims[1]!.concepts.push({ code: 'astro.sun', role: 'context' }); }), []);
});

test('no_supporting_claim: a qualifying quote alone supports nothing', () => {
  assert.deepEqual(reasonsOf(d => { for (const c of d.claims) c.supportKind = 'qualifies'; }), ['no_supporting_claim']);
  assert.deepEqual(reasonsOf(d => { d.claims[1]!.supportKind = 'qualifies'; }), []);
});

test('every failing check is reported together, in a fixed order', () => {
  assert.deepEqual(reasonsOf(d => {
    d.title = 'Tides';
    d.claims[1]!.quote = 'a sentence the material never contained';
    d.concepts[0]!.role = 'secondary';
  }), ['quote_not_in_material', 'title_length', 'primary_not_one']);
});
