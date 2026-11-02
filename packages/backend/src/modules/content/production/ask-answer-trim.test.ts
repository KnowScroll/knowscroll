import { describe, expect, it } from 'vitest';
import { FIELD_LIMITS } from '@knowscroll/scroll-model';
import { AuthoredScroll, COPY_RUN_WORDS, copyMaterial } from '@knowscroll/scroll-model/producer';
import { DIRECT_ANSWER_LOST_CODE } from './ask-answer-shape.js';
import {
  copiedSentenceNumbers,
  FALLBACK_TITLE,
  NEUTRAL_DEK,
  titleFromQuestion,
  trimAskAnswer,
  unchanged,
  type PreparedAnswer,
} from './ask-answer-trim.js';
import { placedSentencesOfAnswer } from './ask-support.js';

/**
 * What code takes out of the writer's draft before it is checked (D-347 to D-350). Labelled CI text about an invented lighthouse:
 * never provider output and never product content.
 */
const SOURCE = [
  'The Skerry lighthouse keeper winds the lamp clockwork every four hours through the long winter nights.',
  'A prism ring around the flame gathers the light into a single beam that sweeps across the water.',
  'The prism ring gathers light. Then the beam sweeps across the sea quickly.',
];
const MATERIAL = copyMaterial(SOURCE, COPY_RUN_WORDS);
const LINES = { title: 'How does a lighthouse guide ships?', dek: NEUTRAL_DEK };
const RULES = { copyMaterial: MATERIAL, lines: LINES };

const TITLE = 'How a lamp and a prism ring guide sailors';
const DEK = 'A ring of glass shapes one beam, and the clockwork turns it so sailors can read the coast.';
const paragraph = (text: string) => ({ type: 'paragraph' as const, cites: ['e1'], text });
const limit = {
  type: 'callout' as const,
  cites: ['e1'],
  kind: 'limit' as const,
  title: 'Where this stops',
  text: 'Radio is not covered.',
};
const answerOf = (blocks: unknown[], head: { title?: string; dek?: string } = {}) =>
  AuthoredScroll.parse({ title: head.title ?? TITLE, dek: head.dek ?? DEK, blocks });
const trimmed = (
  answer: AuthoredScroll,
): PreparedAnswer & { readonly counts: NonNullable<PreparedAnswer['counts']> } => {
  const prepared = trimAskAnswer(answer, RULES);
  if (prepared.counts === undefined) throw new Error('CI: expected the trim to change the draft');
  return { ...prepared, counts: prepared.counts };
};
const textsOf = (answer: AuthoredScroll) => placedSentencesOfAnswer(answer).map((sentence) => sentence.text);

/** Words of the first source: more than the nine the copy rule refuses. */
const COPIED = SOURCE[1]!;

describe('a draft with nothing to take out', () => {
  it('is returned as the writer wrote it, with no counts, and every block keeps its place', () => {
    const answer = answerOf([
      paragraph('A ring of glass bends the light. Sailors read the flashes.'),
      { type: 'heading', text: 'The beam' },
      paragraph('The beam turns slowly. It is seen as a flash.'),
      limit,
    ]);
    const prepared = trimAskAnswer(answer, RULES);
    expect(prepared.authored).toBe(answer);
    expect(prepared).toEqual(unchanged(answer));
    expect(prepared.counts).toBeUndefined();
    expect(prepared.blockOrigin).toEqual([0, 1, 2, 3]);
    expect(prepared.issues).toEqual([]);
  });
});

