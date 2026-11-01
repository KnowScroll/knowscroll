import { z } from 'zod';

/**
 * What a resident's answer must rest on before it is posted (D-298): library passages chosen by code, cited by the
 * writer, read again by the support check. Pure rules and constants; the model calls and the reads are in `application/`.
 */

/**
 * The line a resident posts when the library cannot support an answer. It is code's, never a model's, so nothing in it is a
 * fact; it says plainly what is missing and where a Scroll can be asked for. It speaks of no self (no "I", no "my").
 */
export const NOT_COVERED_LINE = "The library doesn't cover that yet. Ask from here on a Scroll to have one made.";

/** At most this many passages are offered to a resident for one answer. */
export const GROUND_MAX_PASSAGES = 4;
/** At most this many of them from one Scroll, so one long Scroll cannot be the whole ground. */
export const GROUND_MAX_PER_ASSET = 2;
/** The most characters of one passage: a window of the stop's own sentences around the words the question uses. */
export const GROUND_PASSAGE_CHARS = 900;
/** The most passages an answer may cite. */
export const ANSWER_MAX_CITES = 3;
/** The most sentences an answer may have: one request of the support check carries them all (D-267). */
export const ANSWER_MAX_SENTENCES = 10;

/** The handle a passage is offered under: `e1`, `e2`, … (the same handles as an ask order's evidence). */
export const handleOf = (index: number): string => `e${String(index + 1)}`;

/** One library passage offered to a resident: a stretch of one stop of an admitted Scroll, under its handle. */
export interface GroundPassage {
  readonly handle: string;
  readonly assetId: string;
  readonly assetRevision: number;
  /** The stop the words come from (`LibraryPassageSource` block ID). */
  readonly blockId: string;
  readonly text: string;
}

/** Where an answer's words came from, kept on its turn: IDs of public content, never a word of it. */
export interface CitedPassage {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly blockId: string;
}

/**
 * How a turn's answer came out, kept on its row with the other provenance (`ai_turns.answer_support`).
 * - `cleared`: the first draft passed the figure rule and the support check.
 * - `cleared_after_rewrite`: the first draft did not, the one rewrite did.
 * - `not_covered`: the rewrite did not pass either, or the writer said the passages do not cover it, or the rewrite said so.
 * - `no_ground`: no passage of the library fit the question, so no model was asked.
 */
export type AnswerSupportResult = 'cleared' | 'cleared_after_rewrite' | 'not_covered' | 'no_ground';

export const ANSWER_SUPPORT_POLICY = 'rooms-answer-support.v1';

export interface AnswerSupportRecord {
  readonly policy: typeof ANSWER_SUPPORT_POLICY;
  readonly result: AnswerSupportResult;
  /** The passages the posted answer cited; none when nothing was posted from a draft. */
  readonly cited: readonly CitedPassage[];
  /**
   * How many sentences each draft had flagged (by the figure rule or the support check), first draft first. A count, never a
   * sentence: the record outlives the room's messages.
   */
  readonly flagged: readonly number[];
}

/** The record as it is read back from its row: a value that does not have this shape is not a record. */
export const AnswerSupportRecordSchema: z.ZodType<AnswerSupportRecord> = z.strictObject({
  policy: z.literal(ANSWER_SUPPORT_POLICY),
  result: z.enum(['cleared', 'cleared_after_rewrite', 'not_covered', 'no_ground']),
  cited: z
    .array(
      z.strictObject({
        assetId: z.string().max(64),
        assetRevision: z.number().int().positive(),
        blockId: z.string().max(128),
      }),
    )
    .max(ANSWER_MAX_CITES),
  flagged: z.array(z.number().int().min(0).max(ANSWER_MAX_SENTENCES)).max(2),
});

/**
 * The most paid model attempts one answer may make (D-300), and so the request bound its job's claim is sized from (reasoning
 * README, "Queue settings for a job that calls `propose`"): the writer's draft and the harness's one repair of an invalid
 * reply (2), the support check of it and its one repair (2), the one rewrite an unsupported sentence earns, which has no repair
 * of its own (1), and the check of the rewrite, which has none either (1). An answer is at most `ANSWER_MAX_SENTENCES`
 * sentences, so each check is one request.
 */
export const ANSWER_PAID_ATTEMPTS = 2 + 2 + 1 + 1;

/** Per paid attempt: the quota preflight (10 s), the provider's largest deadline (300 s) and two lock waits (5 s each). */
const ATTEMPT_SECONDS = 10 + 300 + 10;
/** What a delivery needs beyond its attempts: the reads before the first call and the settle after the last. */
const DELIVERY_MARGIN_SECONDS = 30;

/**
 * The seconds a delivery of an answering job may hold its claim: every paid attempt at the largest deadline, one after the
 * other, plus the waits around them. Below it pg-boss would expire a delivery that is still waiting on the provider, and the
 * next delivery would find the attempt `dispatched` and write it off as unknown.
 */
export const ANSWER_CLAIM_SECONDS = ANSWER_PAID_ATTEMPTS * ATTEMPT_SECONDS + DELIVERY_MARGIN_SECONDS;
