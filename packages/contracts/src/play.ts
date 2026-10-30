import { oc } from '@orpc/contract';
import { z } from 'zod';
import { LocalId } from './content.js';
import { AssetIdSchema, CommandIdSchema } from './ids.js';
import { RecordingGenerationSchema } from './recording.js';

/**
 * The play layer of a Scroll (D-063, D-064, D-180): a person locks a guess on a "Call it", and the
 * server keeps what they locked, whether it was right, and the sparks and combo it earned.
 *
 * Play is its own record. Which option was picked, whether it was right, sparks and combo are shown
 * back to the person and exported to them; they never feed ranking, planning, evidence, formation
 * or the Universe. Reading evidence still carries only the value-free `locked` and `revealed`
 * interactions (`interactions.ts`).
 *
 * Sparks belong to one Scroll. There is no total across Scrolls, no level and no ranking of people
 * (D-064).
 */

/** A call has two or three options (`scroll-limits.v2`); this is the zero-based index of one. */
export const CallOptionSchema = z.number().int().min(0).max(2);

/** What a person has locked on one Scroll revision, and what it earned. Zeroes when nothing was locked. */
export const ScrollResultsSchema = z.strictObject({
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  /** The calls the person locked, in the order they locked them. At most four a Scroll. */
  calls: z.array(z.strictObject({ stopId: LocalId, option: CallOptionSchema, correct: z.boolean() })).max(4),
  /** One for each call that was right. */
  sparks: z.number().int().min(0).max(4),
  /** Right calls in a row, in the order they were locked. A wrong call ends it. */
  combo: z.number().int().min(0).max(4),
});

export const ReadScrollResultsRequestSchema = z.strictObject({
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
});

/**
 * Locks the person's pick on one Call it of one revision. `commandId` is minted once per lock and
 * reused on retry. `recordingGeneration` is the generation of the person's recording policy the
 * client last read; while recording is paused nothing is stored (D-083).
 */
export const CallLockRequestSchema = z.strictObject({
  commandId: CommandIdSchema,
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  stopId: LocalId,
  option: CallOptionSchema,
  recordingGeneration: RecordingGenerationSchema,
});

/**
 * What is on record for the call after the command. `option` and `correct` are those of the first
 * lock: a second lock of the same call, by another command, stands as the first (`newlyLocked` is
 * false) and changes nothing.
 */
export const CallLockSavedSchema = z.strictObject({
  recorded: z.literal(true),
  commandId: CommandIdSchema,
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  stopId: LocalId,
  option: CallOptionSchema,
  correct: z.boolean(),
  newlyLocked: z.boolean(),
  results: ScrollResultsSchema,
  /** True when this is the stored answer of an earlier identical command. */
  replayed: z.boolean(),
});

/**
 * Nothing was stored, and nothing about the call is answered: the device keeps playing on its own.
 * `recording_paused` is the person's choice (Privacy, D-057); `recording_generation_stale` means
 * the policy changed since the client read it, so it should read the policy again.
 */
export const CallLockNotSavedSchema = z.strictObject({
  recorded: z.literal(false),
  reason: z.enum(['recording_paused', 'recording_generation_stale']),
  currentGeneration: RecordingGenerationSchema,
});

export const CallLockResponseSchema = z.discriminatedUnion('recorded', [CallLockSavedSchema, CallLockNotSavedSchema]);

export type CallOption = z.infer<typeof CallOptionSchema>;
export type ScrollResults = z.infer<typeof ScrollResultsSchema>;
export type ReadScrollResultsRequest = z.infer<typeof ReadScrollResultsRequestSchema>;
export type CallLockRequest = z.infer<typeof CallLockRequestSchema>;
export type CallLockSaved = z.infer<typeof CallLockSavedSchema>;
export type CallLockNotSaved = z.infer<typeof CallLockNotSavedSchema>;
export type CallLockResponse = z.infer<typeof CallLockResponseSchema>;

function post<I extends z.ZodType, O extends z.ZodType>(path: `/v1/play/${string}`, input: I, output: O) {
  return oc
    .route({ method: 'POST', path, successStatus: 200, tags: ['play'] })
    .input(input)
    .output(output);
}

export const playContract = {
  /** `call.lock`: idempotent by command ID; the server recomputes correctness from the immutable revision. */
  lockCall: post('/v1/play/calls/lock', CallLockRequestSchema, CallLockResponseSchema),
  /** The person's own results for one revision. A read, so it works while recording is paused. */
  readResults: post('/v1/play/results/read', ReadScrollResultsRequestSchema, ScrollResultsSchema),
};
