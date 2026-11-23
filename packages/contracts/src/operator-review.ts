import { oc } from '@orpc/contract';
import { z } from 'zod';
import { ScrollDocumentV2, ScrollDocumentV3 } from './content.js';
import { AssetIdSchema } from './ids.js';
import { OfferCoverSchema } from './navigation.js';

/**
 * The operator's review screen (#780, D-044, D-138): a library Scroll that a model wrote waits **held** until the release
 * policy or a person releases it. These routes let an operator read a held revision as a reader would, with the passages
 * each part cites and what the checks said, and release or reject it. Like every operator route, each answers `NOT_FOUND`
 * (404) unless the signed-in account is an operator of this world, and also for a revision that is not held, so nobody
 * learns which revisions exist. Reading is shared content, never personal data; the decision is recorded by the review gate.
 *
 * The inputs are plain strings on purpose: a malformed value must reach the operator check first, so an account that
 * is not an operator gets the same 404 whatever it sends. The handler parses them afterwards and answers
 * `INVALID_REQUEST` (400) to an operator.
 */

const Time = z.iso.datetime();
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The two stored schemas a held revision can have. */
export const ReviewDocumentVersionSchema = z.enum(['scroll-document.v2', 'scroll-document.v3']);

/** What the answer check of a v2 Scroll said, in one word; `null` where none ran (a document v3 has no calls to check). */
export const ReviewAnswerVerdictSchema = z.enum(['passed', 'repaired', 'flagged', 'unchecked']);

/** What the library support check said; `null` where it has not run for the revision yet. */
export const ReviewSupportVerdictSchema = z.enum(['passed', 'flagged', 'unchecked']);

/** One held revision, as the list shows it. Titles, counts and words about the checks; never body text. */
export const ReviewListItemSchema = z.strictObject({
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  title: z.string().min(1).max(200),
  kicker: z.string().min(1).max(80),
  documentVersion: ReviewDocumentVersionSchema,
  heldAt: Time,
  /** The recipe the Scroll was written for, when the plan or the stored recipes name its asset. */
  recipe: z.string().min(1).max(80).nullable(),
  /** The primary topic it is attributed to, when it has one. */
  topic: z.string().min(1).max(120).nullable(),
  /** Whether the recipe's planet and angle are mapped to this revision (a document v3 cannot be released without it). */
  coverage: z.enum(['mapped', 'unmapped']),
  readingMinutes: z.number().min(0).max(240),
  answerCheck: ReviewAnswerVerdictSchema.nullable(),
  supportCheck: ReviewSupportVerdictSchema.nullable(),
});
export type ReviewListItem = z.infer<typeof ReviewListItemSchema>;

export const ReviewListSchema = z.strictObject({ revisions: z.array(ReviewListItemSchema).max(500) });
export type ReviewList = z.infer<typeof ReviewListSchema>;

/** A passage a part cites, word for word, and the title of the page it comes from. Never the page's address. */
export const ReviewPassageSchema = z.strictObject({
  quote: z.string().min(1).max(1_200),
  source: z.string().min(1).max(300),
});

/**
 * The passages one part cites. `partId` is the id of a stop or beat, of an aside or of a picture in the document, or `recap`
 * (a v2 Scroll's) or `takeaway` (a document v3's end summary).
 */
export const ReviewCitedPartSchema = z.strictObject({
  partId: z.string().min(1).max(64),
  passages: z.array(ReviewPassageSchema).min(1).max(8),
});

/** One call the answer check flagged: its id in the document and what disagrees with what. */
export const ReviewAnswerFlagSchema = z.strictObject({
  id: z.string().min(1).max(64),
  problem: z.string().max(600).nullable(),
});

/**
 * What the answer check said about a v2 Scroll's calls. `flags` are the calls still flagged (`flagged`), or the ones the first
 * draft had and the writer repaired (`repaired`, `unchecked`).
 */
export const ReviewAnswerFindingsSchema = z.strictObject({
  outcome: ReviewAnswerVerdictSchema,
  calls: Count.nullable(),
  /** Why the check gave nothing, when it did not. Never provider text. */
  code: z.string().max(80).nullable(),
  flags: z.array(ReviewAnswerFlagSchema).max(40),
});

/** A sentence the support check could not clear: unsupported by the passages it cites, or unclear. */
export const ReviewSentenceSchema = z.strictObject({
  partId: z.string().min(1).max(64),
  /** The kind of text it is in: a paragraph, a title, an aside, a caption. */
  field: z.string().min(1).max(40),
  n: z.number().int().min(1),
  outcome: z.enum(['unsupported', 'unclear']),
  text: z.string().min(1).max(2_000),
  problem: z.string().max(600).nullable(),
});

