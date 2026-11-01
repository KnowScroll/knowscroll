import { oc } from '@orpc/contract';
import { z } from 'zod';
import { LocalId } from './content.js';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';

/**
 * Feedback on content (P03, D-055): "Not interested", and reports to the safety team.
 *
 * - **Not interested** is a short-lived routing constraint on one Reel or Scroll for the person who
 *   tapped it: it is not offered again until it lapses (`expiresAt`) or the person taps Undo. It is
 *   not evidence, not consumption and not a claim about the person.
 * - **A report** is a message to the safety team. Nobody it is about is ever told, and no route
 *   returns a report to the person it concerns. Operators read reports on the Operator screen; a
 *   room's moderators read the reports about messages in their room (`rooms.reports`).
 *
 * Every command carries a `commandId` minted once per intent and reused on retry: an identical
 * retry answers the first outcome with `replayed: true`, a different body under the same ID is
 * `COMMAND_KEY_REUSED`.
 */

const NOTE_MAX = 500;

/** Printable text: no control characters other than a line break, so a note cannot hide anything. */
function isPlainText(value: string): boolean {
  return [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point === 10 || (point >= 32 && (point < 127 || point > 159));
  });
}

/** What the person wrote, optional everywhere: a report never demands a justification. */
export const ReportNoteSchema = z.string().min(1).max(NOTE_MAX).refine(isPlainText);
export const REPORT_NOTE_MAX = NOTE_MAX;

// --- Not interested -------------------------------------------------------------------------

export const NotInterestedRequestSchema = z.strictObject({ commandId: CommandIdSchema, assetId: AssetIdSchema });

export const NotInterestedResponseSchema = z.strictObject({
  commandId: CommandIdSchema,
  assetId: AssetIdSchema,
  /** When the asset may be offered again without Undo. */
  expiresAt: z.iso.datetime(),
  /** True when this is the stored outcome of an earlier identical request. */
  replayed: z.boolean(),
});

/** Removes the constraint. Undoing what is not there succeeds: the asset is simply not excluded. */
export const UndoNotInterestedRequestSchema = z.strictObject({ commandId: CommandIdSchema, assetId: AssetIdSchema });

export const UndoNotInterestedResponseSchema = z.strictObject({
  commandId: CommandIdSchema,
  assetId: AssetIdSchema,
  replayed: z.boolean(),
});

// --- Reports --------------------------------------------------------------------------------

/** "What seems wrong?" (P03): the chips of the content error form. */
export const ContentErrorCategorySchema = z.enum(['wrong', 'out_of_date', 'misleading', 'other']);

/** The reason an abuse report names; the one thing a report cannot leave out. */
export const AbuseCategorySchema = z.enum([
  'harassment',
  'hate',
  'sexual_content',
  'violence',
  'spam',
  'self_harm',
  'other',
]);

/** Where in the content a person saw the problem: a moment in a Reel, or a block of a Scroll. */
export const ContentErrorAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reel'), positionMs: z.number().int().min(0).max(86_400_000) }),
  z.strictObject({ kind: z.literal('scroll'), blockId: LocalId }),
]);

/** The exact revision the person was looking at when they saw the problem. */
export const ReportedContentSchema = z.strictObject({
  assetId: AssetIdSchema,
  assetRevision: z.number().int().min(1),
});

export const ContentErrorReportRequestSchema = z.strictObject({
  commandId: CommandIdSchema,
  target: ReportedContentSchema,
  category: ContentErrorCategorySchema,
  anchor: ContentErrorAnchorSchema.optional(),
  note: ReportNoteSchema.optional(),
  /**
   * The Quick answer the person is reporting (D-255). The server reads its words from the person's own copy and keeps
   * them with the report, because the answer is erased a day later and the safety team could not otherwise read what
   * was wrong. Only the person's own, still-kept Quick answer about this Scroll revision is accepted; anything else is
   * a missing target, as for any report.
   */
  quickAnswerId: UuidSchema.optional(),
});

/**
 * What an abuse report is about. A `message` belongs to a conversation or content thread and a
 * `room_message` to an idea room; the caller must currently be able to see it. A `person` is named
 * by the public person ID the client already holds.
 */
export const AbuseTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('asset'), assetId: AssetIdSchema, assetRevision: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('message'), messageId: UuidSchema }),
  z.strictObject({ kind: z.literal('room_message'), messageId: UuidSchema }),
  z.strictObject({ kind: z.literal('person'), personId: UuidSchema }),
]);

export const AbuseReportRequestSchema = z.strictObject({
  commandId: CommandIdSchema,
  target: AbuseTargetSchema,
  category: AbuseCategorySchema,
  note: ReportNoteSchema.optional(),
});

/** The receipt of a report: it was received, and when. The reporter alone ever sees it. */
export const ReportReceiptSchema = z.strictObject({
  commandId: CommandIdSchema,
  reportId: UuidSchema,
  receivedAt: z.iso.datetime(),
  replayed: z.boolean(),
});

export type NotInterestedRequest = z.infer<typeof NotInterestedRequestSchema>;
export type NotInterestedResponse = z.infer<typeof NotInterestedResponseSchema>;
export type UndoNotInterestedRequest = z.infer<typeof UndoNotInterestedRequestSchema>;
export type UndoNotInterestedResponse = z.infer<typeof UndoNotInterestedResponseSchema>;
export type ContentErrorCategory = z.infer<typeof ContentErrorCategorySchema>;
export type AbuseCategory = z.infer<typeof AbuseCategorySchema>;
export type ContentErrorAnchor = z.infer<typeof ContentErrorAnchorSchema>;
export type ContentErrorReportRequest = z.infer<typeof ContentErrorReportRequestSchema>;
export type AbuseTarget = z.infer<typeof AbuseTargetSchema>;
export type AbuseReportRequest = z.infer<typeof AbuseReportRequestSchema>;
export type ReportReceipt = z.infer<typeof ReportReceiptSchema>;

function post<I extends z.ZodType, O extends z.ZodType>(path: `/v1/feedback/${string}`, input: I, output: O) {
  return oc
    .route({ method: 'POST', path, successStatus: 200, tags: ['feedback'] })
    .input(input)
    .output(output);
}

export const feedbackContract = {
  notInterested: post('/v1/feedback/not-interested', NotInterestedRequestSchema, NotInterestedResponseSchema),
  undoNotInterested: post(
    '/v1/feedback/not-interested/undo',
    UndoNotInterestedRequestSchema,
    UndoNotInterestedResponseSchema,
  ),
  reportContentError: post('/v1/feedback/content-errors', ContentErrorReportRequestSchema, ReportReceiptSchema),
  reportAbuse: post('/v1/feedback/abuse-reports', AbuseReportRequestSchema, ReportReceiptSchema),
};
