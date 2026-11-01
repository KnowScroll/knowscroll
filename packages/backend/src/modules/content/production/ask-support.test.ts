import { describe, expect, it } from 'vitest';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { RULE_PROBLEMS, UNSUPPORTED_HINTS, type SentenceUnderCheck } from '../domain/ask-support.js';
import {
  ASK_SUPPORT_CHECK_VERSION,
  ASK_SUPPORT_INSTRUCTIONS,
  askSupportContext,
  askSupportRole,
  askSupportSchema,
  citedPassages,
  hasSupportCheck,
  sentencesOfAnswer,
  supportRepairItems,
  supportRepairRole,
  verdictsOf,
} from './ask-support.js';
import type { EvidencePassage } from './evidence.js';
import { QUESTION_WRITER_PROMPT_VERSION } from './writer.js';

/** Labelled CI text about an invented lighthouse: never provider output and never product content. */
const passage = (n: number, text: string): EvidencePassage => ({
  handle: `e${String(n)}`,
  claimId: `claim-${String(n)}`,
  pageId: 'page-ci',
  text,
});
const PASSAGES = [
  passage(1, 'The Skerry lighthouse keeper winds the lamp clockwork every four hours through the long winter nights.'),
  passage(2, 'A prism ring around the flame gathers the light into a single beam that sweeps across the water.'),
  passage(
    3,
    'Fog signals complement the beam, because light cannot cross a thick bank of fog for any useful distance.',
  ),
  passage(4, 'The tower stands twenty-one metres tall, which places the lamp high enough to clear distant waves.'),
  passage(5, 'Near the poles the Sun is never directly overhead, because the planet’s axis is tilted a little.'),
];

const ANSWER = AuthoredScroll.parse({
  title: 'Why a lighthouse beam turns',
  dek: 'A ring of glass shapes one beam that sweeps the sea.',
  blocks: [
    { type: 'heading', text: 'The beam' },
    {
      type: 'paragraph',
      cites: ['e1', 'e2'],
      text: 'The keeper winds a clockwork every four hours. A prism ring gathers the light into one beam.',
    },
    { type: 'list', cites: ['e3'], items: ['Fog stops the light quickly.', 'So a sound signal helps.'] },
    { type: 'callout', cites: ['e4'], kind: 'limit', title: 'Where this stops', text: 'This says nothing of radio.' },
  ],
});