/** What the support check said, by the policy in force: a model's opinion that informs the read and decides nothing. */
export const ReviewSupportFindingsSchema = z.strictObject({
  verdict: ReviewSupportVerdictSchema,
  checker: z.string().min(1).max(80),
  policy: z.string().min(1).max(80),
  code: z.string().max(80).nullable(),
  counts: z.strictObject({
    sentences: Count,
    supported: Count,
    unsupported: Count,
    unclear: Count,
    noClaim: Count,
  }),
  /** The sentences to read first, in reading order. */
  attention: z.array(ReviewSentenceSchema).max(300),
});

/**
 * One held revision to read: the document exactly as stored (the client parses it with its own parser), the cover a reader
 * would see in Explore, the passages each part cites, and the findings of both checks.
 */
export const ReviewShowSchema = z.strictObject({
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  heldAt: Time,
  recipe: z.string().min(1).max(80).nullable(),
  topic: z.string().min(1).max(120).nullable(),
  coverage: z.enum(['mapped', 'unmapped']),
  document: z.union([ScrollDocumentV2, ScrollDocumentV3]),
  /** `offer-cover.v2`, as Explore is sent it; `null` when the stored shape makes none. */
  cover: OfferCoverSchema.nullable(),
  parts: z.array(ReviewCitedPartSchema).max(64),
  answerCheck: ReviewAnswerFindingsSchema.nullable(),
  supportCheck: ReviewSupportFindingsSchema.nullable(),
});
export type ReviewShow = z.infer<typeof ReviewShowSchema>;

/** Why a release was refused, in the review gate's own words. */
export const ReviewReleaseRefusalSchema = z.enum([
  'asset_withdrawn',
  'not_newer_than_served',
  'coverage_missing',
  'revision_rejected',
]);

/** The release's result. A refusal is an answer, not an error: the screen says why in words. */
export const ReviewReleaseResultSchema = z.strictObject({
  outcome: z.enum(['released', 'already_released', 'refused']),
  reason: ReviewReleaseRefusalSchema.nullable(),
  /** The revision that was served before, when a release replaced one. */
  replacedRevision: z.number().int().min(1).nullable(),
});
export type ReviewReleaseResult = z.infer<typeof ReviewReleaseResultSchema>;

/** The reject's result. A revision that was served meanwhile cannot be rejected. */
export const ReviewRejectResultSchema = z.strictObject({
  outcome: z.enum(['rejected', 'already_rejected', 'refused']),
  reason: z.literal('revision_released').nullable(),
});
export type ReviewRejectResult = z.infer<typeof ReviewRejectResultSchema>;

const ReviewTarget = { assetId: z.string(), revision: z.string() } as const;

/** The held revisions, oldest first. `NOT_FOUND` (404) for anyone who is not an operator. */
export const reviewListContract = oc
  .route({ method: 'GET', path: '/v1/operator/review', successStatus: 200, tags: ['operator'] })
  .output(ReviewListSchema);

/**
 * One held revision to read. `NOT_FOUND` (404) for anyone who is not an operator and for a revision that is not held;
 * `INVALID_REQUEST` (400) for an operator whose asset or revision is malformed.
 */
export const reviewShowContract = oc
  .route({ method: 'GET', path: '/v1/operator/review/{assetId}/{revision}', successStatus: 200, tags: ['operator'] })
  .input(z.strictObject(ReviewTarget))
  .output(ReviewShowSchema);

/**
 * Releases exactly this held revision, as `content release` does: it is served from now on. Idempotent. `NOT_FOUND` for
 * anyone who is not an operator and for a revision that is not held.
 */
export const reviewReleaseContract = oc
  .route({
    method: 'POST',
    path: '/v1/operator/review/{assetId}/{revision}/release',
    successStatus: 200,
    tags: ['operator'],
  })
  .input(z.strictObject(ReviewTarget))
  .output(ReviewReleaseResultSchema);

/**
 * Rejects exactly this held revision with a reason of 1 to 500 characters, as `content reject` does: it is never served
 * and the recipe's next take is freed. Idempotent; the first reason is kept. `NOT_FOUND` for anyone who is not an operator
 * and for a revision that is not held; `INVALID_REQUEST` for an operator whose reason is empty or too long.
 */
export const reviewRejectContract = oc
  .route({
    method: 'POST',
    path: '/v1/operator/review/{assetId}/{revision}/reject',
    successStatus: 200,
    tags: ['operator'],
  })
  .input(z.strictObject({ ...ReviewTarget, reason: z.string().max(5_000).optional() }))
  .output(ReviewRejectResultSchema);

export const operatorReviewContract = {
  reviewList: reviewListContract,
  reviewShow: reviewShowContract,
  reviewRelease: reviewReleaseContract,
  reviewReject: reviewRejectContract,
};
