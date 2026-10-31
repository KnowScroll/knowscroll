import { z } from 'zod';

/**
 * The day's two ritual items of a room (R3 A and E, D-174): a question and Spot the flaw. Both are grounded in an
 * admitted library Scroll, both wait for an operator's approval before a member sees them, and neither is ever generated
 * while someone waits. This file is the stored shape (`ritual.v1`) and the day; the rules that build and check an item are
 * beside it (`flaw.ts`, `ritual-question.ts`). Pure.
 */

/** Written on every stored item; an item of another version is not shown. */
export const RITUAL_VERSION = 'ritual.v1';

export type RitualKind = 'question' | 'flaw';
export type RitualState = 'draft' | 'approved' | 'rejected';

/** The Scroll an item cites: its exact revision. */
export const RitualSourceSchema = z.strictObject({
  assetId: z.uuid(),
  assetRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

/**
 * The passage a Spot the flaw cites: a range of one text block of the exact revision, and the SHA-256 of the quoted words
 * as they stood, so a later check can prove the Scroll still says it. Written by code from the Scroll's own text.
 */
export const PassageCitationSchema = RitualSourceSchema.extend({
  blockId: z.string().min(1).max(160),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PassageCitation = z.infer<typeof PassageCitationSchema>;

/** The day's question: a template over a Scroll's title and summary, so it costs no model call. */
export const QuestionPayloadSchema = z.strictObject({
  prompt: z.string().min(1).max(200),
  detail: z.string().min(1).max(300).optional(),
  source: RitualSourceSchema,
});
export type QuestionPayload = z.infer<typeof QuestionPayloadSchema>;

/**
 * Spot the flaw: three to five sentences from a passage, one of them altered. `original` is the Scroll's own sentence at
 * `flawIndex` and is the key; the model wrote only the altered sentence, and code chose which one to alter.
 */
export const FlawPayloadSchema = z
  .strictObject({
    sentences: z.array(z.string().min(1).max(320)).min(3).max(5),
    flawIndex: z.number().int().min(0).max(4),
    original: z.string().min(1).max(320),
    source: PassageCitationSchema,
  })
  .refine((flaw) => flaw.flawIndex < flaw.sentences.length && flaw.sentences[flaw.flawIndex] !== flaw.original);
export type FlawPayload = z.infer<typeof FlawPayloadSchema>;

/** The UTC day of an instant, as `YYYY-MM-DD`: the unit rituals, stars' daily cap and Today are counted in. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
