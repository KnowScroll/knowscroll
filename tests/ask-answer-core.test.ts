/**
 * #132 — the pure Ask-answer boundary (ADR-0033): the exact request bytes derived from a sealed Ask
 * context, and the validator that decides whether provider text may become an answer. Provider
 * content has no mutation authority of its own; only a proposal that passes here is applied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ASK_ANSWER_VERSIONS,
  serializeAskAnswerRequest,
  validateAskAnswerProposal,
  type AskAnswerSource,
} from '../packages/core/src/reasoning/ask-answer.ts';

const source: AskAnswerSource = {
  question: '  Why does the sea rise twice a day?\n',
  scroll: {
    title: 'A rhythm the ocean keeps',
    summary: 'Most coasts see two high tides and two low tides each day.',
    body: 'The Moon pulls on the ocean. Because Earth rotates through two bulges of water, most coasts see two high tides and two low tides every lunar day.\n\nLocal coastlines change the timing.',
    sourceTitle: 'NOAA · Tides and Water Levels',
    sourceUrl: 'https://oceanservice.noaa.gov/education/tutorial_tides/',
    truthState: 'documented',
  },
};
const route = { model: 'MiniMax-M3', maxOutputTokens: 1024 };
const good = (over: Record<string, unknown> = {}) => JSON.stringify({
  answer: 'Earth rotates through two bulges of water raised by the Moon, so a coast passes under a high tide twice in each lunar day.',
  basis: [{ quote: 'Earth rotates through two bulges of water' }, { quote: 'most coasts see two high tides and two low tides every lunar day' }],
  limits: 'Local coastlines change the timing.',
  ...over,
});

test('the request bytes are a deterministic function of the sealed question, Scroll and route', () => {
  const a = serializeAskAnswerRequest(source, route);
  const b = serializeAskAnswerRequest({ question: source.question, scroll: { ...source.scroll } }, { ...route });
  assert.equal(createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex'));
  const request = JSON.parse(new TextDecoder().decode(a));
  assert.equal(request.model, 'MiniMax-M3');
  assert.equal(request.max_tokens, 1024);
  assert.equal(request.messages.length, 1);
  // The literal question travels unchanged: no trimming or normalisation of what the reader asked.
  assert.ok(request.messages[0].content.includes(JSON.stringify(source.question)));
  assert.ok(request.messages[0].content.includes(source.scroll.body));
  assert.ok(!request.messages[0].content.includes('universe') && !request.system.includes('kept'), 'no personal history beyond the question');
  const changed = serializeAskAnswerRequest({ ...source, question: 'Why does the sea rise twice a day?' }, route);
  assert.notEqual(Buffer.compare(Buffer.from(a), Buffer.from(changed)), 0);
});

test('a proposal whose every basis quote is in the Scroll becomes an answer', () => {
  const verdict = validateAskAnswerProposal(good(), source);
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.equal(verdict.proposal.kind, 'answered');
  assert.equal(verdict.proposal.basis.length, 2);
  assert.equal(verdict.validatorVersion, ASK_ANSWER_VERSIONS.validator);
});

test('reasoning blocks and surrounding prose around the one JSON object are tolerated, nothing else is', () => {
  const wrapped = `<think>The reader asks about tides.</think>\nHere is the answer:\n${good()}`;
  assert.equal(validateAskAnswerProposal(wrapped, source).ok, true);
  const two = `${good()}\n${good()}`;
  assert.deepEqual(reasons(validateAskAnswerProposal(two, source)), ['not_one_json_object']);
  assert.deepEqual(reasons(validateAskAnswerProposal('The tides come from the Moon.', source)), ['not_one_json_object']);
});

test('a quote the Scroll does not contain is refused, even when the answer sounds right', () => {
  const invented = good({ basis: [{ quote: 'The Sun is the main cause of the daily tides' }] });
  assert.deepEqual(reasons(validateAskAnswerProposal(invented, source)), ['basis_not_in_source']);
  // Whitespace differences are tolerated; words are not.
  const spaced = good({ basis: [{ quote: 'Earth  rotates through\ntwo bulges of water' }] });
  assert.equal(validateAskAnswerProposal(spaced, source).ok, true);
});

test('"the Scroll does not say" is an honest outcome, with its limit stated', () => {
  const verdict = validateAskAnswerProposal(JSON.stringify({ answer: null, basis: [], limits: 'The Scroll does not discuss the Sun\'s role in tides.' }), source);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.proposal.kind, 'not_in_source');
  assert.deepEqual(reasons(validateAskAnswerProposal(JSON.stringify({ answer: null, basis: [], limits: '' }), source)), ['limits_missing']);
});

test('an answer must cite, stay bounded, and never characterise the reader', () => {
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: [] }), source)), ['basis_missing']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: 'x'.repeat(1201) }), source)), ['answer_too_long']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: 'You seem to love the ocean, so: the Moon pulls the water.' }), source)), ['characterizes_reader']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ extra: 'field' }), source)), ['shape_invalid', 'shape_keys']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: Array.from({ length: 5 }, () => ({ quote: 'Earth rotates through two bulges of water' })) }), source)), ['shape_invalid', 'shape_too_many_quotes']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: [{ text: 'Earth rotates through two bulges of water' }] }), source)), ['shape_invalid', 'shape_basis_item']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: [{ quote: 42 }] }), source)), ['shape_invalid', 'shape_basis_item']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: '   ' }), source)), ['shape_invalid', 'shape_empty_answer']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: true }), source)), ['shape_invalid', 'shape_types']);
});

function reasons(verdict: ReturnType<typeof validateAskAnswerProposal>): string[] {
  return verdict.ok ? [] : verdict.reasons;
}

test('v2 takes a quote as a bare string or an object with a string quote, drops every other key, and still checks it verbatim', () => {
  const bare = validateAskAnswerProposal(good({ basis: ['Earth rotates through two bulges of water'] }), source);
  assert.ok(bare.ok && bare.proposal.kind === 'answered');
  assert.deepEqual(bare.ok && bare.proposal.kind === 'answered' ? bare.proposal.basis : null, [{ quote: 'Earth rotates through two bulges of water' }]);
  const extra = validateAskAnswerProposal(good({ basis: [{ quote: 'Earth rotates through two bulges of water', where: 'paragraph 2', note: 'You seem curious' }] }), source);
  assert.ok(extra.ok && extra.proposal.kind === 'answered');
  assert.deepEqual(extra.ok && extra.proposal.kind === 'answered' ? extra.proposal.basis : null, [{ quote: 'Earth rotates through two bulges of water' }], 'other keys are never kept');
  assert.equal(extra.validatorVersion, 'ask-answer-v2');
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: ['The Moon is made of green cheese entirely'] }), source)), ['basis_not_in_source']);
});

test('review B1/I1/I6: whitespace quotes, empty limits, NUL bytes and second-person characterisations are rejected; ordinary "you" is not', () => {
  // B1: length is judged on the collapsed quote; an all-space or near-empty quote never grounds an answer.
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: ['            '] }), source)), ['basis_not_in_source']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: ['           a'] }), source)), ['basis_not_in_source']);
  // I1: everything the database would refuse is refused here first.
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ limits: '   ' }), source)), ['limits_missing']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: 'The Moon pulls\u0000 the water.' }), source)), ['shape_invalid', 'shape_types']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ limits: 'Local\u0000 coasts differ.' }), source)), ['shape_invalid', 'shape_types']);
  // I6: statements about the reader, in contracted and curly forms, are refused.
  for (const answer of ["You're clearly a curious person: the Moon pulls the water.", 'You\u2019re the kind who loves the sea; the Moon pulls the water.',
    'You must be fascinated by the ocean. The Moon pulls the water.', 'Your curiosity shows. The Moon pulls the water.']) {
    assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer }), source)), ['characterizes_reader'], answer);
  }
  // Ordinary second person about the subject is fine.
  const ordinary = validateAskAnswerProposal(good({ answer: 'If you are near a coast, you would see two high tides a day because Earth rotates through two bulges of water.' }), source);
  assert.ok(ordinary.ok, JSON.stringify(ordinary));
});

test('verification review: statements about the reader are refused; hypothetical second person and third-person description are not', () => {
  const tail = ' Earth rotates through two bulges of water.';
  for (const answer of ['You are curious about the sea.', 'Since you are interested in tides, here it is.', "You're fascinated by this.", "You're thoughtful to ask.",
    "You're clearly a curious person.", 'You\u2019re the kind who loves the sea.', 'You must be fascinated by the ocean.', 'Your curiosity shows.',
    'You seem to love the ocean.', 'You love this kind of thing.']) {
    assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: answer + tail }), source)), ['characterizes_reader'], answer);
  }
  for (const answer of ['If you are near a coast, you would see two high tides a day.', 'If you are a sailor, you plan around them.',
    'Measure it in whichever unit you prefer.', 'If you like, think of it as two bulges.', 'Darwin was the sort who collected everything.',
    'When you are standing on a beach you can watch it happen.']) {
    const verdict = validateAskAnswerProposal(good({ answer: answer + tail }), source);
    assert.ok(verdict.ok, `${answer} → ${JSON.stringify(verdict)}`);
  }
});

test('the Scroll\'s own words to its reader are not the model characterising the reader', () => {
  const speaking: AskAnswerSource = { ...source, scroll: { ...source.scroll,
    body: `You jump, and a moment later you\u2019re back on the ground. ${source.scroll.body}` } };
  const echo = validateAskAnswerProposal(good({ answer: "As the Scroll puts it, you're back on the ground a moment later; Earth rotates through two bulges of water." }), speaking);
  assert.ok(echo.ok, JSON.stringify(echo));
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ answer: "You're brilliant to ask. Earth rotates through two bulges of water." }), speaking)), ['characterizes_reader']);
});
