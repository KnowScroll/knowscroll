import { describe, expect, it } from 'vitest';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { MIN_SERVED_SENTENCES } from '../domain/ask-support.js';
import {
  ANSWER_LENGTH_CODE,
  ASK_ANSWER_MAX_SENTENCES,
  ASK_ANSWER_MIN_SENTENCES,
  LEANING_SENTENCE_CODE,
  answerShapeIssues,
  leansOnPrevious,
} from './ask-answer-shape.js';

/** Labelled CI text about an invented lighthouse: never provider output and never product content. */
const answerOf = (blocks: unknown[], dek = 'A ring of glass shapes one beam that sweeps the sea.') =>
  AuthoredScroll.parse({ title: 'How a lamp guides sailors', dek, blocks });
const paragraph = (text: string) => ({ type: 'paragraph', cites: ['e1'], text });
const limit = {
  type: 'callout',
  cites: ['e1'],
  kind: 'limit',
  title: 'Where this stops',
  text: 'Radio is not covered.',
};
/** An answer with `count` sentences of reading text: the dek, `count - 2` paragraphs of one sentence, and the limit line. */
const withSentences = (count: number) =>
  answerOf([
    { type: 'heading', text: 'The beam' },
    ...Array.from({ length: count - 2 }, (_unused, index) =>
      paragraph(`Sentence number ${'abcdefghijklmnop'[index]!}.`),
    ),
    limit,
  ]);

describe('the length of the answer to a question (D-305)', () => {
  it('is 8 to 12 sentences of reading text for the writer’s draft: the dek and callout text count, labels do not', () => {
    expect([ASK_ANSWER_MIN_SENTENCES, ASK_ANSWER_MAX_SENTENCES]).toEqual([8, 12]);
    const lengthFindings = (count: number) =>
      answerShapeIssues(withSentences(count), 'draft').filter((issue) => issue.code === ANSWER_LENGTH_CODE);
    expect(lengthFindings(7)).toEqual([{ code: ANSWER_LENGTH_CODE, path: '$' }]);
    expect(lengthFindings(8)).toEqual([]);
    expect(lengthFindings(12)).toEqual([]);
    expect(lengthFindings(13)).toEqual([{ code: ANSWER_LENGTH_CODE, path: '$' }]);
  });

  it('is 5 to 12 after a support check, when sentences may have been taken out on purpose', () => {
    expect(MIN_SERVED_SENTENCES).toBe(5);
    const after = (count: number) =>
      answerShapeIssues(withSentences(count), 'after_check').filter((issue) => issue.code === ANSWER_LENGTH_CODE);
    expect(after(4)).toHaveLength(1);
    expect(after(5)).toEqual([]);
    expect(after(12)).toEqual([]);
    expect(after(13)).toHaveLength(1);
  });

  it('counts every sentence of a paragraph, a list item and a callout, not every block', () => {
    const answer = answerOf([
      paragraph('One. Two. Three.'),
      { type: 'list', cites: ['e1'], items: ['Four. Five.', 'Six.'] },
      { ...limit, text: 'Seven. Eight.' },
    ]);
    // The dek, three, three and two: nine.
    expect(answerShapeIssues(answer, 'draft')).toEqual([]);
  });
});

describe('a sentence that leans on the one before it (D-305)', () => {
  it('is one that begins with This, That, These, Those, It or They', () => {
    for (const sentence of [
      'This is why.',
      'That is why.',
      'These are the reasons.',
      'Those are the reasons.',
      'It is why.',
      'They are the reasons.',
      'it is why.',
      'It’s why.',
      "It's why.",
      '“This is why,” she said.',
      '  That is why.',
    ])
      expect(leansOnPrevious(sentence), sentence).toBe(true);
  });

  it('is not one that begins with a word that only starts the same way, or with another word', () => {
    for (const sentence of [
      'Thistles grow here.',
      'Items stay on the shelf.',
      'Theatres open late.',
      'Thatch covers the roof.',
      'The beam turns.',
      'Because of this, the beam turns.',
      'Its glass is old.',
      'Their lamps are lit.',
      'Italy has lamps.',
      '',
    ])
      expect(leansOnPrevious(sentence), sentence).toBe(false);
  });

  it('is refused after the first sentence of a block, once for each block, and the first sentence of any block may begin so', () => {
    const answer = answerOf([
      paragraph('This lamp is old. It was lit by hand. They kept it burning.'),
      paragraph('The beam turns. That is why sailors see a flash.'),
      { type: 'list', cites: ['e1'], items: ['This item opens the list.', 'Another item. It follows.'] },
      { type: 'list', cites: ['e1'], items: ['The first item.', 'It is a second item.'] },
      { ...limit, text: 'This answer is short. It leaves out radio.' },
    ]);
    const leaning = answerShapeIssues(answer, 'draft').filter((issue) => issue.code === LEANING_SENTENCE_CODE);
    // Blocks 0 to 4 are paragraph, paragraph, list, list, callout. Each has a leaning sentence after its first one; the first sentence
    // of the third block, which opens it, is the only "This" that is allowed.
    expect(leaning.map((issue) => issue.path)).toEqual(['blocks.0', 'blocks.1', 'blocks.2', 'blocks.3', 'blocks.4']);
  });

  it('is allowed as the opening sentence of every block, and in a title, a heading or a callout title', () => {
    const answer = answerOf([
      { type: 'heading', text: 'This is a heading' },
      paragraph('This opens the first paragraph. The beam turns.'),
      paragraph('It opens the second. The beam is thin.'),
      { ...limit, title: 'It stops here', text: 'This answer leaves out radio.' },
    ]);
    expect(answerShapeIssues(answer, 'draft').filter((issue) => issue.code === LEANING_SENTENCE_CODE)).toEqual([]);
  });
});
