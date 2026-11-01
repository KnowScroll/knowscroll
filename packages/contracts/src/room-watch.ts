import { z } from 'zod';
import { ConversationScopeSchema } from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { RecordingGenerationSchema } from './recording.js';
import { PublicPersonRefSchema, isPublicLabel } from './sharing.js';

/**
 * Watch together (v3 R-10, R3 A2, D-256 to D-258): a room watches one library Reel on a shared clock. The server keeps only which Reel,
 * when its first frame is due and, once it is over, when it stopped. **No answer carries anyone's playback position**, and none can: a
 * view has the time since the session began on the *server's* clock, and each device works its own position out from that and its own
 * steady clock. "N watching" is a number only from three and only counts people who joined the session (never an AI, never someone who
 * merely has the room open, never a person the reader blocked); below three there is no number at all, so nothing says who is watching.
 * Members only, and every refusal is the same `unavailable`. Watching is not evidence for anyone: a person's own watch becomes theirs
 * only through the ordinary Reel encounter their own device opens, never from this session.
 */

const Version = z.literal('rooms.v1');
const Millis = z.number().int().min(0).max(3_600_000);
const Command = { version: Version, commandId: CommandIdSchema };
const Read = { version: Version, readId: UuidSchema };
const ScopedRead = { ...Read, scope: ConversationScopeSchema };

/** "N watching" is shown from this many people who joined: below it, no number is sent. */
export const WATCH_COUNT_FROM = 3;
/** The most Reels a room is offered at once. */
export const WATCH_REELS_MAX = 24;

/** A library Reel a room may watch together. */
export const WatchReelSchema = z.strictObject({
  assetId: UuidSchema,
  assetRevision: z.number().int().min(1),
  title: z.string().min(1).max(160).refine(isPublicLabel),
  /** The Reel's length, so a screen can say "1:10" before it opens the Reel. */
  durationMs: z.number().int().min(1000).max(3_600_000),
});
export type WatchReel = z.infer<typeof WatchReelSchema>;

const Session = {
  sessionId: UuidSchema,
  reel: WatchReelSchema,
  /** The caller joined this session: only then is their device sent to open the Reel. */
  youIn: z.boolean(),
  /** The member who shared it, when they are still a member the reader has not blocked. */
  sharedBy: PublicPersonRefSchema.optional(),
  /** The caller started it, or moderates the room: they may stop it for everyone. */
  canStop: z.boolean(),
  /**
   * How many people who joined are watching, only from three (`WATCH_COUNT_FROM`) and only among people who still have the room
   * open; absent below that. The caller counts if they joined. Never a name, never an AI, never a person the reader blocked.
   */
  watching: z.number().int().min(WATCH_COUNT_FROM).max(10_000).optional(),
};

/**
 * The live session. `starting` has the time until the first frame is due; `playing` has the time since it was due, on the server's
 * clock. A device that is told `elapsedMs` of 41 000 plays the Reel at 41 s and keeps counting with its own steady clock, so a clock
 * that is fast, slow or set to another zone changes nothing. The time left is the Reel's length less `elapsedMs`.
 */
export const WatchSessionViewSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('starting'), ...Session, startsInMs: Millis }),
  z
    .strictObject({ phase: z.literal('playing'), ...Session, elapsedMs: Millis })
    .refine((view) => view.elapsedMs < view.reel.durationMs),
]);
export type WatchSessionView = z.infer<typeof WatchSessionViewSchema>;

/** The last thing on the room's stage, for the "Nothing on stage right now" card. A time, never a person. */
export const WatchLastOnStageSchema = z.strictObject({ kind: z.enum(['reel', 'launch']), at: z.iso.datetime() });
export type WatchLastOnStage = z.infer<typeof WatchLastOnStageSchema>;

/** Why a Reel cannot be started now. */
export const WatchStartBlockSchema = z.enum(['no_reels', 'few_here', 'stage_busy', 'too_many', 'room_paused']);
export type WatchStartBlock = z.infer<typeof WatchStartBlockSchema>;

export const ReadRoomWatchSchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const RoomWatchSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    /** The room's live session; absent when none is on. */
    session: WatchSessionViewSchema.optional(),
    /** Whether the caller may start one now. Absent while one is live. */
    start: z
      .discriminatedUnion('allowed', [
        z.strictObject({ allowed: z.literal(true) }),
        z.strictObject({ allowed: z.literal(false), reason: WatchStartBlockSchema }),
      ])
      .optional(),
    /** What was last on the stage, when something was; absent for a room that never had anything on it. */
    last: WatchLastOnStageSchema.optional(),
  }),
]);
export type RoomWatch = z.infer<typeof RoomWatchSchema>;

/** The room's own view says only whether a Reel can be offered or one is on: no person, no number (a member's view and a station). */
export const RoomWatchStripSchema = z.strictObject({ state: z.enum(['ready', 'live']) });
export type RoomWatchStrip = z.infer<typeof RoomWatchStripSchema>;

/** The Reels the room's topic rests on, for the person who is about to start one. */
export const ReadWatchReelsSchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const WatchReelsSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    reels: z.array(WatchReelSchema).max(WATCH_REELS_MAX),
  }),
]);
export type WatchReels = z.infer<typeof WatchReelsSchema>;

// --- Commands ---------------------------------------------------------------------------------

/**
 * Starting and joining are recorded in the room (who shared it, who joined), so each carries the recording generation the device
 * knows. While recording is paused (or the generation is out of date) nothing is stored: the answer says `not_saved` and no receipt is
 * written (D-083, D-258). Leaving and stopping remove or end what is stored, so they are always possible.
 */
const Recorded = { recordingGeneration: RecordingGenerationSchema };
const NotSaved = (operation: z.ZodLiteral<string>) =>
  z.strictObject({
    version: Version,
    scope: ConversationScopeSchema,
    commandId: CommandIdSchema,
    outcome: z.literal('not_saved'),
    operation,
    roomId: UuidSchema,
    reason: z.enum(['recording_paused', 'recording_generation_stale']),
  });
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
  roomId: UuidSchema,
};

/** A member starts Watch together on a library Reel of the room's topic. They join it. */
export const StartWatchSchema = z.strictObject({ ...Command, roomId: UuidSchema, assetId: UuidSchema, ...Recorded });
export const WatchStartedAcceptanceSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...Receipt, operation: z.literal('watch.start'), sessionId: UuidSchema, startsInMs: Millis }),
  NotSaved(z.literal('watch.start')),
]);

/** A member says they are watching, while the session is on. */
export const JoinWatchSchema = z.strictObject({ ...Command, roomId: UuidSchema, sessionId: UuidSchema, ...Recorded });
export const WatchJoinedAcceptanceSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...Receipt, operation: z.literal('watch.join'), sessionId: UuidSchema }),
  NotSaved(z.literal('watch.join')),
]);

/** A member leaves the stage: they are no longer counted and nothing of theirs is kept. */
export const LeaveWatchSchema = z.strictObject({ ...Command, roomId: UuidSchema, sessionId: UuidSchema });
export const WatchLeftAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('watch.leave'),
  sessionId: UuidSchema,
});

/** The member who shared the session, or a moderator, ends it for everyone. */
export const StopWatchSchema = z.strictObject({ ...Command, roomId: UuidSchema, sessionId: UuidSchema });
export const WatchStoppedAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('watch.stop'),
  sessionId: UuidSchema,
});
