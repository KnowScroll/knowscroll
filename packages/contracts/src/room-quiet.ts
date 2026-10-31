import { z } from 'zod';
import { ConversationScopeSchema, ConversationTextSchema } from './conversations.js';
import { CommandIdSchema, UuidSchema } from './ids.js';
import {
  LAUNCH_ANSWER_SECONDS,
  LAUNCH_FACES_MAX,
  LAUNCH_QUESTIONS,
  LaunchFaceSchema,
  LaunchHostSchema,
} from './room-launch.js';
import { PublicPersonRefSchema, isPublicLabel } from './sharing.js';

/**
 * The quiet room (v3 R-7, R3 F, D-241 to D-243): what a room offers a person who is there alone, made only of things that really
 * happened. Two parts. The **replay** plays the newest finished Launch again against the answers the people who played it gave,
 * for as long as the server still keeps them (D-220), labelled as a replay on every screen and costing no model call. The
 * **question** is one a member leaves for the next person: a topic that stays open until a person answers, that a resident may
 * answer at once when the member asks, and that tells its asker when a person does.
 *
 * Members only. Nothing here is evidence for anyone (D-063), and no AI is ever counted as a person, a player or an answerer.
 */

const Version = z.literal('rooms.v1');
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Round = z.number().int().min(1).max(LAUNCH_QUESTIONS);
const Choice = z.number().int().min(0).max(2);
const Text = (max: number) => z.string().min(1).max(max).refine(isPublicLabel);
const Read = { version: Version, readId: UuidSchema };
const ScopedRead = { ...Read, scope: ConversationScopeSchema };
const Command = { version: Version, commandId: CommandIdSchema };
const Receipt = {
  version: Version,
  scope: ConversationScopeSchema,
  commandId: CommandIdSchema,
  recordedAt: z.iso.datetime(),
  replayed: z.boolean(),
  outcome: z.literal('accepted'),
};

// --- The replay --------------------------------------------------------------------------------

/**
 * What a member's own view of a room says of a replay: there is a finished Launch they did not play whose answers are still kept,
 * and the day it was played (UTC). It names no person and no number: the replay read has those.
 */
export const RoomReplayStripSchema = z.strictObject({ day: z.iso.date() });
export type RoomReplayStrip = z.infer<typeof RoomReplayStripSchema>;

const ReplayQuestion = z.strictObject({
  round: Round,
  prompt: Text(200),
  options: z.array(Text(120)).min(2).max(3),
});

export const ReadRoomReplaySchema = z.strictObject({ ...Read, roomId: UuidSchema });
export const RoomReplaySchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z.strictObject({
    ...ScopedRead,
    status: z.literal('ready'),
    /** The host of the Launch, who says the same template lines on a replay. Always labelled AI. */
    host: LaunchHostSchema,
    /** Absent when there is nothing to replay for this reader: no finished Launch within its seven days, or one they played. */
    replay: z
      .strictObject({
        launchId: UuidSchema,
        /** The day it was played (UTC). A replay always says which night it is. */
        day: z.iso.date(),
        /** How many people answered at least one question, as this reader sees it (a person they blocked is not counted). */
        played: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        /** The five questions with their options and **no key**: the right option comes with each answer. */
        questions: z.array(ReplayQuestion).length(LAUNCH_QUESTIONS),
        /** How long a question is open, for the ring the device counts by its own steady clock. */
        answerSeconds: z.literal(LAUNCH_ANSWER_SECONDS),
      })
      .optional(),
  }),
]);
export type RoomReplay = z.infer<typeof RoomReplaySchema>;

/**
 * One question of the replay, answered. The server holds the key and keeps nothing: this reads the answers of the people who played
 * and stores nothing about the person asking. What the person tapped, and how long they took, stay on their device: the answer is the
 * same whatever was tapped, so a read carries neither. A read that took a time would let anyone sweep it from 0 to 8 seconds and learn
 * when each recorded answer came in (D-241).
 */
