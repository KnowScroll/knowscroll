import { describe, expect, it } from 'vitest';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { UNSUPPORTED_HINTS, type SentenceUnderCheck } from '../domain/ask-support.js';
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

  it('are the dek, then each paragraph, list item and callout in reading order, numbered from 1', () => {
    expect(sentences.map((sentence) => [sentence.number, sentence.text])).toEqual([
      [1, 'A ring of glass shapes one beam that sweeps the sea.'],
      [2, 'The keeper winds a clockwork every four hours.'],
      [3, 'A prism ring gathers the light into one beam.'],
      [4, 'Fog stops the light quickly.'],
      [5, 'So a sound signal helps.'],
      [6, 'This says nothing of radio.'],
    ]);
  });

  it('carry the passages their own block cites, and the dek rests on whatever the answer cites; a heading is not checked', () => {
    expect(sentences.map((sentence) => sentence.cites)).toEqual([
      ['e1', 'e2', 'e3', 'e4'],
      ['e1', 'e2'],
      ['e1', 'e2'],
      ['e3'],
      ['e3'],
      ['e4'],
    ]);
    expect(sentences.some((sentence) => sentence.text === 'The beam')).toBe(false);
  });

  it('are shown with only the passages the answer cites, and as data the checker reads line by line', () => {
    const cited = askSupportContext(sentences.slice(3, 5), PASSAGES);
    expect(citedPassages(sentences.slice(3, 5), PASSAGES).map((one) => one.handle)).toEqual(['e3']);
    expect(cited.map((item) => item.kind)).toEqual(['cited_passages', 'answer_sentences']);
    expect(cited[0]!.text).toBe(`[e3] ${PASSAGES[2]!.text}`);
    const lines = cited[1]!.text.split('\n').map((line) => JSON.parse(line) as { n: number; cites: string[] });
    expect(lines).toEqual([
      { n: 4, cites: ['e3'], text: 'Fog stops the light quickly.' },
      { n: 5, cites: ['e3'], text: 'So a sound signal helps.' },
    ]);
  });

  it('are checked only for the answer to a question', () => {
    expect(hasSupportCheck({ mode: 'question' })).toBe(true);
    for (const mode of ['library', 'what_if', 'perspective'] as const) expect(hasSupportCheck({ mode })).toBe(false);
  });
});

describe('the checker’s reply is validated by code', () => {
  const sentences: readonly SentenceUnderCheck[] = [
    { number: 1, text: 'A prism ring gathers the light into one beam.', cites: ['e2'] },
    { number: 2, text: 'The tower is 21 metres tall.', cites: ['e4'] },
    { number: 3, text: 'So a sound signal helps.', cites: ['e3'] },
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

  it('accepts one verdict for every sentence, in order, with a quote from a passage it cites', () => {
    expect(parse(good).success).toBe(true);
  });

  it('refuses a reply that skips, repeats, reorders or adds a sentence', () => {
    expect(codes(parse(good.slice(0, 2)))).toContain('sentences_not_in_order');
    expect(codes(parse([good[1], good[0], good[2]]))).toContain('sentences_not_in_order');
    expect(codes(parse([...good, { n: 4, verdict: 'no_claim' }]))).not.toEqual([]);
  });

  it('refuses a supported sentence whose quote is not in a passage that sentence cites, even if it is in another passage', () => {
    // The words are real, but they come from e3, which sentence 1 does not cite.
    expect(codes(parse([supported(1, 'light cannot cross a thick bank'), good[1], good[2]]))).toContain(
      'quote_not_in_cited_passages',
    );
    expect(codes(parse([supported(1, 'a single invented beam'), good[1], good[2]]))).toContain(
      'quote_not_in_cited_passages',
    );
    // Too short to prove anything.
    expect(codes(parse([supported(1, 'prism ring'), good[1], good[2]]))).toContain('quote_not_in_cited_passages');
  });

  it('refuses a sentence with a number marked as stating no fact', () => {
    expect(
      codes(
        parse([good[0], { n: 2, verdict: 'no_claim' }, { n: 3, verdict: 'supported', quote: 'sound signal helps' }]),
      ),
    ).toContain('figure_marked_no_claim');
  });

  it('refuses a reply that marks most sentences as stating no fact', () => {
    const lazy = [
      { n: 1, verdict: 'no_claim' },
      { n: 2, verdict: 'supported', quote: 'stands twenty-one metres tall' },
      { n: 3, verdict: 'no_claim' },
    ];
    expect(codes(parse(lazy))).toContain('too_many_no_claim');
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
    expect(Object.keys(role.safeCustomIssues ?? {}).sort()).toEqual([
      'figure_marked_no_claim',
      'quote_not_in_cited_passages',
      'sentences_not_in_order',
      'too_many_no_claim',
    ]);
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
      [{ number: 4, verdict: 'unsupported', kind: 'contradicted', problem: 'The passage says the opposite.' }],
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