describe('the sentences a support check reads', () => {
  const sentences = sentencesOfAnswer(ANSWER);

  it('are the title, the dek, each heading, each paragraph and list item, the callout’s title and its text, in reading order, numbered from 1 (B1.4)', () => {
    expect(sentences.map((sentence) => [sentence.number, sentence.text])).toEqual([
      [1, 'Why a lighthouse beam turns'],
      [2, 'A ring of glass shapes one beam that sweeps the sea.'],
      [3, 'The beam'],
      [4, 'The keeper winds a clockwork every four hours.'],
      [5, 'A prism ring gathers the light into one beam.'],
      [6, 'Fog stops the light quickly.'],
      [7, 'So a sound signal helps.'],
      [8, 'Where this stops'],
      [9, 'This says nothing of radio.'],
    ]);
  });

  it('carry the passages their own block cites; the title, the dek, the headings and the callout’s title rest on whatever the answer cites', () => {
    const everything = ['e1', 'e2', 'e3', 'e4'];
    expect(sentences.map((sentence) => sentence.cites)).toEqual([
      everything,
      everything,
      everything,
      ['e1', 'e2'],
      ['e1', 'e2'],
      ['e3'],
      ['e3'],
      everything,
      ['e4'],
    ]);
  });

  it('mark the title, the headings and the callouts’ titles as labels, and no other sentence (D-263)', () => {
    expect(sentences.filter((sentence) => sentence.label === true).map((sentence) => sentence.number)).toEqual([
      1, 3, 8,
    ]);
    // The checker is told which lines are labels, and only those.
    const lines = askSupportContext(sentences, PASSAGES)[1]!
      .text.split('\n')
      .map((line) => JSON.parse(line) as object);
    expect(lines.map((line) => 'label' in line)).toEqual([true, false, true, false, false, false, false, true, false]);
  });

  it('leave out the title of a callout that has none', () => {
    const plain = AuthoredScroll.parse({
      ...ANSWER,
      blocks: [
        { type: 'paragraph', cites: ['e1'], text: 'The keeper winds a clockwork.' },
        { type: 'callout', cites: ['e4'], kind: 'limit', text: 'This says nothing of radio.' },
      ],
    });
    expect(sentencesOfAnswer(plain).map((sentence) => sentence.text)).toEqual([
      'Why a lighthouse beam turns',
      'A ring of glass shapes one beam that sweeps the sea.',
      'The keeper winds a clockwork.',
      'This says nothing of radio.',
    ]);
  });

  it('are shown with only the passages the answer cites, and as data the checker reads line by line', () => {
    const cited = askSupportContext(sentences.slice(5, 7), PASSAGES);
    expect(citedPassages(sentences.slice(5, 7), PASSAGES).map((one) => one.handle)).toEqual(['e3']);
    expect(cited.map((item) => item.kind)).toEqual(['cited_passages', 'answer_sentences']);
    expect(cited[0]!.text).toBe(`[e3] ${PASSAGES[2]!.text}`);
    const lines = cited[1]!.text.split('\n').map((line) => JSON.parse(line) as { n: number; cites: string[] });
    expect(lines).toEqual([
      { n: 6, cites: ['e3'], text: 'Fog stops the light quickly.' },
      { n: 7, cites: ['e3'], text: 'So a sound signal helps.' },
    ]);
  });

  it('are checked only for the answer to a question', () => {
    expect(hasSupportCheck({ mode: 'question' })).toBe(true);
    for (const mode of ['library', 'what_if', 'perspective'] as const) expect(hasSupportCheck({ mode })).toBe(false);
  });
});

