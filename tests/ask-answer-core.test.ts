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
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ extra: 'field' }), source)), ['shape_invalid']);
  assert.deepEqual(reasons(validateAskAnswerProposal(good({ basis: Array.from({ length: 5 }, () => ({ quote: 'Earth rotates through two bulges of water' })) }), source)), ['shape_invalid']);
});

function reasons(verdict: ReturnType<typeof validateAskAnswerProposal>): string[] {
  return verdict.ok ? [] : verdict.reasons;
}
