import { z } from 'zod';
import { ConversationScopeSchema } from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import { RecordingGenerationSchema } from './recording.js';
import { PublicPersonRefSchema, isPublicLabel } from './sharing.js';

/**
 * The Launch (v3 R-6, R3 E, D-178 to D-179): a live quiz of five questions that a room plays together, with a podium for that
 * Launch only and a spoiler-free share card. Members only. The server's clock decides every question of time: a view carries the
 * time left in milliseconds, never a time of day, so a device counts the same seconds whatever its clock says. A question reaches a
 * reader only while it is open; its key, who got it right and how many answered reach them only when it closes. Answers are play
 * results (D-063): nothing here is evidence for anyone, and an AI never plays, never stands on the podium and is never counted.
 */

const Version = z.literal('rooms.v1');
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Round = z.number().int().min(1).max(5);
const Choice = z.number().int().min(0).max(2);
const Millis = z.number().int().min(0).max(3_600_000);
const Text = (max: number) => z.string().min(1).max(max).refine(isPublicLabel);
const Read = { version: Version, readId: UuidSchema };
const ScopedRead = { ...Read, scope: ConversationScopeSchema };
const Command = { version: Version, commandId: CommandIdSchema };

/** Questions in one Launch. */
export const LAUNCH_QUESTIONS = 5;
/** How long a question is open, in seconds, for the words a screen says before the first read arrives. The server's own number decides. */
export const LAUNCH_ANSWER_SECONDS = 8;
/** The most people drawn on a stage or a reveal. */
export const LAUNCH_FACES_MAX = 12;
/** The podium has three steps. */
export const LAUNCH_PODIUM_PLACES = 3;

/**
 * The host: a resident of the Launch, labelled as AI, that only speaks template lines drawn from the state of the game. It never
 * plays, has no person ID and is not a message: no model is asked, so a Launch makes no call.
 */
export const LAUNCH_HOST = { name: 'Pixel', label: 'AI · Quizmaster' } as const;
export const LaunchHostSchema = z.strictObject({ name: z.literal('Pixel'), label: z.literal('AI · Quizmaster') });
export type LaunchHost = z.infer<typeof LaunchHostSchema>;

/** One person in a Launch. `you` marks the caller. Never an AI. */
export const LaunchFaceSchema = z.strictObject({ person: PublicPersonRefSchema, you: z.boolean() });
export type LaunchFace = z.infer<typeof LaunchFaceSchema>;
const Faces = z.array(LaunchFaceSchema).max(LAUNCH_FACES_MAX);

const Question = {
  launchId: UuidSchema,
  round: Round,
  of: z.literal(LAUNCH_QUESTIONS),
  prompt: Text(200),
  options: z.array(Text(120)).min(2).max(3),
};

/** What the caller did in this Launch so far. */
const Own = { youIn: z.boolean() };

/**
 * The Launch in each phase. `open` has the question and its time left and **nothing that says which option is right**, how many
 * answered or who: that is the schema's own shape, not a client's courtesy. `reveal` has the key, the reason, how many answered and
 * the people who got it right (nobody is named as wrong). `finished` has the podium and the caller's own squares.
 */
export const LaunchViewSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    phase: z.literal('lobby'),
    launchId: UuidSchema,
    /** Time until the first question opens. */
    startsInMs: Millis,
    /** The people who are in, the caller first. */
    players: Faces,
    ...Own,
  }),
  z.strictObject({
    phase: z.literal('open'),
    ...Question,
    /** Time left to answer. */
    closesInMs: Millis,
    /** The caller's own answer, once they gave one. */
    yourChoice: Choice.optional(),
    ...Own,
  }),
  z
    .strictObject({
      phase: z.literal('reveal'),
      ...Question,
      /** The right option. */
      correct: Choice,
      /** Why, in the Scroll's own words. */
      explain: Text(280),
      yourChoice: Choice.optional(),
      /** How many people answered this question, and how many of them got it right. */
      locked: Counter,
      right: Counter,
      /** The people who got it right. Nobody is named as wrong (the count and the faces let a reader infer it, as R3 draws). */
      calledIt: Faces,
      /** The caller's right answers so far. */
      yourScore: z.number().int().min(0).max(LAUNCH_QUESTIONS),
      /** Time until the next question opens, or until the podium after the last. */
      nextInMs: Millis,
      last: z.boolean(),
      ...Own,
    })
    .refine(
      (view) => view.correct < view.options.length && view.right <= view.locked && view.calledIt.length <= view.right,
    ),
  z.strictObject({
    phase: z.literal('finished'),
    launchId: UuidSchema,
    /** How many people answered at least one question. */
    played: Counter,
    /** Up to three people with a right answer, best first. Nobody below third is listed. */
    podium: z
      .array(
        z
          .strictObject({
            place: z.number().int().min(1).max(LAUNCH_PODIUM_PLACES),
            score: z.number().int().min(1).max(LAUNCH_QUESTIONS),
            /** Absent when the reader blocked this person: the place stays, so the order is true, and nothing names them. */
            person: PublicPersonRefSchema.optional(),
            blockedByYou: z.boolean(),
            you: z.boolean(),
          })
          .refine((entry) => (entry.person === undefined) === entry.blockedByYou),
      )
      .max(LAUNCH_PODIUM_PLACES),
    /** The caller's own result, when they played. `squares` has one entry per question: right or not, never what was picked. */
    you: z
      .strictObject({
        score: z.number().int().min(0).max(LAUNCH_QUESTIONS),
        squares: z.array(z.boolean()).length(LAUNCH_QUESTIONS),
        place: z.number().int().min(1).max(LAUNCH_PODIUM_PLACES).optional(),
      })
      .optional(),
    /** The Launch earned the room a star. */
    star: z.boolean(),
    /** The day it was played (UTC), for the share card's title. */
    day: z.iso.date(),
    ...Own,
  }),
]);
export type LaunchView = z.infer<typeof LaunchViewSchema>;