describe('the checker’s reply: its shape is refused whole, each verdict is judged on its own sentence (D-263)', () => {
  const sentences: readonly SentenceUnderCheck[] = [
    { number: 1, text: 'A prism ring gathers the light into one beam.', cites: ['e2'] },
    { number: 2, text: 'The tower is 21 metres tall.', cites: ['e4'] },
    { number: 3, text: 'Does a sound signal help?', cites: ['e3'] },
  ];
  const schema = askSupportSchema(sentences, PASSAGES);
  const supported = (n: number, quote: string) => ({ n, verdict: 'supported', quote });
  const good = [
    supported(1, 'prism ring around the flame'),
    supported(2, 'stands twenty-one metres tall'),
    { n: 3, verdict: 'no_claim' },
  ];
  const parse = (sentencesReply: unknown) => schema.safeParse({ sentences: sentencesReply });
  const codes = (result: ReturnType<typeof parse>) =>
    result.success
      ? []
      : result.error.issues.map(
          (issue) => (issue as { params?: { safeCode?: string } }).params?.safeCode ?? issue.code,
        );
  /** What each verdict came to for the sentences given: the code of one code set aside, else the verdict. */
  const outcomes = (result: ReturnType<typeof parse>) =>
    result.success
      ? verdictsOf(result.data).map((verdict) =>
          verdict.verdict === 'unsupported' && verdict.code !== undefined ? verdict.code : verdict.verdict,
        )
      : codes(result);

  it('accepts one verdict for every sentence, in order, with a quote from a passage it cites', () => {
    expect(parse(good).success).toBe(true);
    expect(outcomes(parse(good))).toEqual(['supported', 'supported', 'no_claim']);
  });

  it('refuses a reply that skips, repeats, reorders or adds a sentence', () => {
    expect(codes(parse(good.slice(0, 2)))).toContain('sentences_not_in_order');
    expect(codes(parse([good[1], good[0], good[2]]))).toContain('sentences_not_in_order');
    expect(codes(parse([...good, { n: 4, verdict: 'no_claim' }]))).not.toEqual([]);
  });

  it('numbers a batch by the numbers of its sentences, not from 1', () => {
    const batch = sentences.map((sentence, index) => ({ ...sentence, number: index + 11 }));
    const batchSchema = askSupportSchema(batch, PASSAGES);
    const numbered = (first: number) => ({
      sentences: good.map((verdict, index) => ({ ...verdict, n: first + index })),
    });
    expect(batchSchema.safeParse(numbered(11)).success).toBe(true);
    expect(batchSchema.safeParse(numbered(1)).success).toBe(false);
  });

  it('turns a supported sentence whose quote is not in a passage that sentence cites into unsupported for that sentence alone, even if the words are in another passage', () => {
    // The words are real, but they come from e3, which sentence 1 does not cite; the reply is not refused, the other verdicts stand.
    const result = parse([supported(1, 'light cannot cross a thick bank'), good[1], good[2]]);
    expect(outcomes(result)).toEqual(['quote_not_in_cited_passages', 'supported', 'no_claim']);
    expect(outcomes(parse([supported(1, 'a single invented beam'), good[1], good[2]]))).toEqual([
      'quote_not_in_cited_passages',
      'supported',
      'no_claim',
    ]);
    // Too short to prove anything.
    expect(outcomes(parse([supported(1, 'prism ring'), good[1], good[2]]))).toEqual([
      'quote_too_short',
      'supported',
      'no_claim',
    ]);
  });

  it('turns a sentence with a number marked as stating no fact into unsupported for that sentence', () => {
    expect(outcomes(parse([good[0], { n: 2, verdict: 'no_claim' }, { n: 3, verdict: 'no_claim' }]))).toEqual([
      'supported',
      'no_claim_without_ground',
      'no_claim',
    ]);
  });

  it('records the code on the sentence it set aside, with the fixed kind and note, and nothing the checker wrote', () => {
    const result = parse([supported(1, 'a single invented beam'), good[1], good[2]]);
    expect(result.success && verdictsOf(result.data)[0]).toEqual({
      number: 1,
      verdict: 'unsupported',
      kind: 'not_stated',
      problem: RULE_PROBLEMS.quote_not_in_cited_passages,
      code: 'quote_not_in_cited_passages',
    });
  });

  describe('on the sentences of a real dev answer (the equator answer of the 1 Nov check, labelled CI text)', () => {
    // The passages are the words the checker quoted in that check, with their neighbouring sentences.
    const real = [
      passage(
        2,
        'Earth’s tilted axis creates seasons. As Earth orbits the Sun, its tilted axis always points in the same direction.',
      ),
      passage(
        6,
        'It is summer in June in the Northern Hemisphere because the Sun’s rays hit that part of Earth more directly. It is winter in December in the Northern Hemisphere, because that is when it is the South Pole’s turn to be tilted toward the Sun.',
      ),
      passage(
        7,
        'Many people believe that Earth is closer to the Sun in the summer and that is why it is hotter. However, in the Northern Hemisphere, we are having winter when Earth is closest to the Sun and summer when it is farthest away! Compared with how far away the Sun is, this change in Earth’s distance throughout the year does not make much difference to our weather.',
      ),
    ];
    const answer: readonly SentenceUnderCheck[] = [
      { number: 1, text: 'Why the Equator Barely Notices Earth’s Tilt', cites: ['e2', 'e6', 'e7'], label: true },
      {
        number: 2,
        text: 'Earth does not give each place its own tilt: the whole planet rotates around the same slanted axis.',
        cites: ['e2'],
      },
      {
        number: 3,
        text: 'A place near a pole can swing dramatically between sunlight aimed nearly overhead and sunlight arriving at a steep angle.',
        cites: ['e6'],
      },
      {
        number: 4,
        text: 'When the North Pole leans toward the Sun, around June, the northern half receives more direct rays and experiences summer.',
        cites: ['e6'],
      },
      {
        number: 5,
        text: 'A common mistake is to treat Earth’s changing distance from the Sun as the explanation.',
        cites: ['e7'],
      },
      { number: 6, text: 'What this does not explain', cites: ['e2', 'e6', 'e7'], label: true },
      {
        number: 7,
        text: 'This explanation cannot tell you why equatorial regions still have wet and dry seasons, or how terrain, oceans, and local circulation shape particular climates.',
        cites: ['e2'],
      },
    ];
    const realSchema = askSupportSchema(answer, real);
    const flaggedPole = {
      n: 3,
      verdict: 'unsupported',
      kind: 'goes_beyond',
      problem:
        'The passages discuss poles tilting toward the Sun but not sunlight shifting between overhead and steep angles.',
    };
    /** The reply a checker gave to the answer, with the changes given for some sentences (by number) applied. */
    const reply = (changes: Readonly<Record<number, object>> = {}) =>
      realSchema.safeParse({
        sentences: [
          { n: 1, verdict: 'no_claim' },
          supported(2, 'As Earth orbits the Sun, its tilted axis always points in the same direction.'),
          flaggedPole,
          supported(
            4,
            "It is summer in June in the Northern Hemisphere because the Sun's rays hit that part of Earth more directly",
          ),
          supported(5, 'Many people believe that Earth is closer to the Sun in the summer'),
          { n: 6, verdict: 'no_claim' },
          { n: 7, verdict: 'no_claim' },
        ].map((verdict) => ({ ...verdict, ...changes[verdict.n] })),
      });

    it('accepts the title, a callout’s title and the limits line as stating no fact, and flags the false sentence the checker found', () => {
      expect(outcomes(reply())).toEqual([
        'no_claim',
        'supported',
        'unsupported',
        'supported',
        'supported',
        'no_claim',
        'no_claim',
      ]);
    });

    it('keeps the sentences that follow the rules when one verdict quotes words nobody wrote', () => {
      const result = reply({ 4: { quote: 'the Sun’s rays hit the equator directly all year round' } });
      expect(outcomes(result)).toEqual([
        'no_claim',
        'supported',
        'unsupported',
        'quote_not_in_cited_passages',
        'supported',
        'no_claim',
        'no_claim',
      ]);
    });

    it('accepts a quote that leaves the middle out with an ellipsis, and one that writes the apostrophe and dash its own way', () => {
      const result = reply({
        2: { quote: 'As Earth orbits the Sun, its tilted axis … in the same direction.' },
        4: {
          quote:
            "It is summer in June in the Northern Hemisphere — because the Sun's rays hit that part of Earth more directly.",
        },
      });
      expect(outcomes(result)).toEqual([
        'no_claim',
        'supported',
        'unsupported',
        'supported',
        'supported',
        'no_claim',
        'no_claim',
      ]);
    });
  });

  describe('lets a sentence state no fact only on grounds code can see (B1.3)', () => {
    // Two sentences that are supported with real quotes about them, so a test can add the sentence it is about.
    const prism: SentenceUnderCheck = {
      number: 90,
      text: 'A prism ring gathers the light into one beam.',
      cites: ['e2'],
    };
    const tower: SentenceUnderCheck = {
      number: 91,
      text: 'The tower is tall enough to clear distant waves.',
      cites: ['e4'],
    };
    const prismQuote = 'prism ring around the flame';
    const towerQuote = 'lamp high enough to clear distant waves';
    const supportedPair = [
      { verdict: 'supported', quote: prismQuote },
      { verdict: 'supported', quote: towerQuote },
    ];
    /** The reply to these sentences, numbered in order, with one verdict each. */
    const reply = (answer: readonly SentenceUnderCheck[], verdicts: readonly object[]) =>
      askSupportSchema(
        answer.map((sentence, index) => ({ ...sentence, number: index + 1 })),
        PASSAGES,
      ).safeParse({ sentences: verdicts.map((verdict, index) => ({ n: index + 1, ...verdict })) });
    const noClaim = { verdict: 'no_claim' };

    it('sets aside exactly half the sentences marked as stating no fact when nothing shows that they state none', () => {
      const answer: readonly SentenceUnderCheck[] = [
        prism,
        { number: 0, text: 'The beam sweeps across the water.', cites: ['e2'] },
        tower,
        { number: 0, text: 'Fog stops the light quickly.', cites: ['e3'] },
      ];
      const result = reply(answer, [supportedPair[0]!, noClaim, supportedPair[1]!, noClaim]);
      expect(outcomes(result)).toEqual([
        'supported',
        'no_claim_without_ground',
        'supported',
        'no_claim_without_ground',
      ]);
    });

    it.each([
      ['a question', 'Why does the beam turn?', 'e2'],
      ['an admission that the pages do not cover something', 'The pages do not say how the lamp was built.', 'e2'],
      ['an admission that the answer cannot tell something', 'This answer cannot tell us about radio.', 'e2'],
      ['a label that shares no key word with its passages', 'Putting it together', 'e2'],
    ])('allows %s to state no fact', (_name, text, cite) => {
      const answer: readonly SentenceUnderCheck[] = [{ number: 0, text, cites: [cite] }, prism, tower];
      expect(outcomes(reply(answer, [noClaim, ...supportedPair]))).toEqual(['no_claim', 'supported', 'supported']);
    });

    it.each([
      ['a sentence that shares a key word with its passages', 'The beam is narrow and bright.', 'e2'],
      ['a figure written in words', 'Twenty-one crows nested there.', 'e1'],
      ['a figure written in words, larger', 'A hundred crows nested there.', 'e1'],
      ['a figure in digits', '21 crows nested there.', 'e1'],
      [
        'a sentence that states a fact after an admission',
        'This explains the beam, but it does not give the height.',
        'e2',
      ],
    ])('sets aside %s marked as stating no fact', (_name, text, cite) => {
      const answer: readonly SentenceUnderCheck[] = [{ number: 0, text, cites: [cite] }, prism, tower];
      expect(outcomes(reply(answer, [noClaim, ...supportedPair]))).toEqual([
        'no_claim_without_ground',
        'supported',
        'supported',
      ]);
    });

    it('allows a title or a heading that shares key words with its passages to state no fact, and not one with a figure', () => {
      const label = (text: string): SentenceUnderCheck => ({ number: 0, text, cites: ['e2'], label: true });
      expect(outcomes(reply([label('How the beam turns'), prism, tower], [noClaim, ...supportedPair]))).toEqual([
        'no_claim',
        'supported',
        'supported',
      ]);
      expect(outcomes(reply([label('Three beams'), prism, tower], [noClaim, ...supportedPair]))).toEqual([
        'no_claim_without_ground',
        'supported',
        'supported',
      ]);
    });

    it('allows the same words without a figure when they share nothing with the passages', () => {
      const answer: readonly SentenceUnderCheck[] = [
        { number: 0, text: 'Many crows nested there.', cites: ['e1'] },
        prism,
        tower,
      ];
      expect(outcomes(reply(answer, [noClaim, ...supportedPair]))).toEqual(['no_claim', 'supported', 'supported']);
    });

    it('sets aside the unrelated transitions of a reply in which more than half the sentences state no fact', () => {
      const answer: readonly SentenceUnderCheck[] = [
        { number: 0, text: 'Putting it together', cites: ['e2'] },
        { number: 0, text: 'Moving along now', cites: ['e2'] },
        prism,
      ];
      expect(outcomes(reply(answer, [noClaim, noClaim, supportedPair[0]!]))).toEqual([
        'too_many_no_claim',
        'too_many_no_claim',
        'supported',
      ]);
    });
  });

  describe('ties the quote to the sentence it is given for (B1.2)', () => {
    const sun: readonly SentenceUnderCheck[] = [
      { number: 1, text: 'The Sun is nearly overhead at the pole in summer.', cites: ['e5'] },
    ];
    const sunReply = (quote: string) =>
      askSupportSchema(sun, PASSAGES).safeParse({ sentences: [{ n: 1, verdict: 'supported', quote }] });

    it('sets aside the false sentence of the dev run marked supported with the three words "the Sun is"', () => {
      // The words are in the passage, and they say nothing about "nearly overhead", the pole or the summer.
      expect(outcomes(sunReply('the Sun is'))).toEqual(['quote_not_about_sentence']);
      expect(outcomes(sunReply('Sun is never directly'))).toEqual(['quote_not_about_sentence']);
    });

    it('accepts words that carry two of the sentence’s own key words, even when the passage says the opposite: that is the checker’s judgement', () => {
      expect(outcomes(sunReply('the Sun is never directly overhead'))).toEqual(['supported']);
    });

    it('sets aside one unrelated quote given for every sentence of an answer, one sentence at a time', () => {
      // Every sentence cites the prism passage too, so the quote is a real quote of a cited passage each time.
      const answer: readonly SentenceUnderCheck[] = [
        { number: 1, text: 'A prism ring gathers the light into one beam.', cites: ['e1', 'e2'] },
        { number: 2, text: 'The keeper winds the lamp clockwork every four hours.', cites: ['e1', 'e2'] },
        { number: 3, text: 'The tower is tall enough to clear distant waves.', cites: ['e2', 'e4'] },
        { number: 4, text: 'Fog stops the light quickly.', cites: ['e2', 'e3'] },
      ];
      const unrelated = answer.map((sentence) => ({
        n: sentence.number,
        verdict: 'supported',
        quote: 'prism ring around the flame',
      }));
      // The first sentence is about the prism ring, so it stands; the other three are set aside one by one.
      expect(outcomes(askSupportSchema(answer, PASSAGES).safeParse({ sentences: unrelated }))).toEqual([
        'supported',
        'quote_not_about_sentence',
        'quote_not_about_sentence',
        'quote_not_about_sentence',
      ]);
    });

    it('asks only for the key words a sentence has: a heading of one key word needs one', () => {
      const heading: readonly SentenceUnderCheck[] = [{ number: 1, text: 'The beam', cites: ['e2'] }];
      const reply = (quote: string) =>
        askSupportSchema(heading, PASSAGES).safeParse({ sentences: [{ n: 1, verdict: 'supported', quote }] });
      expect(outcomes(reply('gathers the light into a single beam'))).toEqual(['supported']);
      expect(outcomes(reply('a prism ring around the flame'))).toEqual(['quote_not_about_sentence']);
    });
  });

  describe('counts the words of a quote, not the pieces between spaces (B1.1)', () => {
    // The false sentence of the dev run: the passage says the Sun is never overhead near a pole.
    const sun: readonly SentenceUnderCheck[] = [
      { number: 1, text: 'The Sun is nearly overhead at the pole in summer.', cites: ['e5'] },
    ];
    const sunReply = (quote: string) =>
      askSupportSchema(sun, PASSAGES).safeParse({ sentences: [{ n: 1, verdict: 'supported', quote }] });

    it('sets aside a quote of two words and a dash, which has three pieces between spaces', () => {
      expect(outcomes(sunReply('Sun — is'))).toEqual(['quote_too_short']);
      expect(outcomes(sunReply('the - Sun'))).toEqual(['quote_too_short']);
    });

    it('accepts three words of the passage, whatever stands between them', () => {
      expect(outcomes(sunReply('the Sun is never directly overhead'))).toEqual(['supported']);
    });
  });

  it('needs a kind from the fixed list and a problem for an unsupported sentence, and refuses anything else in the reply', () => {
    const unsupported = { n: 3, verdict: 'unsupported', kind: 'goes_beyond', problem: 'The passage says narrower.' };
    expect(parse([good[0], good[1], unsupported]).success).toBe(true);
    expect(parse([good[0], good[1], { ...unsupported, kind: 'wrong' }]).success).toBe(false);
    expect(parse([good[0], good[1], { n: 3, verdict: 'unsupported', kind: 'goes_beyond' }]).success).toBe(false);
    expect(parse([good[0], good[1], { ...unsupported, extra: true }]).success).toBe(false);
    expect(
      parse([{ ...good[0], problem: 'A problem on a good sentence is not allowed.' }, good[1], good[2]]).success,
    ).toBe(false);
    expect(schema.safeParse({ sentences: good, note: 'x' }).success).toBe(false);
  });

  it('reads an accepted reply as the domain’s verdicts', () => {
    const reply = schema.parse({
      sentences: [
        good[0],
        good[1],
        { n: 3, verdict: 'unsupported', kind: 'not_stated', problem: 'No passage says that.' },
      ],
    });
    expect(verdictsOf(reply)).toEqual([
      { number: 1, verdict: 'supported', quote: 'prism ring around the flame' },
      { number: 2, verdict: 'supported', quote: 'stands twenty-one metres tall' },
      { number: 3, verdict: 'unsupported', kind: 'not_stated', problem: 'No passage says that.' },
    ]);
  });
});

