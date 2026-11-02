import { describe, expect, it } from 'vitest';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { MIN_SERVED_SENTENCES } from '../domain/ask-support.js';
import {
  ANSWER_LENGTH_CODE,
  ASK_ANSWER_CEILING_SENTENCES,
  ASK_ANSWER_FLOOR_SENTENCES,
  ASK_ANSWER_MAX_SENTENCES,
  ASK_ANSWER_MIN_SENTENCES,
  answerLengthHint,
  answerShapeIssues,
  leansOnPrevious,
  readingSentencesOf,
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
      paragraph(`Sentence number ${String.fromCharCode(97 + index)}.`),
    ),
    limit,
  ]);

describe('the length of the answer to a question (D-308, D-349)', () => {
  it('is asked for as 8 to 12 sentences of reading text, and the hint names that range', () => {
    expect([ASK_ANSWER_MIN_SENTENCES, ASK_ANSWER_MAX_SENTENCES]).toEqual([8, 12]);
    expect(answerLengthHint()).toContain('must have 8 to 12 sentences');
    expect(answerLengthHint().length).toBeLessThanOrEqual(256);
  });

  it('is refused only below 5 or above 20 sentences of reading text: the dek and callout text count, labels do not', () => {
    expect([ASK_ANSWER_FLOOR_SENTENCES, ASK_ANSWER_CEILING_SENTENCES]).toEqual([5, 20]);
    expect(ASK_ANSWER_FLOOR_SENTENCES).toBe(MIN_SERVED_SENTENCES);
    const lengthFindings = (count: number) => answerShapeIssues(withSentences(count));
    expect(lengthFindings(4)).toEqual([{ code: ANSWER_LENGTH_CODE, path: '$' }]);
    for (const count of [5, 7, 8, 12, 13, 17, 20]) expect(lengthFindings(count), String(count)).toEqual([]);
    expect(lengthFindings(21)).toEqual([{ code: ANSWER_LENGTH_CODE, path: '$' }]);
    expect(lengthFindings(22)).toEqual([{ code: ANSWER_LENGTH_CODE, path: '$' }]);
  });

  it('counts every sentence of a paragraph, a list item and a callout, not every block', () => {
    const answer = answerOf([
      paragraph('One. Two. Three.'),
      { type: 'list', cites: ['e1'], items: ['Four. Five.', 'Six.'] },
      { ...limit, text: 'Seven. Eight.' },
    ]);
    // The dek, three, three and two: nine.
    expect(readingSentencesOf(answer)).toBe(9);
    expect(answerShapeIssues(answer)).toEqual([]);
  });
});

describe('a sentence that leans on the one before it (D-309)', () => {
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

  it('is no finding of the shape: a draft whose sentences lean is not refused (D-348)', () => {
    const answer = answerOf([
      paragraph('This lamp is old. It was lit by hand. They kept it burning.'),
      paragraph('The beam turns. That is why sailors see a flash.'),
      { type: 'list', cites: ['e1'], items: ['This item opens the list.', 'Another item. It follows.'] },
      { ...limit, text: 'This answer is short. It leaves out radio.' },
    ]);
    expect(answerShapeIssues(answer)).toEqual([]);
  });
});