describe('a sentence that copies a run of nine words of a passage (D-347)', () => {
  it('is taken out of its paragraph, and the other sentences stay in order and word for word', () => {
    const answer = answerOf([
      paragraph('A ring of glass bends the light.'),
      paragraph(`Sailors read the flashes. ${COPIED} The beam turns slowly.`),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect(prepared.counts).toEqual({ copied: 1, leaning: 0, titleReplaced: false, dekReplaced: false });
    expect(prepared.authored.blocks[1]).toEqual({
      ...answer.blocks[1],
      text: 'Sailors read the flashes. The beam turns slowly.',
    });
    expect(prepared.authored.title).toBe(TITLE);
    expect(prepared.authored.dek).toBe(DEK);
    expect(prepared.authored.blocks.filter((_block, index) => index !== 1)).toEqual(
      answer.blocks.filter((_block, index) => index !== 1),
    );
    expect(prepared.issues).toEqual([]);
  });

  it('counts a run of exactly nine words and not one of eight', () => {
    const eight = COPIED.split(' ')
      .slice(0, COPY_RUN_WORDS - 1)
      .join(' ');
    const nine = COPIED.split(' ').slice(0, COPY_RUN_WORDS).join(' ');
    const base = (sentence: string) => answerOf([paragraph(`A ring of glass bends the light. ${sentence}.`), limit]);
    expect(trimAskAnswer(base(eight), RULES).counts).toBeUndefined();
    expect(trimmed(base(nine)).counts.copied).toBe(1);
  });

  it('takes out both sentences of a run that crosses the end of one, which neither holds nine words of', () => {
    // The source says "the prism ring gathers light. Then the beam sweeps across the sea": twelve words in a row across a full stop.
    const answer = answerOf([
      paragraph(
        'A ring of glass bends the light. The prism ring gathers light. Then the beam sweeps across the sea. Sailors read the flashes.',
      ),
      limit,
    ]);
    const sentences = placedSentencesOfAnswer(answer);
    const copied = copiedSentenceNumbers(sentences, MATERIAL);
    expect([...copied].map((number) => sentences[number - 1]!.text)).toEqual([
      'The prism ring gathers light.',
      'Then the beam sweeps across the sea.',
    ]);
    const prepared = trimmed(answer);
    expect(prepared.counts.copied).toBe(2);
    expect((prepared.authored.blocks[0] as { text: string }).text).toBe(
      'A ring of glass bends the light. Sailors read the flashes.',
    );
  });

  it('takes out a list item, and reads the items of a list as one text', () => {
    // The run starts in the first item and ends in the second: both are taken out and the list is gone, with its block.
    const answer = answerOf([
      paragraph('A ring of glass bends the light.'),
      {
        type: 'list',
        cites: ['e1'],
        items: ['A prism ring around the flame gathers', 'the light into a single beam that sweeps across the water.'],
      },
      paragraph('Sailors read the flashes.'),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect(prepared.counts.copied).toBe(2);
    expect(prepared.authored.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'callout']);
    expect(prepared.blockOrigin).toEqual([0, 2, 3]);
    // One item copied out of three leaves a list of two; out of two leaves a paragraph of the same passages.
    const three = trimmed(
      answerOf([
        paragraph('A ring of glass bends the light.'),
        { type: 'list', cites: ['e4'], items: ['Fog hides the beam.', COPIED, 'A horn carries the warning.'] },
        limit,
      ]),
    );
    expect(three.authored.blocks[1]).toEqual({
      type: 'list',
      cites: ['e4'],
      items: ['Fog hides the beam.', 'A horn carries the warning.'],
    });
    const two = trimmed(
      answerOf([
        paragraph('A ring of glass bends the light.'),
        { type: 'list', cites: ['e4'], items: ['Fog hides the beam.', COPIED] },
        limit,
      ]),
    );
    expect(two.authored.blocks[1]).toEqual({ type: 'paragraph', cites: ['e4'], text: 'Fog hides the beam.' });
  });

  it('removes a heading whose section was all copied, and tells where each block that is left stood in the draft', () => {
    const answer = answerOf([
      paragraph('A ring of glass bends the light.'),
      { type: 'heading', text: 'The beam' },
      paragraph(COPIED),
      { type: 'heading', text: 'The upkeep' },
      paragraph('The keeper once wound the clockwork by hand.'),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect(prepared.authored.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'callout',
    ]);
    expect(textsOf(prepared.authored)).not.toContain('The beam');
    expect(prepared.blockOrigin).toEqual([0, 3, 4, 5]);
  });

  it('serves a callout without its copied sentence, and takes out a callout that was all copied', () => {
    const answer = answerOf([
      paragraph('A ring of glass bends the light.'),
      { ...limit, text: `Radio is not covered. ${COPIED}` },
    ]);
    expect(trimmed(answer).authored.blocks.at(-1)).toMatchObject({ kind: 'limit', text: 'Radio is not covered.' });
    const whole = trimmed(answerOf([paragraph('A ring of glass bends the light.'), { ...limit, text: COPIED }]));
    // The compile refuses an answer that no longer ends with the limits callout; the trim does not.
    expect(whole.authored.blocks.map((block) => block.type)).toEqual(['paragraph']);
  });

  it('is refused by a finding at the opening paragraph when none of its sentences is left', () => {
    const answer = answerOf([
      { type: 'heading', text: 'The short answer' },
      paragraph(`${COPIED} ${SOURCE[0]}`),
      paragraph('Sailors read the flashes.'),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect(prepared.issues).toEqual([{ code: DIRECT_ANSWER_LOST_CODE, path: 'blocks.1' }]);
    expect(prepared.counts.copied).toBe(2);
    // The paragraph that follows is not taken for the direct answer.
    expect(prepared.authored.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'callout']);
  });

  it('is kept as the writer’s direct answer when one of its sentences is left', () => {
    const answer = answerOf([paragraph(`${COPIED} A ring of glass bends the light.`), limit]);
    expect(trimmed(answer).issues).toEqual([]);
  });
});

describe('a title or a dek that copies a passage (D-350)', () => {
  it('is replaced by the line code wrote, and nothing else is changed', () => {
    const answer = answerOf([paragraph('A ring of glass bends the light.'), limit], { title: SOURCE[0]!.slice(0, 80) });
    const title = trimmed(answer);
    expect(title.counts).toEqual({ copied: 0, leaning: 0, titleReplaced: true, dekReplaced: false });
    expect(title.authored).toEqual({ ...answer, title: LINES.title });
    const dek = trimmed(answerOf([paragraph('A ring of glass bends the light.'), limit], { dek: COPIED }));
    expect(dek.counts).toEqual({ copied: 0, leaning: 0, titleReplaced: false, dekReplaced: true });
    expect(dek.authored.dek).toBe(NEUTRAL_DEK);
    expect(dek.authored.title).toBe(TITLE);
  });

  it('is replaced whole, however few of its sentences copy', () => {
    const answer = answerOf([paragraph('A ring of glass bends the light.'), limit], {
      dek: `${COPIED} Sailors read the coast.`,
    });
    expect(trimmed(answer).authored.dek).toBe(NEUTRAL_DEK);
  });
});

describe('a sentence that leans (D-348)', () => {
  it('is kept in the middle of a block, because the sentence it leans on is kept', () => {
    const answer = answerOf([
      paragraph('The beam turns slowly. This is why sailors see a flash. It also lets them name the tower.'),
      paragraph('This block opens with a pointer. The beam is thin.'),
      limit,
    ]);
    // The first paragraph's first sentence does not lean, and a block's first sentence is exempt but for the answer's own.
    expect(trimAskAnswer(answer, RULES).counts).toBeUndefined();
  });

  it('is taken out when it is the first sentence of the answer, since nothing comes before it', () => {
    const answer = answerOf([
      { type: 'heading', text: 'The beam' },
      paragraph('This is the lamp of the Skerry. A ring of glass bends the light. It is thin.'),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect(prepared.counts).toEqual({ copied: 0, leaning: 1, titleReplaced: false, dekReplaced: false });
    // "It is thin." leans on the sentence now first, which is kept: only the opening pointer goes.
    expect((prepared.authored.blocks[1] as { text: string }).text).toBe('A ring of glass bends the light. It is thin.');
  });

  it('is taken out with the sentence it leans on, and the next one that leans on that, until none is left', () => {
    const answer = answerOf([
      paragraph('A ring of glass bends the light.'),
      paragraph(
        `${COPIED} This is why sailors see a flash. It also lets them name the tower. Each tower repeats its rhythm.`,
      ),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect(prepared.counts).toEqual({ copied: 1, leaning: 2, titleReplaced: false, dekReplaced: false });
    expect((prepared.authored.blocks[1] as { text: string }).text).toBe('Each tower repeats its rhythm.');
  });

  it('does not cascade across blocks: a block’s first sentence is exempt even after a block that was taken out', () => {
    const answer = answerOf([
      paragraph('A ring of glass bends the light.'),
      paragraph(COPIED),
      paragraph('This opens the next block. The beam is thin.'),
      limit,
    ]);
    const prepared = trimmed(answer);
    expect((prepared.authored.blocks[1] as { text: string }).text).toBe('This opens the next block. The beam is thin.');
    expect(prepared.counts.leaning).toBe(0);
  });

  it('a copied opening sentence counts as copied, not as leaning', () => {
    const answer = answerOf([paragraph(`${COPIED} This is why. A ring of glass bends the light.`), limit]);
    expect(trimmed(answer).counts).toMatchObject({ copied: 1, leaning: 1 });
  });
});

describe('the title code makes from the person’s question (D-350)', () => {
  const usable = () => true;

  it('is their words, one line, as they asked', () => {
    expect(titleFromQuestion('How does a lighthouse guide ships?', usable)).toBe('How does a lighthouse guide ships?');
    expect(titleFromQuestion('  Why   does\tit\nturn? ', usable)).toBe('Why does it turn?');
  });

  it('is cut after a whole word to the title limit, and ends in an ellipsis', () => {
    const long = `Why does the lamp of a lighthouse that stands on a rock in the sea turn at a steady pace all through the night and the day`;
    const title = titleFromQuestion(long, usable);
    expect(long.length).toBeGreaterThan(FIELD_LIMITS.titleChars);
    expect(title.length).toBeLessThanOrEqual(FIELD_LIMITS.titleChars);
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(long[title.length - 1]).toBe(' ');
    // A question of exactly the limit is kept whole.
    const exact = 'a'.repeat(FIELD_LIMITS.titleChars);
    expect(titleFromQuestion(exact, usable)).toBe(exact);
  });

  it('is the fixed title when there are no words, when the first word does not fit, or when the question cannot stand as a title', () => {
    expect(titleFromQuestion(undefined, usable)).toBe(FALLBACK_TITLE);
    expect(titleFromQuestion('   ', usable)).toBe(FALLBACK_TITLE);
    expect(titleFromQuestion('a'.repeat(FIELD_LIMITS.titleChars + 5), usable)).toBe(FALLBACK_TITLE);
    expect(titleFromQuestion('Why is the sky blue?', () => false)).toBe(FALLBACK_TITLE);
  });

  it('never holds a word that is not the person’s: the fixed lines are plain and short enough for the stored document', () => {
    expect(NEUTRAL_DEK.length).toBeGreaterThanOrEqual(10);
    expect(NEUTRAL_DEK.length).toBeLessThanOrEqual(FIELD_LIMITS.dekChars);
    expect(FALLBACK_TITLE.length).toBeLessThanOrEqual(FIELD_LIMITS.titleChars);
  });
});
