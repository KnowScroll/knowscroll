import { queryOptions } from '@tanstack/react-query';
import type { ReviewList, ReviewRejectResult, ReviewReleaseResult, ReviewShow } from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

type ReviewApi = Pick<ApiClient, 'operator'>;

/** One held revision, as the review routes name it. */
export interface ReviewTarget {
  readonly assetId: string;
  readonly revision: number;
}

/** Keys of the review's queries. A decision invalidates all of them, so the list never shows a revision that was decided. */
export const operatorReviewKey = ['operator', 'review'] as const;

/** The held revisions (`GET /v1/operator/review`). Always read again when the screen opens: another operator may have decided one. */
export function reviewListQueryOptions(api: ReviewApi) {
  return queryOptions({
    queryKey: [...operatorReviewKey, 'list'] as const,
    queryFn: ({ signal }): Promise<ReviewList> => api.operator.reviewList(undefined, { signal }),
    staleTime: 0,
  });
}

/** One held revision to read (`GET /v1/operator/review/{assetId}/{revision}`). */
export function reviewShowQueryOptions(api: ReviewApi, target: ReviewTarget) {
  return queryOptions({
    queryKey: [...operatorReviewKey, 'show', target.assetId, target.revision] as const,
    queryFn: ({ signal }): Promise<ReviewShow> =>
      api.operator.reviewShow({ assetId: target.assetId, revision: String(target.revision) }, { signal }),
    staleTime: 0,
  });
}

/** Releases exactly this held revision. The gate's own answer, a refusal included, is the result; only a failure to ask throws. */
export function releaseReview(api: ReviewApi, target: ReviewTarget): Promise<ReviewReleaseResult> {
  return api.operator.reviewRelease({ assetId: target.assetId, revision: String(target.revision) });
}

/** Rejects exactly this held revision, with the reason the operator gave. */
export function rejectReview(api: ReviewApi, target: ReviewTarget, reason: string): Promise<ReviewRejectResult> {
  return api.operator.reviewReject({ assetId: target.assetId, revision: String(target.revision), reason });
}

/**
 * Whether the server found nothing: the account is not an operator, or the revision is not held (any more). The two are the
 * same answer on purpose, so the screen shows the unknown-page screen for both.
 */
export function isReviewNotFound(error: unknown): boolean {
  return apiProblem(error)?.code === 'NOT_FOUND';
}
