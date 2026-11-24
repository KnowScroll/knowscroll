import { describe, expect, it } from 'vitest';
import type { ScrollV3Plan } from '../domain/library/plan.js';
import { hasAnswerCheck, isHeldForReview } from './review-hold.js';

const v3: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};

describe('the review hold', () => {
  it('holds a library Scroll planned as a document v3, whoever sent the job', () => {
    // Without this a document v3 job would be published straight to the library, unread.
    expect(isHeldForReview({ attribution: 'library', scrollV3: v3 })).toBe(true);
  });

  it('publishes a v1 recipe and an order as before', () => {
    expect(isHeldForReview({ attribution: 'library' })).toBe(false);
    expect(isHeldForReview({ attribution: 'none', scrollV3: v3 })).toBe(false);
  });
});

describe('the answer check', () => {
  it('runs for exactly the Scrolls the review gate holds, so a document v3 records its empty check', () => {
    expect(hasAnswerCheck({ attribution: 'library', scrollV3: v3 })).toBe(true);
    expect(hasAnswerCheck({ attribution: 'library' })).toBe(false);
    expect(hasAnswerCheck({ attribution: 'none', scrollV3: v3 })).toBe(false);
  });
});
