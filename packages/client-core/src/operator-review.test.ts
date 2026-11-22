import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import type { ApiClient } from './api-client';
import {
  isReviewNotFound,
  rejectReview,
  releaseReview,
  reviewListQueryOptions,
  reviewShowQueryOptions,
} from './operator-review';

const target = { assetId: '0199a000-0000-7000-8000-0000000000aa', revision: 3 };

function api() {
  const operator = {
    reviewList: vi.fn(() => Promise.resolve({ revisions: [] })),
    reviewShow: vi.fn(() => Promise.resolve({})),
    reviewRelease: vi.fn(() => Promise.resolve({ outcome: 'released', reason: null, replacedRevision: null })),
    reviewReject: vi.fn(() => Promise.resolve({ outcome: 'rejected', reason: null })),
  };
  return { operator, client: { operator } as unknown as Pick<ApiClient, 'operator'> };
}

describe('the operator review client', () => {
  it('reads the list and one revision again every time, with the revision as the route names it', async () => {
    const { operator, client } = api();
    const list = reviewListQueryOptions(client);
    expect(list.staleTime).toBe(0);
    await list.queryFn?.({ signal: new AbortController().signal } as never);
    expect(operator.reviewList).toHaveBeenCalledOnce();
    const show = reviewShowQueryOptions(client, target);
    expect(show.queryKey).toEqual(['operator', 'review', 'show', target.assetId, 3]);
    await show.queryFn?.({ signal: new AbortController().signal } as never);
    expect(operator.reviewShow).toHaveBeenCalledWith({ assetId: target.assetId, revision: '3' }, expect.anything());
  });

  it('sends a decision for exactly one revision, with the reason for a reject', async () => {
    const { operator, client } = api();
    expect(await releaseReview(client, target)).toMatchObject({ outcome: 'released' });
    expect(operator.reviewRelease).toHaveBeenCalledWith({ assetId: target.assetId, revision: '3' });
    expect(await rejectReview(client, target, 'Wrong picture.')).toMatchObject({ outcome: 'rejected' });
    expect(operator.reviewReject).toHaveBeenCalledWith({
      assetId: target.assetId,
      revision: '3',
      reason: 'Wrong picture.',
    });
  });

  it('knows the server’s 404 from any other failure', () => {
    const details = problemDetails('NOT_FOUND');
    const notFound = new ORPCError('NOT_FOUND', { status: details.status, message: details.title, data: details });
    expect(isReviewNotFound(notFound)).toBe(true);
    expect(isReviewNotFound(new Error('offline'))).toBe(false);
    expect(isReviewNotFound(new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 }))).toBe(false);
  });
});
