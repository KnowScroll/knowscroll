import { oc } from '@orpc/contract';
import { z } from 'zod';
import { ClientCapabilities } from './content.js';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';
import { EncounterMetadataSchema, ExperienceSessionRefSchema } from './navigation.js';
import { RecordingGenerationSchema } from './recording.js';

const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Watermark = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Format = z.enum(['reel', 'scroll']);
const RequestedFormat = z.enum(['reel', 'scroll', 'either']);
const CatalogueId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,159}$/);

/**
 * An authority reference, never proof of permission or consumption. The consumer rechecks own
 * activated exposure, current epoch, exact immutable asset revision and current eligibility.
 * A supplied Composer session must match that exposure and the latest server intent revision;
 * direct encounters omit it. Playback positions and private history never travel here.
 */
const SourceEncounter = z.strictObject({
  exposureId: UuidSchema,
  assetId: AssetIdSchema,
  assetRevision: Revision,
  session: ExperienceSessionRefSchema.optional(),
});

/**
 * Where in the Scroll the person asked from: one stop of the exact immutable revision the source names.
 * The backend checks that the stop is in that revision; the stop's text is private context for the
 * writer, never part of a shared key.
 */
const AskAnchor = z.strictObject({ kind: z.literal('stop'), stopId: z.string().min(1).max(64) });

/** The most characters a person's question may have; the sheet shows a counter only near it. */
export const ASK_QUESTION_MAX = 280;

const TopicSubject = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z
      .string()
      .min(1)
      .max(500)
      .refine((text) => text.trim().length > 0, 'An ask cannot be blank.'),
  }),
  z.strictObject({
    kind: z.literal('catalogue'),
    catalogueVersion: z.literal('content-concepts.v1'),
    topicId: CatalogueId,
    facetId: CatalogueId.optional(),
  }),
]);

/**
 * A fresh deliberate submission, with one command ID reused unchanged on transport retry.
 * Catalogue syntax is not membership: the backend checks exact topic/facet meaning and version.
 * Text and source context remain private; neither may enter a global sharing key directly.
 * Topic context means "About this"; omission means "Something new". A variant names the same
 * explanation's other representation; the backend checks that `to` differs from the source.
 * Caller input grants no rights, shareability, budget or provider permission.
 *
 * This prerequisite declares topic and variant only. Series/related commissioning requires a
 * future Content-owned admitted declaration and consumer-facing revision; never invent a Part.
 * Canonical capabilities/session schemas retain their own existing validation semantics.
 */
export const CreateContentRequestSchema = z.strictObject({
  version: z.literal('content-request.v1'),
  commandId: CommandIdSchema,
  intent: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('topic'),
      subject: TopicSubject,
      format: RequestedFormat,
      context: SourceEncounter.optional(),
    }),
    z.strictObject({ kind: z.literal('variant'), source: SourceEncounter, to: Format }),
    /**
     * Ask from here (D1): a question about the Scroll the person is reading, from one of its stops. Code decides
     * what happens: a question the Scroll itself suggests, or one about the subject being read, becomes an ask
     * order (a short Scroll made for this person alone); one that clearly names another catalogue topic is
     * served from the library. The words are private, never an input of a shared key. An ask is refused while
     * recording is paused (D-083): it is tied to what the person has read.
     */
    z.strictObject({
      kind: z.literal('ask'),
      source: SourceEncounter,
      anchor: AskAnchor,
      question: z
        .string()
        .min(3)
        .max(ASK_QUESTION_MAX)
        .refine((text) => text.trim().length >= 3, 'An ask cannot be blank.'),
      recordingGeneration: RecordingGenerationSchema,
    }),
  ]),
  language: z
    .string()
    .min(1)
    .max(35)
    .refine((language) => language.trim().length > 0, 'Language cannot be blank.'),
  capabilities: ClientCapabilities,
});

const ReceiptFields = {
  commandId: CommandIdSchema,
  requestId: UuidSchema,
  recordedAt: z.iso.datetime(),
  privacyEpoch: Revision,
  /** Original committed personal-scope catch-up watermark, not a mutable status revision. */
  revision: Watermark,
  replayed: z.boolean(),
};

/**
 * Immutable acceptance after private demand, receipt and required pg-boss work commit atomically.
 * The request ID must exist. Status comes from a separate authorised resource read, including
 * immediate reuse; replay never turns this acceptance into ready. Owner/epoch come from the
 * authenticated AccountScope, not the request. Authority is rechecked even for receipt replay.
 */
export const ContentRequestReceiptSchema = z.strictObject({
  version: z.literal('content-request-receipt.v1'),
  ...ReceiptFields,
  outcome: z.literal('accepted'),
});

/** Read only: polling/catch-up never creates a demand, queues work or dispatches an attempt. */
export const ReadContentRequestSchema = z.strictObject({ requestId: UuidSchema });

const StatusFields = {
  version: z.literal('content-request-status.v1'),
  requestId: UuidSchema,
  privacyEpoch: Revision,
  requestRevision: Revision,
  /** Personal-scope catch-up watermark, compared with existing disposable scope hints. */
  revision: Watermark,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/**
 * A current authorised snapshot, never the original receipt. The consumer rechecks own scope,
 * epoch and current access. Clients fence by AccountScope and keep the highest request revision;
 * older reads cannot overwrite newer state. Withdrawal can change ready to unavailable.
 * Preparing always names real durable work. Ready binds only admitted, accessible content at an
 * immutable revision: it is no offer, exposure, rendering grant, qualification or auto-activation.
 * Fixed coarse reasons disclose no provider errors, balances, private evidence or other waiters.
 */
export const ContentRequestStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...StatusFields,
    status: z.literal('preparing'),
    phase: z.enum(['requested', 'preparing']),
    /**
     * How long an ask order usually takes, in seconds, measured from the orders that finished. Present only on a
     * request that is an ask order, and only once at least five orders have finished, so a time is never guessed.
     */
    typicalSeconds: z.number().int().min(1).max(86_400).optional(),
  }),
  z.strictObject({
    ...StatusFields,
    status: z.literal('ready'),
    content: z.strictObject({
      assetId: AssetIdSchema,
      assetRevision: Revision,
      explanationUnitId: z.string().min(1).max(160),
      metadata: EncounterMetadataSchema,
    }),
  }),
  z.strictObject({
    ...StatusFields,
    status: z.literal('unavailable'),
    reason: z.enum([
      'unsupported_request',
      'no_compatible_supply',
      'not_permitted',
      'budget_unavailable',
      'could_not_prepare',
      'source_unavailable',
    ]),
  }),
  z.strictObject({ ...StatusFields, status: z.literal('cancelled') }),
]);

