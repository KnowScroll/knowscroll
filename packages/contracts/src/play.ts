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
 *
 * The Final call is locked like a Call it (D-187). When a Scroll names a landmark, locking its Final
 * call awards it, gold for a right answer and plain for any other (D-188); the landmark is part of
 * the Scroll's results and of the person's own list. It is a trophy of one Scroll, never a level.
 */

/** A call has two or three options (`scroll-limits.v2`); this is the zero-based index of one. */
export const CallOptionSchema = z.number().int().min(0).max(2);

/** The finish of a landmark: gold for a right Final call, plain for any other. */
export const LandmarkTierSchema = z.enum(['gold', 'plain']);

/** A landmark a person earned: its stable key, the name they saw, and its finish. */
export const EarnedLandmarkSchema = z.strictObject({
  key: LocalId,
  name: z.string().min(4).max(40),
  tier: LandmarkTierSchema,
});

/**
 * What a person has locked on one Scroll revision, and what it earned. Zeroes when nothing was
 * locked. `landmark` is present once the Scroll's Final call was locked, when the Scroll names one.
 */
export const ScrollResultsSchema = z.strictObject({
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  /** The calls the person locked, in the order they locked them, the Final call included. At most four a Scroll. */
  calls: z.array(z.strictObject({ stopId: LocalId, option: CallOptionSchema, correct: z.boolean() })).max(4),
  /** One for each call that was right, and one more for a right Final call after a combo of two or more. */
  sparks: z.number().int().min(0).max(5),
  /** Right calls in a row, in the order they were locked. A wrong call ends it. */
  combo: z.number().int().min(0).max(4),
  landmark: EarnedLandmarkSchema.optional(),
});

/**
 * One landmark in the person's own list: which Scroll revision it was earned on, and when.
 * `topicId` is the public catalogue topic the Scroll is about, so the Universe can set the landmark
 * on that topic's planet once it has formed (D-084, D-214). It is absent when the Scroll can no
 * longer be read, and then the landmark waits in the tray. It says nothing about the person.
 */
export const LandmarkListEntrySchema = EarnedLandmarkSchema.extend({
  assetId: AssetIdSchema,
  revision: z.number().int().min(1),
  earnedAt: z.iso.datetime(),
  topicId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9][a-z0-9._-]{0,159}$/)
    .optional(),
});

/** The person's own landmarks, newest first. Their own and none else's. */
export const ReadLandmarksResponseSchema = z.strictObject({
  landmarks: z.array(LandmarkListEntrySchema).max(200),
});

/** Days of an Orbit that close it (D-087). One number, kept here so the screen and the server cannot differ. */
export const ORBIT_DAYS_TO_CLOSE = 3;

/**
 * The person's weekly Orbit (D-087, D-215): how many days of this week they played a Scroll's calls,
 * out of three. A week is Monday to Sunday in the person's own time zone. It is text, never a ring, a
 * streak or a loss: a missed week removes nothing, and the next Monday begins at zero.
 */
export const OrbitSchema = z.strictObject({
  /** Distinct days this week on which the person locked a call, 0 to 7. */
  days: z.number().int().min(0).max(7),
  goal: z.literal(ORBIT_DAYS_TO_CLOSE),
  /** The Monday this week began, as `YYYY-MM-DD` in the person's time zone. */
  weekStart: z.iso.date(),
  /** Three days or more this week. */
  closed: z.boolean(),
});

/**
 * The time zone names the person's days. An IANA name from the device; a name the server does not
 * know is read as UTC, never refused, so a read always answers.
 */
export const ReadOrbitRequestSchema = z.strictObject({
  timeZone: z.string().min(1).max(64).optional(),
});

export const ReadOrbitResponseSchema = z.strictObject({ orbit: OrbitSchema });

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
export type LandmarkTier = z.infer<typeof LandmarkTierSchema>;
export type EarnedLandmark = z.infer<typeof EarnedLandmarkSchema>;
export type Orbit = z.infer<typeof OrbitSchema>;
export type ReadOrbitRequest = z.infer<typeof ReadOrbitRequestSchema>;
export type ReadOrbitResponse = z.infer<typeof ReadOrbitResponseSchema>;
export type ReadLandmarksResponse = z.infer<typeof ReadLandmarksResponseSchema>;
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
  /** The person's own landmarks, each with the catalogue topic it belongs to. A read, so it works while recording is paused. */
  readLandmarks: post('/v1/play/landmarks/read', z.strictObject({}), ReadLandmarksResponseSchema),
  /** This week's Orbit, for the Universe's text. A read, so it works while recording is paused. */
  readOrbit: post('/v1/play/orbit/read', ReadOrbitRequestSchema, ReadOrbitResponseSchema),
};