/** Why a Launch cannot be started now. */
export const LaunchStartBlockSchema = z.enum(['no_deck', 'few_here', 'resting', 'room_paused']);
export type LaunchStartBlock = z.infer<typeof LaunchStartBlockSchema>;

export const ReadRoomLaunchSchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const RoomLaunchSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    host: LaunchHostSchema,
    /** The room's Launch now (lobby to reveal), or the last one for a day after it finished. Absent when there is none. */
    launch: LaunchViewSchema.optional(),
    /** Whether the caller may start one now. Absent while one is running. */
    start: z
      .discriminatedUnion('allowed', [
        z.strictObject({ allowed: z.literal(true) }),
        z.strictObject({ allowed: z.literal(false), reason: LaunchStartBlockSchema }),
      ])
      .optional(),
  }),
]);
export type RoomLaunch = z.infer<typeof RoomLaunchSchema>;

/**
 * What the room's own view says of the Launch for the Now strip: whether one can be started, is starting, is running, or just
 * finished. It names no person and no number.
 */
export const RoomLaunchStripSchema = z.strictObject({
  state: z.enum(['ready', 'lobby', 'live', 'finished']),
});
export type RoomLaunchStrip = z.infer<typeof RoomLaunchStripSchema>;

// --- Commands ---------------------------------------------------------------------------------

/**
 * Starting, joining and answering are play results the server keeps, so each carries the recording generation the device knows,
 * as a lock in a Scroll does. While recording is paused (or the generation is out of date) nothing is stored: the answer says
 * `not_saved`, no receipt is written, and a Launch cannot be played, because a round does not wait (D-083, D-182, D-220).
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

/** A member starts a Launch: the lobby opens for a few seconds, then five questions follow. */
export const StartLaunchSchema = z.strictObject({ ...Command, roomId: UuidSchema, ...Recorded });
export const LaunchStartedAcceptanceSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...Receipt,
    operation: z.literal('launch.start'),
    launchId: UuidSchema,
    startsInMs: Millis,
  }),
  NotSaved(z.literal('launch.start')),
]);

/** A member says they are in. */
export const JoinLaunchSchema = z.strictObject({ ...Command, roomId: UuidSchema, launchId: UuidSchema, ...Recorded });
export const LaunchJoinedAcceptanceSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...Receipt, operation: z.literal('launch.join'), launchId: UuidSchema }),
  NotSaved(z.literal('launch.join')),
]);

/**
 * A player's answer to the open question: the round and the option's place in the list. The server decides from its own clock
 * whether it came in time and measures how long it took; there is no field for a time. The first answer to a round stands.
 */
export const AnswerLaunchSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  launchId: UuidSchema,
  round: Round,
  choice: Choice,
  ...Recorded,
});
export const LaunchAnsweredAcceptanceSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...Receipt, operation: z.literal('launch.answer'), launchId: UuidSchema, round: Round }),
  NotSaved(z.literal('launch.answer')),
]);

/** A member's device found the Launch over: whatever time has made due is settled now (the star), and the podium can be read. */
export const FinishLaunchSchema = z.strictObject({ ...Command, roomId: UuidSchema, launchId: UuidSchema });
export const LaunchFinishedAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('launch.finish'),
  launchId: UuidSchema,
});
