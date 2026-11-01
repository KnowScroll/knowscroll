import { describe, expect, it } from 'vitest';
import {
  UNSUPPORTED_HINTS,
  UNSUPPORTED_KINDS,
  checkedRecord,
  contentStems,
  isAbout,
  isQuestion,
  mayStateNoFact,
  namesTheGap,
  passes,
  quoteIsIn,
  splitSentences,
  sharedStems,
  statesFigure,
  tooManyNoClaims,
  uncheckedRecord,
  unsupportedOf,
  wordsOf,
  type SentenceVerdict,
} from './ask-support.js';

describe('the sentences of a text (labelled CI text, an invented planet)', () => {
  it('splits at sentence ends and keeps a decimal point, a degree and a quotation inside their sentence', () => {
    expect(
      splitSentences('Orrin tilts by 23.4 degrees. Is that a lot? “Yes,” said the keeper. It is.  The seasons follow.'),
    ).toEqual([
      'Orrin tilts by 23.4 degrees.',
      'Is that a lot?',
      '“Yes,” said the keeper.',
      'It is.',
      'The seasons follow.',
    ]);
  });

  it('never leaves half a sentence at an abbreviation', () => {
    expect(splitSentences('Dr. Veld measured it, e.g. at dusk. Fig. 2 shows the result.')).toEqual([
      'Dr. Veld measured it, e.g. at dusk.',
      'Fig. 2 shows the result.',
    ]);
  });

  it('gives nothing for empty text and one sentence for text with no end mark', () => {
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('A beam with no full stop')).toEqual(['A beam with no full stop']);
  });
});

describe('a quote must be words of the passage it claims to come from', () => {
  const passage = 'The tower stands twenty-one metres tall, which places the lamp high enough to clear distant waves.';

  it('accepts the words in order, whatever the case, punctuation or typography', () => {
    expect(quoteIsIn('stands twenty-one metres tall', passage)).toBe(true);
    expect(quoteIsIn('the LAMP high ENOUGH', passage)).toBe(true);
    expect(wordsOf('It’s “quoted”, and—dashed')).toEqual(["it's", 'quoted', 'and', 'dashed']);
  });

  it('refuses words that are not there, words out of order and an empty quote', () => {
    expect(quoteIsIn('stands thirty metres tall', passage)).toBe(false);
    expect(quoteIsIn('tall metres stands', passage)).toBe(false);
    expect(quoteIsIn('   ', passage)).toBe(false);
    expect(quoteIsIn('stands', '')).toBe(false);
  });
});

describe('what counts as a claim', () => {
  it('treats any sentence with a number as stating a fact', () => {
    expect(statesFigure('The tilt is 23.4 degrees.')).toBe(true);
    expect(statesFigure('It spins about once a day.')).toBe(false);
  });

  it('does not believe a reply that marks most sentences as stating no fact', () => {
    const marks = (...verdicts: string[]) => verdicts.map((verdict) => ({ verdict }));
    expect(tooManyNoClaims(marks('no_claim', 'supported'))).toBe(false);
    expect(tooManyNoClaims(marks('no_claim', 'no_claim', 'supported'))).toBe(true);
    expect(tooManyNoClaims(marks('no_claim', 'supported', 'supported', 'supported'))).toBe(false);
  });
});

