import { describe, expect, it } from 'vitest';
import {
  ReviewCitedPartSchema,
  ReviewListItemSchema,
  ReviewRejectResultSchema,
  ReviewReleaseResultSchema,
  operatorContract,
} from './index.js';

describe('the operator review contract', () => {
  it('declares the four routes under /v1/operator/review, all for operators only', () => {
    const route = (procedure: { '~orpc': { route: { method?: string; path?: string } } }) =>
      `${procedure['~orpc'].route.method ?? ''} ${procedure['~orpc'].route.path ?? ''}`;
    expect(route(operatorContract.reviewList)).toBe('GET /v1/operator/review');
    expect(route(operatorContract.reviewShow)).toBe('GET /v1/operator/review/{assetId}/{revision}');
    expect(route(operatorContract.reviewRelease)).toBe('POST /v1/operator/review/{assetId}/{revision}/release');
    expect(route(operatorContract.reviewReject)).toBe('POST /v1/operator/review/{assetId}/{revision}/reject');
  });

  it('carries a passage as its quote and the title of its page, never an address', () => {
    const part = { partId: 'b1', passages: [{ quote: 'Snow found the pump.', source: 'A page title' }] };
    expect(ReviewCitedPartSchema.safeParse(part).success).toBe(true);
    const withAddress = {
      partId: 'b1',
      passages: [{ quote: 'Snow.', source: 'A', url: 'https://example.com/?sig=1' }],
    };
    expect(ReviewCitedPartSchema.safeParse(withAddress).success).toBe(false);
  });

  it('lists a revision with titles and words about its checks, and refuses a field it does not name', () => {
    const item = {
      assetId: '0199a000-0000-7000-8000-0000000000aa',
      revision: 1,
      title: 'A title',
      kicker: 'A kicker',
      documentVersion: 'scroll-document.v3',
      heldAt: '2026-11-22T01:00:00.000Z',
      recipe: null,
      topic: null,
      coverage: 'mapped',
      readingMinutes: 4,
      answerCheck: null,
      supportCheck: 'passed',
    };
    expect(ReviewListItemSchema.safeParse(item).success).toBe(true);
    expect(ReviewListItemSchema.safeParse({ ...item, body: 'the essay' }).success).toBe(false);
  });

  it('answers a decision with an outcome and, for a refusal, a reason the screen can say in words', () => {
    expect(
      ReviewReleaseResultSchema.safeParse({ outcome: 'refused', reason: 'coverage_missing', replacedRevision: null })
        .success,
    ).toBe(true);
    expect(
      ReviewReleaseResultSchema.safeParse({ outcome: 'refused', reason: 'because', replacedRevision: null }).success,
    ).toBe(false);
    expect(ReviewRejectResultSchema.safeParse({ outcome: 'refused', reason: 'revision_released' }).success).toBe(true);
  });
});
