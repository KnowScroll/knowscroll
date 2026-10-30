import { describe, expect, it } from 'vitest';
import { contentOverlap, contentWords, MIN_CONTENT_WORDS, restates, RESTATEMENT_THRESHOLD } from './similarity.js';

describe('content words', () => {
  it('drop filler, case and plurals, and keep the rest as a set', () => {
    expect([...contentWords('Why do the tides rise, and Tides fall?')].sort()).toEqual(['fall', 'rise', 'tide']);
    expect([...contentWords('The class of buses')].sort()).toEqual(['buse', 'class']);
    expect(contentWords('  ').size).toBe(0);
  });
});

describe('contentOverlap', () => {
  it('is 1 for the same words in any order and 0 for none in common', () => {
    expect(contentOverlap('Earth leans toward the Sun', 'the Sun toward Earth leans')).toBe(1);
    expect(contentOverlap('Earth leans toward the Sun', 'Planets spin quickly overnight')).toBe(0);
  });

  it('declines to judge a text with too few content words', () => {
    expect(MIN_CONTENT_WORDS).toBe(3);
    expect(contentOverlap('Yes', 'Yes')).toBeUndefined();
    expect(contentOverlap('Earth leans toward the Sun', 'Yes')).toBeUndefined();
  });
});

describe('restates: the pinned threshold', () => {
  it('is 0.6', () => {
    expect(RESTATEMENT_THRESHOLD).toBe(0.6);
  });

  it('refuses a near-copy: a question asked again in nearly the same words', () => {
    expect(
      restates('Why is the north of Orrin warm in midsummer?', 'Why is the north of Orrin so warm in midsummer?'),
    ).toBe(true);
    expect(
      restates(
        'What makes the Sun shine for billions of years?',
        'What makes the Sun shine for so many billions of years?',
      ),
    ).toBe(true);
    expect(restates('Its northern half leans toward its star', 'The northern half leans toward its star')).toBe(true);
  });

  it('allows a genuinely different question on the same subject', () => {
    expect(
      restates(
        'Why is the north of Orrin warm in midsummer?',
        'Imagine Orrin stood perfectly upright. What would happen to its seasons?',
      ),
    ).toBe(false);
    expect(
      restates(
        'What makes the Sun shine for billions of years?',
        'A star twice as heavy as the Sun runs out of hydrogen sooner. Why?',
      ),
    ).toBe(false);
    expect(restates('Its northern half leans toward its star', 'Day length would stay much the same')).toBe(false);
  });

  it('sits well clear of the pinned threshold for the pairs above', () => {
    const near = contentOverlap(
      'What makes the Sun shine for billions of years?',
      'What makes the Sun shine for so many billions of years?',
    );
    const far = contentOverlap(
      'Why is the north of Orrin warm in midsummer?',
      'Imagine Orrin stood perfectly upright. What would happen to its seasons?',
    );
    expect(near ?? 0).toBeGreaterThan(RESTATEMENT_THRESHOLD);
    expect(far ?? 1).toBeLessThan(RESTATEMENT_THRESHOLD - 0.3);
  });
});