describe('what a check decides', () => {
  const verdicts: SentenceVerdict[] = [
    { number: 1, verdict: 'supported', quote: 'the lamp high enough' },
    { number: 2, verdict: 'unsupported', kind: 'goes_beyond', problem: 'The passage says narrower.' },
    { number: 3, verdict: 'no_claim' },
  ];

  it('keeps the numbers and kinds of what was found, and never the sentences or the checker’s words', () => {
    const record = checkedRecord(1, verdicts);
    expect(record).toEqual({
      draft: 1,
      kind: 'checked',
      sentences: 3,
      unsupported: [{ number: 2, kind: 'goes_beyond' }],
    });
    expect(JSON.stringify(record)).not.toContain('narrower');
    expect(unsupportedOf(verdicts)).toHaveLength(1);
  });

  it('lets an answer through only on a check that gave verdicts and found nothing unsupported', () => {
    expect(passes(checkedRecord(1, verdicts))).toBe(false);
    expect(passes(checkedRecord(2, [verdicts[0]!, verdicts[2]!]))).toBe(true);
    // No usable check is never a pass: an ask order is served to nobody who has not been checked for.
    expect(passes(uncheckedRecord(1, 3, 'invalid_output'))).toBe(false);
  });

  it('has a fixed hint for every kind, in code', () => {
    for (const kind of UNSUPPORTED_KINDS) expect(UNSUPPORTED_HINTS[kind].length).toBeGreaterThan(20);
  });
});

describe('the key words that tie a quote to a sentence (B1.2)', () => {
  it('are the uncommon words of three letters or more, cut to five letters, once each, with numbers and spelled numbers left out', () => {
    expect(
      [...contentStems('The tower stands twenty-one metres tall, and the tower is 21 metres tall.')].sort(),
    ).toEqual(['metre', 'stand', 'tall', 'tower']);
    expect([...contentStems('It is a 3 or so, in the end.')]).toEqual(['end']);
  });

  it('count a word and its endings as one', () => {
    expect(sharedStems('The tower begins here', 'Beginning with towers')).toBe(2);
    expect(sharedStems('The beam', 'a prism ring around the flame')).toBe(0);
  });

  it('are shared at least twice, or all of them when the text has fewer', () => {
    const passage = 'Near the poles the Sun is never directly overhead';
    expect(isAbout('the Sun is', 'The Sun is nearly overhead at the pole in summer.')).toBe(false);
    expect(isAbout(passage, 'The Sun is nearly overhead at the pole in summer.')).toBe(true);
    // A heading of one key word needs that one; a text with no key word needs none.
    expect(isAbout('light into a single beam', 'The beam')).toBe(true);
    expect(isAbout('light into a single beam', 'Why?')).toBe(true);
  });
});

describe('which sentences may state no fact (B1.3)', () => {
  const cited = ['A prism ring around the flame gathers the light into a single beam that sweeps across the water.'];

  it('reads a figure written in words as a figure', () => {
    for (const text of ['Twenty-one crows nested.', 'A hundred crows nested.', 'About two thousand.', 'Three beams.'])
      expect(statesFigure(text)).toBe(true);
    expect(statesFigure('Many crows nested there.')).toBe(false);
  });

  it('recognises a question and a plain admission of a gap', () => {
    expect(isQuestion('Why does the beam turn?')).toBe(true);
    expect(isQuestion('“Why does it turn?”')).toBe(true);
    expect(isQuestion('The beam turns.')).toBe(false);
    for (const text of [
      'The pages do not say how the lamp was built.',
      'These passages never explain the colour.',
      'This answer cannot tell us about radio.',
      'It does not cover satellite navigation.',
      'This picture ignores radio and satellite navigation.',
      'Nothing in the pages gives the reason.',
    ])
      expect(namesTheGap(text)).toBe(true);
    expect(namesTheGap('The beam does not stop at the fog line.')).toBe(false);
    expect(namesTheGap('It does not stop the fog.')).toBe(false);
  });

  it('allows no fact for a question, a gap, or a label with no key word in the passages and no figure, and nothing else', () => {
    expect(mayStateNoFact('Why does the beam turn?', cited)).toBe(true);
    expect(mayStateNoFact('The pages do not say how.', cited)).toBe(true);
    expect(mayStateNoFact('Putting it together', cited)).toBe(true);
    expect(mayStateNoFact('The beam is narrow.', cited)).toBe(false);
    expect(mayStateNoFact('Seven crows nested.', cited)).toBe(false);
    expect(mayStateNoFact('7 crows nested.', cited)).toBe(false);
  });
});
