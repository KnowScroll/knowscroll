import { describe, expect, it } from 'vitest';
import { chooseQuestionSource, questionFrom } from './ritual-question.js';

const source = (title: string, summary: string, assetId = '0199b000-0000-7000-8000-000000000001') => ({
  assetId,
  assetRevision: 2,
  title,
  summary,
});

describe('the day’s question', () => {
  it('asks a claim to be explained to a friend, in the Scroll’s own words', () => {
    const question = questionFrom(
      source(
        'Seasons follow a tilted Earth, not a closer Sun.',
        'The tilt does the work. Distance does not. More follows.',
      ),
    )!;
    expect(question.prompt).toBe(
      'How would you explain this to a friend: “Seasons follow a tilted Earth, not a closer Sun”?',
    );
    expect(question.detail).toBe('The tilt does the work.');
    expect(question.source).toEqual({ assetId: '0199b000-0000-7000-8000-000000000001', assetRevision: 2 });
  });

  it('uses a title that already asks something as the question itself', () => {
    expect(questionFrom(source('Why is the night sky dark?', 'Because of the age of the universe.'))?.prompt).toBe(
      'Why is the night sky dark?',
    );
  });

  it('leaves the detail out when the summary’s first sentence is too long, and makes nothing from a title that does not fit', () => {
    expect(
      questionFrom(source('A claim about tides', `${'word '.repeat(80)}ends here. Next.`))?.detail,
    ).toBeUndefined();
    expect(questionFrom(source('x'.repeat(190), 'A summary.'))).toBeUndefined();
    expect(questionFrom(source('   ', 'A summary.'))).toBeUndefined();
  });

  it('chooses by seed among the Scrolls the room has not used lately, and among all when it used them all', () => {
    const a = source('A', 's.', 'a');
    const b = source('B', 's.', 'b');
    for (let seed = 0; seed < 5; seed += 1)
      expect(chooseQuestionSource([a, b], seed, new Set(['a']))?.assetId).toBe('b');
    expect(chooseQuestionSource([a, b], 0, new Set(['a', 'b']))).toBeDefined();
    expect(chooseQuestionSource([], 0, new Set())).toBeUndefined();
  });
});