export const ReadReplayRoundSchema = z.strictObject({
  ...Read,
  roomId: UuidSchema,
  launchId: UuidSchema,
  round: Round,
});
export const ReplayRoundSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...ScopedRead, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...ScopedRead,
      status: z.literal('ready'),
      launchId: UuidSchema,
      round: Round,
      /** The right option and why, in the Scroll's own words. */
      correct: Choice,
      explain: Text(280),
      /** How many people answered this question, and how many of them got it right (a person the reader blocked is left out). */
      locked: Counter,
      right: Counter,
      /**
       * The people who got it right, in an order that says nothing about who was quicker (by person ID, and the cut at twelve is taken
       * in that order). Nobody is named as wrong.
       */
      calledIt: z.array(LaunchFaceSchema).max(LAUNCH_FACES_MAX),
    })
    .refine((view) => view.right <= view.locked && view.calledIt.length <= view.right),
]);
export type ReplayRound = z.infer<typeof ReplayRoundSchema>;

// --- A question left for people ------------------------------------------------------------------

/** The shortest and longest question a member can leave: a question has words, and a topic's title is its first eighty characters. */
export const QUESTION_MIN_LENGTH = 8;
export const QUESTION_MAX_LENGTH = 300;
const QuestionText = ConversationTextSchema.refine(
  (text) => text.trim().length >= QUESTION_MIN_LENGTH && text.length <= QUESTION_MAX_LENGTH,
);

/**
 * A person has answered a question the caller left, and the caller has not yet opened the answer or dismissed the notice. The
 * first shown message of a person other than the asker, by someone the asker has not blocked (D-051). `at` is when it was written.
 */
export const QuestionReplySchema = z.strictObject({
  discussionId: UuidSchema,
  /** The caller's own question, as they wrote it (its first eighty characters). */
  title: Text(80),
  by: PublicPersonRefSchema,
  /** When the caller left the question, and when the person answered it: the screen says how long it took, in words. */
  askedAt: z.iso.datetime(),
  at: z.iso.datetime(),
});
export type QuestionReply = z.infer<typeof QuestionReplySchema>;

/** The most notices a room view carries; the rest wait their turn. */
export const QUESTION_REPLIES_MAX = 5;

/**
 * What a member's view of a room says of questions (R3 F): how many are waiting for a person, and which of the caller's own a person
 * has answered. Both are read from the messages, never stored as a number, and each is a real count: with no data there is no field.
 * The AI is never an answer here: a resident's words leave a question open.
 */
export const RoomQuestionsSchema = z.strictObject({
  /** Questions in the room that no person but the one who left them has answered. */
  waiting: Counter,
  /** The caller's own questions a person answered since they last looked, oldest first, at most five. */
  replies: z.array(QuestionReplySchema).max(QUESTION_REPLIES_MAX),
});
export type RoomQuestions = z.infer<typeof RoomQuestionsSchema>;

/**
 * Leaves a question for the next person. One command: a topic tagged Question that begins with these words, a card for it in General,
 * and, when `askNow` is set, a resident's answer as an asked turn within the usual bounds (D-167). It never starts the unprompted
 * router: no resident answers a question its asker did not ask them to. `notify` is whether the asker is told when a person answers.
 */
export const LeaveQuestionSchema = z.strictObject({
  ...Command,
  roomId: UuidSchema,
  text: QuestionText,
  askNow: z.boolean(),
  notify: z.boolean(),
});
export const QuestionLeftAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('question.leave'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  /** `queued`: a resident is writing. `resting`: the asked bounds were full, the question stays open for people. `kept_out`: the asker keeps their messages out of what AI reads, so no resident reads the words. `not_asked`: the asker chose not to. */
  asked: z.enum(['queued', 'resting', 'kept_out', 'not_asked']),
});

export type QuestionAsked = z.infer<typeof QuestionLeftAcceptanceSchema>['asked'];

/** Sets whether the asker is told, and/or records that they noticed an answer. Only the person who left the question may. */
export const SetQuestionNoticeSchema = z
  .strictObject({
    ...Command,
    roomId: UuidSchema,
    discussionId: UuidSchema,
    notify: z.boolean().optional(),
    noticed: z.literal(true).optional(),
  })
  .refine((command) => command.notify !== undefined || command.noticed !== undefined);
export const QuestionNoticeAcceptanceSchema = z.strictObject({
  ...Receipt,
  operation: z.literal('question.notice'),
  roomId: UuidSchema,
  discussionId: UuidSchema,
  notify: z.boolean(),
});