describe('the role', () => {
  const sentences = sentencesOfAnswer(ANSWER);

  it('is a role of its own with fixed repair hints and the passages-only rule in its instructions', () => {
    const role = askSupportRole(sentences, PASSAGES);
    expect(role).toMatchObject({ id: 'content.ask-support-check', version: ASK_SUPPORT_CHECK_VERSION });
    // Only the shape of a reply is worth a repair: every other rule is applied to one sentence by code (D-263).
    expect(Object.keys(role.safeCustomIssues ?? {})).toEqual(['sentences_not_in_order']);
    expect(ASK_SUPPORT_INSTRUCTIONS).toContain('Judge against the cited passages alone');
    expect(ASK_SUPPORT_INSTRUCTIONS).toContain('Do not fill a gap with what you know');
    expect(ASK_SUPPORT_INSTRUCTIONS.length).toBeLessThan(8000);
  });
});

describe('the one repair an unsupported sentence earns', () => {
  const sentences = sentencesOfAnswer(ANSWER);

  it('tells the writer the fixed hint of each kind and where the sentence is, with the checker’s note as data, and shows it its draft', () => {
    const items = supportRepairItems(
      sentences,
      [{ number: 6, verdict: 'unsupported', kind: 'contradicted', problem: 'The passage says the opposite.' }],
      ANSWER,
    );
    expect(items.map((item) => item.kind)).toEqual(['check_problems', 'previous_draft']);
    expect(items[0]!.text).toBe(
      `Sentence "Fog stops the light quickly.": ${UNSUPPORTED_HINTS.contradicted} Note: The passage says the opposite.`,
    );
    expect(JSON.parse(items[1]!.text)).toEqual(ANSWER);
  });

  it('adds the revision notice to the writer’s own role, under a version that says it is a revision, with no change to its schema', () => {
    const writer = {
      id: 'content.scroll-writer',
      version: QUESTION_WRITER_PROMPT_VERSION,
      instructions: 'WRITER RULES',
      outputSchema: AuthoredScroll,
      maxOutputTokens: 1000,
    };
    const repair = supportRepairRole(writer);
    expect(repair.version).toBe(`${QUESTION_WRITER_PROMPT_VERSION}.fix`);
    expect(repair.version.length).toBeLessThanOrEqual(32);
    expect(repair.instructions.startsWith('WRITER RULES\n\nREVISION AFTER A SUPPORT CHECK')).toBe(true);
    expect(repair.outputSchema).toBe(writer.outputSchema);
  });
});
