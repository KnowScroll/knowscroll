import { z } from 'zod';
import { AnswerAssumptionSchema, AnswerClaimTextSchema, AnswerNumberSchema } from '@knowscroll/contracts';

/**
 * The shapes of the short answer card's writer (D-211, D-159): what a model may send, and what a checked card stores.
 * The text limits are the contract's, so a card the writer proposes and the rules accept is one the thread can be served.
 */
const Handle = z.string().regex(/^e[1-9][0-9]?$/u);
const Cites = z.array(Handle).min(1).max(3);
const ClaimIds = z.array(z.string().min(1)).min(1).max(3);

/** What the writer answers: structure only. The rules of `answerRefusals` judge it. */
export const AnswerDraftSchema = z.strictObject({
  assumption: AnswerAssumptionSchema,
  claims: z
    .array(z.strictObject({ text: AnswerClaimTextSchema, cites: Cites }))
    .min(1)
    .max(3),
  numbers: z.array(z.strictObject({ ...AnswerNumberSchema.shape, cites: Cites })).max(3),
});

/** What a stored, checked card holds, read back from its row. */
export const StoredAnswerSchema = z.strictObject({
  version: z.literal('scenario-answer.v1'),
  assumption: AnswerAssumptionSchema,
  claims: z
    .array(z.strictObject({ text: AnswerClaimTextSchema, claimIds: ClaimIds }))
    .min(1)
    .max(3),
  numbers: z.array(z.strictObject({ ...AnswerNumberSchema.shape, claimIds: ClaimIds })).max(3),
});