/**
 * The person's own asks, newest first, each with the same current status a single read gives. A
 * request the Planner made on the person's behalf is not listed: it is not something they asked for.
 * `title` is the person's own words, the ask's catalogue topic, or the ready Scroll's title; it
 * never carries an internal brief. Read only, like a single read: listing creates no work.
 */
export const ContentRequestListSchema = z.strictObject({
  version: z.literal('content-request-list.v1'),
  requests: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(160),
        format: RequestedFormat,
        status: ContentRequestStatusSchema,
      }),
    )
    .max(50),
});

/** New deliberate cancel command; its exact command ID/input is reused on transport retry. */
export const CancelContentRequestSchema = z.strictObject({
  version: z.literal('content-request-cancel.v1'),
  commandId: CommandIdSchema,
  requestId: UuidSchema,
});

/**
 * Immutable scoped cancellation outcome after commit, subject to current authority on replay.
 * Cancels only this private waiter, not another waiter or shared work. A ready/unavailable request
 * is already_closed; cancellation recalls no dispatched paid attempt and guarantees no refund.
 * Replays retain the original outcome, epoch and watermark. Read current status separately.
 */
export const CancelContentRequestReceiptSchema = z.strictObject({
  version: z.literal('content-request-cancel-receipt.v1'),
  ...ReceiptFields,
  outcome: z.enum(['cancelled', 'already_cancelled', 'already_closed']),
});

/**
 * New deliberate retry of a request that could not be prepared. It re-drives the same request (same
 * ID, same words and brief), never a fresh one, and its command ID is reused on transport retry.
 */
export const RetryContentRequestSchema = z.strictObject({
  version: z.literal('content-request-retry.v1'),
  commandId: CommandIdSchema,
  requestId: UuidSchema,
});

/**
 * Immutable outcome of one retry command, after commit and subject to current authority on replay.
 * `retrying`: the request is waiting again (or already served from what exists); read its status for
 * which. `already_open`: it is still preparing or already ready, so nothing changed. `not_retryable`:
 * it did not close as "could not prepare", its attempts are used up, or nothing can start now (the
 * day's limit); the request is unchanged and the person should ask differently. A retry recalls and
 * resends no paid attempt: an attempt of unknown outcome is never resent.
 */
export const RetryContentRequestReceiptSchema = z.strictObject({
  version: z.literal('content-request-retry-receipt.v1'),
  ...ReceiptFields,
  outcome: z.enum(['retrying', 'already_open', 'not_retryable']),
});

export type CreateContentRequest = z.infer<typeof CreateContentRequestSchema>;
export type ContentRequestReceipt = z.infer<typeof ContentRequestReceiptSchema>;
export type ReadContentRequest = z.infer<typeof ReadContentRequestSchema>;
export type ContentRequestStatus = z.infer<typeof ContentRequestStatusSchema>;
export type ContentRequestList = z.infer<typeof ContentRequestListSchema>;
export type CancelContentRequest = z.infer<typeof CancelContentRequestSchema>;
export type CancelContentRequestReceipt = z.infer<typeof CancelContentRequestReceiptSchema>;
export type RetryContentRequest = z.infer<typeof RetryContentRequestSchema>;
export type RetryContentRequestReceipt = z.infer<typeof RetryContentRequestReceiptSchema>;

/** Declared HTTP boundary; the API adapter authenticates and fences the current AccountScope. */
export const createContentRequestContract = oc
  .route({ method: 'POST', path: '/v1/content/requests', successStatus: 200, tags: ['supply'] })
  .input(CreateContentRequestSchema)
  .output(ContentRequestReceiptSchema);

/** Current private status only. A GET cannot create work, retry production or activate content. */
export const readContentRequestContract = oc
  .route({ method: 'GET', path: '/v1/content/requests/{requestId}', successStatus: 200, tags: ['supply'] })
  .input(ReadContentRequestSchema)
  .output(ContentRequestStatusSchema);

/** The person's own recent asks and their current status; at most 20 of the newest. */
export const listContentRequestsContract = oc
  .route({ method: 'GET', path: '/v1/content/requests', successStatus: 200, tags: ['supply'] })
  .output(ContentRequestListSchema);

/** Body-only identity avoids competing path/body request IDs; transport retry retains the command. */
export const cancelContentRequestContract = oc
  .route({ method: 'POST', path: '/v1/content/requests/cancel', successStatus: 200, tags: ['supply'] })
  .input(CancelContentRequestSchema)
  .output(CancelContentRequestReceiptSchema);

/** Body-only identity, like cancel. Reopens only the person's own request that closed as could-not-prepare. */
export const retryContentRequestContract = oc
  .route({ method: 'POST', path: '/v1/content/requests/retry', successStatus: 200, tags: ['supply'] })
  .input(RetryContentRequestSchema)
  .output(RetryContentRequestReceiptSchema);
