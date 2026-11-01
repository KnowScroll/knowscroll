import { oc } from '@orpc/contract';
import { z } from 'zod';
import { AssetIdSchema, CommandIdSchema, UuidSchema } from './ids.js';
import { RecordingGenerationSchema } from './recording.js';

/**
 * Quick answer (V3 D2, D-086, D-253): a short, unchecked answer about words the person selected in a Scroll they are
 * reading. It is not a Scroll: nothing checks it the way a Scroll is checked, it is never evidence and it never reaches
 * the Universe. The server accepts the command and stores it; a worker answers later through the reasoning harness, so no
 * model is called on this path. The client learns by a disposable hint and by polling the status.
 */

/** The words a Quick answer carries wherever it is shown. It is part of the wire so no client can leave it out. */
export const QUICK_ANSWER_LABEL = 'Quick answer · not a checked Scroll' as const;

export const QUICK_ANSWER_PASSAGE_MAX = 400;
export const QUICK_ANSWER_QUESTION_MIN = 3;
export const QUICK_ANSWER_QUESTION_MAX = 200;
export const QUICK_ANSWER_ANSWER_MAX = 640;

const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Printable text: no control character other than a line break, so words cannot hide anything. */
function isPlainText(value: string): boolean {
  return [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point === 10 || (point >= 32 && (point < 127 || point > 159));
  });
}

/**
 * A fresh deliberate ask, with one command ID reused unchanged on transport retry. The words are the ones the person
 * selected in `stopId` of the exact revision they are reading: the server checks that the stop is a read stop of that
 * revision, that the person has opened it, and that the words are from that stop. `question` is the person's own
 * follow-up and is optional: without it the answer addresses what a reader of those words most likely wants to know.
 * Refused while recording is paused (D-254): the words name what the person is reading.
 */
export const AskQuickAnswerSchema = z.strictObject({
  version: z.literal('quick-answer-ask.v1'),
  commandId: CommandIdSchema,
  source: z.strictObject({ assetId: AssetIdSchema, assetRevision: Revision }),
  stopId: z.string().min(1).max(64),
  passage: z
    .string()
    .min(1)
    .max(QUICK_ANSWER_PASSAGE_MAX)
    .refine((text) => text.trim().length > 0, 'A passage cannot be blank.'),
  question: z
    .string()
    .min(QUICK_ANSWER_QUESTION_MIN)
    .max(QUICK_ANSWER_QUESTION_MAX)
    .refine((text) => text.trim().length >= QUICK_ANSWER_QUESTION_MIN && isPlainText(text), 'A question needs words.')
    .optional(),
  recordingGeneration: RecordingGenerationSchema,
});

/**
 * Why no Quick answer was started. Nothing is stored and no receipt is written, so the same command can be sent again.
 * `not_available`: the world's day is used up or Quick answers are off. `person_limit`: this person has had today's.
 * `too_many_open`: they already have the most that may wait at once.
 */
export const QuickAnswerRefusalReasonSchema = z.enum(['not_available', 'person_limit', 'too_many_open']);

/** Acceptance after the answer's row and its worker job commit together, or an honest "not now". */
export const AskQuickAnswerResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    version: z.literal('quick-answer-receipt.v1'),
    outcome: z.literal('accepted'),
    commandId: CommandIdSchema,
    quickAnswerId: UuidSchema,
    recordedAt: z.iso.datetime(),
    privacyEpoch: Revision,
    replayed: z.boolean(),
  }),
  z.strictObject({
    version: z.literal('quick-answer-receipt.v1'),
    outcome: z.literal('unavailable'),
    reason: QuickAnswerRefusalReasonSchema,
  }),
]);

export const ReadQuickAnswerSchema = z.strictObject({ quickAnswerId: UuidSchema });

const StatusFields = {
  version: z.literal('quick-answer-status.v1'),
  quickAnswerId: UuidSchema,
  privacyEpoch: Revision,
};

/**
 * The person's own Quick answer as it stands. Private to them: no other person, room or thread ever reads one. An answer
 * that is dismissed or past its day reads as not found. `covered: false` means what the person has read so far does not
 * say enough to answer; the card then says so, and "Make it a full Scroll" is the way on.
 */
export const QuickAnswerStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...StatusFields, status: z.literal('waiting') }),
  z.strictObject({
    ...StatusFields,
    status: z.literal('answered'),
    label: z.literal(QUICK_ANSWER_LABEL),
    question: z.string().min(1).max(QUICK_ANSWER_QUESTION_MAX),
    answer: z.string().min(1).max(QUICK_ANSWER_ANSWER_MAX),
    covered: z.boolean(),
  }),
  z.strictObject({ ...StatusFields, status: z.literal('unavailable'), reason: z.literal('could_not_answer') }),
]);

/** Closes the card and erases its words now. Idempotent: dismissing what is already gone succeeds. */
export const DismissQuickAnswerSchema = z.strictObject({ quickAnswerId: UuidSchema });
export const DismissQuickAnswerResultSchema = z.strictObject({
  version: z.literal('quick-answer-dismissed.v1'),
  quickAnswerId: UuidSchema,
});

export type AskQuickAnswer = z.infer<typeof AskQuickAnswerSchema>;
export type AskQuickAnswerResult = z.infer<typeof AskQuickAnswerResultSchema>;
export type QuickAnswerRefusalReason = z.infer<typeof QuickAnswerRefusalReasonSchema>;
export type QuickAnswerStatus = z.infer<typeof QuickAnswerStatusSchema>;
export type DismissQuickAnswerResult = z.infer<typeof DismissQuickAnswerResultSchema>;

export const askQuickAnswerContract = oc
  .route({ method: 'POST', path: '/v1/quick-answers', successStatus: 200, tags: ['quick-answers'] })
  .input(AskQuickAnswerSchema)
  .output(AskQuickAnswerResultSchema);

/** Current private status only. A GET starts no work. */
export const readQuickAnswerContract = oc
  .route({ method: 'GET', path: '/v1/quick-answers/{quickAnswerId}', successStatus: 200, tags: ['quick-answers'] })
  .input(ReadQuickAnswerSchema)
  .output(QuickAnswerStatusSchema);

export const dismissQuickAnswerContract = oc
  .route({ method: 'POST', path: '/v1/quick-answers/dismiss', successStatus: 200, tags: ['quick-answers'] })
  .input(DismissQuickAnswerSchema)
  .output(DismissQuickAnswerResultSchema);
