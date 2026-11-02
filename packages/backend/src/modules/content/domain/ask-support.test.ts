import { describe, expect, it } from 'vitest';
import {
  ASK_SUPPORT_BATCH_SENTENCES,
  RULE_CODES,
  RULE_PROBLEMS,
  UNSUPPORTED_HINTS,
  UNSUPPORTED_KINDS,
  batchesOf,
  checkedRecord,
  contentStems,
  MAX_LABEL_WORDS,
  MAX_SHORT_NO_CLAIM_WORDS,
  hasEnoughWords,
  isAbout,
  isAboutSentence,
  isQuestion,
  judgeVerdicts,
  namesTheGap,
  noClaimGround,
  passes,
  quoteIsIn,
  quoteParts,
  splitSentences,
  sharedStems,
  SHORT_SENTENCE_KEY_WORDS,
  statesFigure,
  uncheckedRecord,
  unsupportedOf,
  wordsOf,
  type SentenceUnderCheck,
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

  it('accepts a quote whose marks differ from the passage: curly or straight quotes, any dash, non-breaking and repeated spaces (real dev answers, labelled CI text)', () => {
    const real =
      'It is summer in June in the Northern Hemisphere because the Sun’s rays hit that part of Earth more directly\u00a0\u2014 and\u2009it is winter in December.';
    expect(quoteIsIn("because the Sun's rays hit that part of Earth more directly", real)).toBe(true);
    expect(quoteIsIn('“because the Sun’s rays”   hit that part', real)).toBe(true);
    expect(quoteIsIn('more directly - and it is winter', real)).toBe(true);
    expect(quoteIsIn('more directly—and it is winter', real)).toBe(true);
    expect(quoteIsIn('MORE DIRECTLY – AND IT IS WINTER', real)).toBe(true);
    expect(quoteIsIn("the Sun's  rays\nhit that part", real)).toBe(true);
  });

  it('reads a quote that leaves words out with an ellipsis as parts that stand in the passage in that order', () => {
    const real =
      'As Earth orbits the Sun, its tilted axis always points in the same direction, so one hemisphere leans toward the Sun for part of the year.';
    expect(quoteParts('its tilted axis … points in the same direction')).toEqual([
      ['its', 'tilted', 'axis'],
      ['points', 'in', 'the', 'same', 'direction'],
    ]);
    expect(quoteIsIn('its tilted axis … points in the same direction', real)).toBe(true);
    expect(quoteIsIn('its tilted axis ... points in the same direction', real)).toBe(true);
    expect(quoteIsIn('its tilted axis [...] points in the same direction', real)).toBe(true);
    // Out of order, or a part that is not there, is not a quote of the passage.
    expect(quoteIsIn('points in the same direction … its tilted axis', real)).toBe(false);
    expect(quoteIsIn('its tilted axis … never points anywhere', real)).toBe(false);
  });

  it('needs every part of an ellipsis quote in one sentence of the passage: two distant sentences are not stitched together (D-263)', () => {
    const two =
      'At the equator the days are about as long as the nights all year. Near the poles the Sun is never directly overhead.';
    expect(quoteIsIn('At the equator … never directly overhead', two)).toBe(false);
    expect(quoteIsIn('At the equator the days … about as long as the nights', two)).toBe(true);
    expect(quoteIsIn('Near the poles … never directly overhead', two)).toBe(true);
    // A quote without an ellipsis is the passage's own words in a row, as before.
    expect(quoteIsIn('all year. Near the poles', two)).toBe(true);
  });

  it('refuses an ellipsis quote that leaves out a negation, so it cannot say what the passage does not (D-263)', () => {
    const not = 'The Sun is not directly overhead near the poles in summer.';
    expect(quoteIsIn('The Sun is … directly overhead near the poles', not)).toBe(false);
    expect(quoteIsIn('The Sun is not directly … near the poles in summer', not)).toBe(true);
    const never = 'Near the poles the Sun is never directly overhead, because the planet’s axis is tilted a little.';
    expect(quoteIsIn('Near the poles the Sun is … directly overhead, because the planet’s axis', never)).toBe(false);
    for (const [passage, quote] of [
      ['The beam isn’t visible through fog on the coast.', 'The beam … visible through fog on the coast'],
      ['The lamp turns without any motor at the tower.', 'The lamp turns … any motor at the tower'],
      ['There is no light in the tower at midday.', 'There is … light in the tower at midday'],
    ] as const)
      expect(quoteIsIn(quote, passage)).toBe(false);
    // Words that are not negations may be left out, and a negation inside a part is the passage's own.
    expect(quoteIsIn('The lamp turns … at the tower', 'The lamp turns slowly and steadily at the tower.')).toBe(true);
    expect(quoteIsIn('Sun is not directly … in summer', not)).toBe(true);
    // A later place where the parts stand without the negation is enough.
    expect(
      quoteIsIn(
        'The Sun is … directly overhead',
        'The Sun is not directly overhead here. The Sun is often directly overhead there.',
      ),
    ).toBe(true);
  });

  it('reads the separators of a figure as part of it: "4,096" and "4096" are one word', () => {
    expect(wordsOf('It holds 4,096 values and 1,000,000 more, (1,2,3).')).toEqual([
      'it',
      'holds',
      '4096',
      'values',
      'and',
      '1000000',
      'more',
      '1',
      '2',
      '3',
    ]);
    expect(quoteIsIn('holds 4096 values', 'The table holds 4,096 values at most.')).toBe(true);
  });

  it('counts the words of every part of a quote that leaves words out: a lone word between two marks proves nothing', () => {
    expect(hasEnoughWords('its tilted axis … points in the same direction')).toBe(true);
    expect(hasEnoughWords('its tilted … axis')).toBe(false);
    expect(hasEnoughWords('tilted axis … points')).toBe(false);
    expect(hasEnoughWords('Sun — is')).toBe(false);
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
});

describe('what a check decides', () => {
  const verdicts: SentenceVerdict[] = [
    { number: 1, verdict: 'supported', quote: 'the lamp high enough' },
    { number: 2, verdict: 'unsupported', kind: 'goes_beyond', problem: 'The passage says narrower.' },
    { number: 3, verdict: 'no_claim' },
  ];

  it('keeps the numbers and kinds of what was found, and never the sentences or the checker’s words', () => {
    const record = checkedRecord(1, verdicts, 1);
    expect(record).toEqual({
      draft: 1,
      kind: 'checked',
      sentences: 3,
      batches: 1,
      unsupported: [{ number: 2, kind: 'goes_beyond' }],
    });
    expect(JSON.stringify(record)).not.toContain('narrower');
    expect(unsupportedOf(verdicts)).toHaveLength(1);
  });

  it('lets an answer through only on a check that gave verdicts and found nothing unsupported', () => {
    expect(passes(checkedRecord(1, verdicts, 1))).toBe(false);
    expect(passes(checkedRecord(2, [verdicts[0]!, verdicts[2]!], 1))).toBe(true);
    // No usable check is never a pass: an ask order is served to nobody who has not been checked for.
    expect(passes(uncheckedRecord(1, 3, 1, 'invalid_output'))).toBe(false);
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

  it('are shared once for a sentence of eight key words or fewer, and twice for a longer one (D-305)', () => {
    const passage = 'Near the poles the Sun is never directly overhead';
    // Five key words (sun, nearly, overhead, pole, summer): a quote that carries one is about it.
    const short = 'The Sun is nearly overhead at the pole in summer.';
    expect(SHORT_SENTENCE_KEY_WORDS).toBe(8);
    expect(contentStems(short).size).toBeLessThanOrEqual(SHORT_SENTENCE_KEY_WORDS);
    expect(isAboutSentence('the Sun is', short)).toBe(true);
    expect(isAboutSentence('a kettle switches off', short)).toBe(false);
    expect(isAboutSentence(passage, short)).toBe(true);
    // Nine key words: one shared word is no longer enough, two are.
    const long =
      'The Sun is nearly overhead at the pole in summer, so every glacier melts under bright weather somewhere.';
    expect(contentStems(long).size).toBeGreaterThan(SHORT_SENTENCE_KEY_WORDS);
    expect(isAboutSentence('the Sun is', long)).toBe(false);
    expect(isAboutSentence(passage, long)).toBe(true);
    // A sentence with no key word needs none, as before.
    expect(isAboutSentence('light into a single beam', 'Why?')).toBe(true);
  });
});

describe('which sentences may state no fact (B1.3, D-266)', () => {
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

  it('recognises the limits lines of real dev answers (labelled CI text from the 1 Nov check)', () => {
    for (const text of [
      'This explanation cannot tell you why equatorial regions still have wet and dry seasons, or how terrain, oceans, and local circulation shape particular climates.',
      'This answer cannot show how the browser identifies damaged areas, chooses repaint boundaries, or decides between a partial update and a broader redraw.',
      'This explanation cannot determine an exact speed ratio without measuring both implementations on representative data and their actual systems.',
      'It also cannot choose a reliable average-case winner without knowing the input distribution and the implementation’s constants.',
      'That source-position detail remains unspecified in the mechanism summarized here.',
      'But the pages do not say how terrain shapes the climate.',
    ])
      expect(namesTheGap(text)).toBe(true);
  });

  it('does not take a sentence for a gap when it states something besides the gap', () => {
    for (const text of [
      'This explains the two-bulge pattern, but it does not give the exact height or arrival time of a tide at a particular shore; those predictions require accounting for the changing positions of the Moon and Sun.',
      'It explains the weak temperature seasonality, not every difference in equatorial weather.',
      'It specifies encoder states, attention weights, causal masking, and stepwise decoding, but gives no rule for marking the original positions of source tokens.',
      'The passages describe DOM and CSS processing, render-tree changes, layout, and painting, but they do not expose that region-selection algorithm.',
      'The cause of the warming remains unknown to science.',
    ])
      expect(namesTheGap(text)).toBe(false);
  });

  it('takes the whole sentence for the admission: one that goes on to state a fact is judged (D-266)', () => {
    const smuggled = [
      'The pages do not say why, but sunlight is aimed nearly overhead at the pole.',
      'The pages do not say why, but the Earth orbits the Sun at 30 km per second.',
      'This answer cannot tell you the height, and the Sun is overhead at the pole.',
      'This answer cannot tell you the height and the Sun is overhead at the pole.',
      'Nothing in the pages explains it; the Sun is directly overhead at the poles.',
      'The Sun is directly overhead at the pole, but the reason is unexplained here.',
      'This answer cannot tell you why: sunlight is aimed nearly overhead at the pole.',
      'The pages do not say why (the Sun is overhead at the pole).',
      'The pages do not say why, although the Sun is overhead at the pole.',
      'The pages do not say why, and Earth orbits the Sun.',
      'The pages do not say why, which is a pity since the Sun is overhead.',
    ];
    for (const text of smuggled) {
      expect(namesTheGap(text)).toBe(false);
      expect(noClaimGround({ text }, ['The Sun is directly overhead at the pole in summer.'])).toBeUndefined();
    }
    // The same admissions without the second clause are gaps, and a lead-in word does not count against them.
    for (const text of [
      'The pages do not say why.',
      'But the pages do not say why.',
      'This answer cannot tell you the height.',
      'Nothing in the pages explains it.',
      'That reason is unexplained here.',
    ])
      expect(namesTheGap(text)).toBe(true);
  });

  it('tests for a figure before it takes a sentence for a gap', () => {
    const cited = ['The tower stands twenty-one metres tall.'];
    expect(noClaimGround({ text: 'The pages do not give the 23.4 degree figure.' }, cited)).toBeUndefined();
    expect(noClaimGround({ text: 'This answer cannot tell you why it is twenty-one metres.' }, cited)).toBeUndefined();
    expect(noClaimGround({ text: 'The pages do not give the figure.' }, cited)).toBe('gap');
  });

  it('gives a ground for no fact to a question, a gap or a transition that shares no key word with its passages, and to nothing else', () => {
    expect(noClaimGround({ text: 'Why does the beam turn?' }, cited)).toBe('question');
    expect(noClaimGround({ text: 'The pages do not say how.' }, cited)).toBe('gap');
    expect(
      noClaimGround({ text: 'Putting it together at the end of the night, as the keeper climbs down' }, cited),
    ).toBe('unshared');
    expect(noClaimGround({ text: 'Seven crows nested.' }, cited)).toBeUndefined();
    expect(noClaimGround({ text: '7 crows nested.' }, cited)).toBeUndefined();
    // A longer sentence that says something of the passages' subject is a statement.
    expect(
      noClaimGround({ text: 'The beam is narrow and it sweeps across the open water of the bay each night.' }, cited),
    ).toBeUndefined();
  });

  it('gives a ground to a sentence of at most eight words with no figure, whatever key words it shares, and to no longer one (D-306)', () => {
    expect(MAX_SHORT_NO_CLAIM_WORDS).toBe(8);
    // Seven words, sharing "beam" with its passage: before D-306 this was judged as a statement.
    expect(noClaimGround({ text: 'The beam is narrow.' }, cited)).toBe('short');
    expect(noClaimGround({ text: 'Here is why the beam matters so much.' }, cited)).toBe('short');
    // Eight words is the last that counts; nine is a sentence to judge.
    expect(noClaimGround({ text: 'Here is why the beam matters to every single ship.' }, cited)).toBeUndefined();
    // A figure, in digits or in words, makes it a claim.
    expect(noClaimGround({ text: 'The beam is 7 metres wide.' }, cited)).toBeUndefined();
    expect(noClaimGround({ text: 'The beam is seven metres wide.' }, cited)).toBeUndefined();
    // A label has its own rule: a longer heading that states something is not made a transition by being short.
    expect(noClaimGround({ text: 'Why the beam turns once', label: true }, cited)).toBeUndefined();
  });

  it('gives a ground to a label of at most four words even when it shares key words with its passages, unless it has a figure', () => {
    // Headings of the dev answers: each names what follows and shares key words with the passages it rests on.
    const passages = [
      'The browser combines the document object model and the CSS object model into a render tree, then runs layout and paint.',
    ];
    expect(MAX_LABEL_WORDS).toBe(4);
    // The same words as a sentence, not a label, are short enough to be marked too (D-306).
    expect(noClaimGround({ text: 'How the render tree' }, passages)).toBe('short');
    for (const heading of ['How the Update Spreads', 'The Missing Position Detail', 'The render tree'])
      expect(noClaimGround({ text: heading, label: true }, passages)).toBe('label');
    expect(noClaimGround({ text: 'Twenty layout passes', label: true }, passages)).toBeUndefined();
    expect(noClaimGround({ text: 'Layout in 3 passes', label: true }, passages)).toBeUndefined();
  });

  it('judges a label of more than four words, or one that states a fact, like any sentence (D-266)', () => {
    const passages = [
      'Near the poles the Sun is never directly overhead, because the planet’s axis is tilted a little.',
    ];
    // The real title of the 1 Nov equator answer, which the checker flagged as going beyond the passages.
    expect(
      noClaimGround({ text: 'Why the Equator Barely Notices Earth’s Tilt', label: true }, passages),
    ).toBeUndefined();
    expect(noClaimGround({ text: 'How one tilt creates different seasons', label: true }, passages)).toBeUndefined();
    expect(noClaimGround({ text: 'The Sun is overhead at the pole', label: true }, passages)).toBeUndefined();
  });

  it('gives the gap ground to the title of a limits callout, whatever its length, and not to one that goes on', () => {
    for (const title of [
      'What this does not explain',
      'What This Cannot Explain',
      'What the label omits',
      'What this answer cannot establish',
      'What remains unknown',
    ])
      expect(noClaimGround({ text: title, label: true }, ['A prism ring gathers the light.'])).toBe('gap');
    for (const title of ['What this does not explain is the height of the tower', 'What the pages say about the Sun'])
      expect(noClaimGround({ text: title, label: true }, ['A prism ring gathers the light.'])).toBeUndefined();
  });
});

describe('what a verdict that breaks a rule does to its own sentence (D-265)', () => {
  const texts = new Map([
    ['e1', 'The Skerry lighthouse keeper winds the lamp clockwork every four hours through the long winter nights.'],
    ['e2', 'A prism ring around the flame gathers the light into a single beam that sweeps across the water.'],
    ['e3', 'Fog signals complement the beam, because light cannot cross a thick bank of fog for any useful distance.'],
    ['e5', 'Near the poles the Sun is never directly overhead, because the planet’s axis is tilted a little.'],
  ]);
  const sentence = (number: number, text: string, cites: string[], label?: boolean): SentenceUnderCheck => ({
    number,
    text,
    cites,
    ...(label === true ? { label } : {}),
  });
  const supported = (number: number, quote: string): SentenceVerdict => ({ number, verdict: 'supported', quote });
  const flagged = (number: number): SentenceVerdict => ({
    number,
    verdict: 'unsupported',
    kind: 'goes_beyond',
    problem: 'The passage says something narrower.',
  });
  const noClaim = (number: number): SentenceVerdict => ({ number, verdict: 'no_claim' });
  const prism = sentence(1, 'A prism ring gathers the light into one beam.', ['e2']);
  const prismQuote = 'prism ring around the flame';
  /** What each verdict came to: the code of one that code set aside, else its kind. */
  const outcomes = (verdicts: readonly SentenceVerdict[]) =>
    verdicts.map((verdict) => (verdict.verdict === 'unsupported' ? (verdict.code ?? verdict.kind) : verdict.verdict));
  const numbered = (sentences: readonly SentenceUnderCheck[]) =>
    sentences.map((one, index) => ({ ...one, number: index + 1 }));

  it('keeps every verdict that follows the rules, the checker’s own unsupported ones included, with no code', () => {
    const judged = judgeVerdicts(
      [supported(1, prismQuote), flagged(2)],
      numbered([prism, sentence(2, 'The beam is brighter than the sun.', ['e2'])]),
      texts,
    );
    expect(judged).toEqual([supported(1, prismQuote), flagged(2)]);
  });

  it('turns a quote that is in no passage the answer cites into unsupported for that sentence alone (D-305)', () => {
    // Real words, but of e5, which no sentence of the answer cites; and words nobody wrote.
    const judged = judgeVerdicts(
      [
        supported(1, 'Near the poles the Sun is never directly overhead'),
        supported(2, 'winds an invented clockwork'),
        supported(3, 'Fog signals complement the beam'),
      ],
      numbered([
        prism,
        sentence(2, 'The keeper winds the clockwork.', ['e1']),
        sentence(3, 'Fog signals complement the beam.', ['e3']),
      ]),
      texts,
    );
    expect(outcomes(judged)).toEqual(['quote_not_in_cited_passages', 'quote_not_in_cited_passages', 'supported']);
    expect(judged[0]).toMatchObject({
      number: 1,
      verdict: 'unsupported',
      kind: 'not_stated',
      problem: RULE_PROBLEMS.quote_not_in_cited_passages,
    });
  });

  it('accepts a quote from any passage the answer cites, not only those of the sentence’s own block (D-305)', () => {
    const answer = numbered([prism, sentence(2, 'Fog signals complement the beam.', ['e3'])]);
    // The first sentence cites e2; the words are e3's, which the answer cites at the second sentence.
    const verdicts = [supported(1, 'light cannot cross a thick bank'), supported(2, 'Fog signals complement the beam')];
    expect(outcomes(judgeVerdicts(verdicts, answer, texts))).toEqual(['supported', 'supported']);
    // Checked one batch at a time, the batch is told the sentences of the whole answer: a quote of a passage that only another
    // batch's sentences cite is as good as a quote of its own.
    expect(outcomes(judgeVerdicts(verdicts.slice(0, 1), answer.slice(0, 1), texts, answer))).toEqual(['supported']);
    // Without the rest of the answer, e3 is cited by nobody here: the same quote is in no passage this answer cites.
    expect(outcomes(judgeVerdicts(verdicts.slice(0, 1), answer.slice(0, 1), texts))).toEqual([
      'quote_not_in_cited_passages',
    ]);
  });

  it('turns a quote of too few words or a quote about something else into unsupported, with the code that says which', () => {
    // Ten key words: a quote needs two of them (D-305).
    const longSun = numbered([
      sentence(
        1,
        'The Sun is nearly overhead at the pole in summer, so every glacier melts under bright weather somewhere.',
        ['e5'],
      ),
    ]);
    expect(contentStems(longSun[0]!.text).size).toBeGreaterThan(SHORT_SENTENCE_KEY_WORDS);
    expect(outcomes(judgeVerdicts([supported(1, 'Sun — is')], longSun, texts))).toEqual(['quote_too_short']);
    expect(outcomes(judgeVerdicts([supported(1, 'the Sun is')], longSun, texts))).toEqual(['quote_not_about_sentence']);
    // Words that carry the sentence’s own key words stay the checker’s judgement (D-250).
    expect(outcomes(judgeVerdicts([supported(1, 'the Sun is never directly overhead')], longSun, texts))).toEqual([
      'supported',
    ]);
    // Five key words: one is enough (D-305). Whether "the Sun is" supports this sentence is now the checker’s judgement alone.
    const shortSun = numbered([sentence(1, 'The Sun is nearly overhead at the pole in summer.', ['e5'])]);
    expect(outcomes(judgeVerdicts([supported(1, 'the Sun is')], shortSun, texts))).toEqual(['supported']);
    // A quote that shares none of them is still about something else.
    expect(outcomes(judgeVerdicts([supported(1, 'the planet’s axis is tilted')], shortSun, texts))).toEqual([
      'quote_not_about_sentence',
    ]);
  });

  it('accepts a quote that differs from the passage only in marks, spacing and case, or that leaves words out with an ellipsis', () => {
    const sun = numbered([sentence(1, 'Near the poles the Sun is never directly overhead.', ['e5'])]);
    for (const quote of [
      'NEAR the poles — the Sun is never directly overhead,',
      '“Near the poles … the Sun is never directly overhead”',
      'near the poles   the sun is never\u00a0directly overhead',
    ])
      expect(outcomes(judgeVerdicts([supported(1, quote)], sun, texts))).toEqual(['supported']);
  });

  it('turns "no fact" without a ground into unsupported, and allows it for a question, a gap, a label and an unrelated transition', () => {
    const judged = judgeVerdicts(
      [noClaim(1), noClaim(2), noClaim(3), noClaim(4), noClaim(5), supported(6, prismQuote)],
      numbered([
        sentence(1, 'The beam sweeps across the water and reaches the distant ships.', ['e2']),
        sentence(2, 'Why does the beam turn?', ['e2']),
        sentence(3, 'This answer cannot tell us about radio.', ['e2']),
        sentence(4, 'How the beam turns', ['e2'], true),
        sentence(5, 'Twenty-one crows nested there.', ['e1']),
        prism,
      ]),
      texts,
    );
    expect(outcomes(judged)).toEqual([
      'no_claim_without_ground',
      'no_claim',
      'no_claim',
      'no_claim',
      'no_claim_without_ground',
      'supported',
    ]);
    // A long label states something: "no fact" is not accepted for it, and it is judged like a sentence.
    const long = judgeVerdicts(
      [noClaim(1)],
      numbered([sentence(1, 'Why the beam turns once every minute of the night', ['e2'], true)]),
      texts,
    );
    expect(outcomes(long)).toEqual(['no_claim_without_ground']);
  });

  it('sets aside the transitions of a reply that marks more than half of the answer as stating no fact, and nothing else', () => {
    const transitions = [
      sentence(1, 'Putting it together', ['e2']),
      sentence(2, 'Moving along now', ['e2']),
      sentence(3, 'Why does the beam turn?', ['e2']),
    ];
    // Two transitions of four sentences is half: allowed.
    const half = judgeVerdicts(
      [noClaim(1), noClaim(2), noClaim(3), supported(4, prismQuote)],
      numbered([...transitions, prism]),
      texts,
    );
    expect(outcomes(half)).toEqual(['no_claim', 'no_claim', 'no_claim', 'supported']);
    // A third makes it more than half: the transitions are set aside, the question is still a question.
    const lazy = judgeVerdicts(
      [noClaim(1), noClaim(2), noClaim(3), noClaim(4)],
      numbered([...transitions, sentence(4, 'Nothing to see here', ['e2'])]),
      texts,
    );
    expect(outcomes(lazy)).toEqual(['too_many_no_claim', 'too_many_no_claim', 'no_claim', 'too_many_no_claim']);
  });

  it('allows "no fact" for a short sentence that shares key words with its passages, and counts it toward the share marked (D-306)', () => {
    const short = numbered([
      sentence(1, 'The beam is narrow.', ['e2']),
      sentence(2, 'The ring is glass.', ['e2']),
      sentence(3, 'The flame is small.', ['e2']),
      prism,
    ]);
    // One of four is allowed: the sentence shares "beam" with its passage and is eight words or fewer, so it may be marked.
    expect(
      outcomes(
        judgeVerdicts(
          [noClaim(1), supported(2, prismQuote), supported(3, prismQuote), supported(4, prismQuote)],
          short,
          texts,
        ),
      ),
    ).toEqual(['no_claim', 'supported', 'supported', 'supported']);
    // Three of four is more than half: a reply that calls short statements "no fact" that often is not believed.
    expect(
      outcomes(judgeVerdicts([noClaim(1), noClaim(2), noClaim(3), supported(4, prismQuote)], short, texts)),
    ).toEqual(['too_many_no_claim', 'too_many_no_claim', 'too_many_no_claim', 'supported']);
  });

  it('does not count labels toward the share of sentences marked as stating no fact', () => {
    const judged = judgeVerdicts(
      [noClaim(1), noClaim(2), noClaim(3), supported(4, prismQuote)],
      numbered([
        sentence(1, 'Why the beam turns', ['e2'], true),
        sentence(2, 'The light path', ['e2'], true),
        sentence(3, 'Moving along now', ['e2']),
        prism,
      ]),
      texts,
    );
    expect(outcomes(judged)).toEqual(['no_claim', 'no_claim', 'no_claim', 'supported']);
  });

  it('has a fixed note for every rule, none of which holds a sentence', () => {
    for (const code of RULE_CODES) expect(RULE_PROBLEMS[code].length).toBeGreaterThan(20);
  });
});

describe('a long answer is checked in batches of sentences (D-267)', () => {
  const sentences = (count: number): SentenceUnderCheck[] =>
    Array.from({ length: count }, (_unused, index) => ({
      number: index + 1,
      text: `Sentence ${String(index + 1)}.`,
      cites: ['e1'],
    }));

  it('splits the sentences in order into runs of at most one request’s worth, keeping their own numbers', () => {
    expect(ASK_SUPPORT_BATCH_SENTENCES).toBe(10);
    expect(batchesOf(sentences(0))).toEqual([]);
    expect(batchesOf(sentences(10)).map((batch) => batch.length)).toEqual([10]);
    expect(batchesOf(sentences(21)).map((batch) => batch.length)).toEqual([10, 10, 1]);
    expect(batchesOf(sentences(21))[2]![0]!.number).toBe(21);
  });
});
