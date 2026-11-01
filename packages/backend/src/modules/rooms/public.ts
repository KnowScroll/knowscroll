import type { z } from 'zod';
import type {
  ActivityCreationSchema,
  ActivityListSchema,
  ActivityModerationAcceptanceSchema,
  ActivityViewSchema,
  AwayDismissalSchema,
  ConstellationVoteAcceptanceSchema,
  DebateVoteAcceptanceSchema,
  DiscussionChangesPageSchema,
  DiscussionCreationSchema,
  DiscussionHistoryPageSchema,
  DiscussionPinAcceptanceSchema,
  DiscussionViewSchema,
  FlawSolvedAcceptanceSchema,
  InhabitantAskAcceptanceSchema,
  LaunchAnsweredAcceptanceSchema,
  LaunchFinishedAcceptanceSchema,
  LaunchJoinedAcceptanceSchema,
  LaunchStartedAcceptanceSchema,
  PollVoteAcceptanceSchema,
  RoomFeedSchema,
  QuestionLeftAcceptanceSchema,
  QuestionNoticeAcceptanceSchema,
  RoomInviteAcceptanceSchema,
  RoomJoinAcceptanceSchema,
  ReplayRoundSchema,
  RoomLaunchSchema,
  RoomReplaySchema,
  RoomLeaveAcceptanceSchema,
  RoomListSchema,
  RoomMessageAcceptanceSchema,
  RoomMemoryReplacementSchema,
  RoomMessageHidingAcceptanceSchema,
  RoomModerationAcceptanceSchema,
  RoomPreferencesAcceptanceSchema,
  RoomPresenceAckSchema,
  RoomReportsSchema,
  RoomSkyViewSchema,
  RoomSnippetOpeningSchema,
  RoomStationsSchema,
  RoomTodaySchema,
  RoomTopicsSchema,
  RoomViewSchema,
  UsefulAcceptanceSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../identity/public.js';
import type { CastDueJob, CastPassJob, ContributeJob, SummariseJob } from './events.js';
import type { Result } from './application/ports.js';

export type { Result as RoomResult, RoomRefusal, ReadRoomReports, RoomReportRow } from './application/ports.js';
export {
  CastDueJobSchema,
  CastPassJobSchema,
  ContributeJobSchema,
  SummariseJobSchema,
  NightlyRitualsJobSchema,
  FeedHeartbeatJobSchema,
  castDueQueue,
  castPassQueue,
  contributeQueue,
  summariseQueue,
  nightlyRitualsQueue,
  feedHeartbeatQueue,
  type CastDueJob,
  type CastPassJob,
  type ContributeJob,
  type SummariseJob,
  type NightlyRitualsJob,
  type FeedHeartbeatJob,
} from './events.js';
export { libraryRoomSeeds } from './application/library-rooms.js';
export { DEFAULT_CAST, type CastMember } from './domain/cast.js';
export { UNPROMPTED_CAPS } from './domain/router.js';
export type { RoomSeed } from './application/seeds.js';

/**
 * Idea rooms: a room bound to a library topic, its members, the discussions held in it and the
 * labelled AI inhabitants that answer when a member asks (D-051). Every method takes the caller's
 * claimed authority and an unparsed body and rechecks authority itself: membership of the room,
 * its status and the caller's role. Answers use one `unavailable` shape for a stranger, a person
 * who left or was removed, and a missing room, so nothing says why. Reads create no evidence, and
 * no answer says what anyone watched. A list, a preview and a station count nobody; a member's own view
 * of a room names who is here (a number only from three), the member total and the last message (D-069).
 */
export interface RoomUseCases {
  /**
   * The room's feed for a member (v3 R-8, D-248): the newest finds residents posted, each about a library asset, and what the
   * residents remember. Off lists no find; Quieter holds the note back. Writes nothing.
   */
  feed(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomFeedSchema>>>;
  /** A moderator replaces what the residents remember with their own words, or clears it; audited (D-247). */
  replaceMemory(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof RoomMemoryReplacementSchema>>>;
  /** Today for a member: the day's approved question and Spot the flaw, the messages in Today so far and the days before (v3 R-5). */
  today(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomTodaySchema>>>;
  /** The member's one, final tap on today's Spot the flaw; a right first tap earns the room a star (D-174). */
  solveFlaw(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof FlawSolvedAcceptanceSchema>>>;
  /** The room's sky for a member: stars, the constellation and the name vote while one is open (D-174, D-175). */
  sky(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomSkyViewSchema>>>;
  /** The member's vote for a constellation's name, changeable until the vote closes. */
  nameConstellation(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ConstellationVoteAcceptanceSchema>>>;
  /**
   * The room's Launch for a member: the one running or, for a day, the last one's podium, and whether they may start one now
   * (v3 R-6, D-178). A question that is open carries no key, no count and no name. Writes nothing.
   */
  launch(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomLaunchSchema>>>;
  /** A member starts a Launch from the newest approved deck; refused while recording is paused (D-178, D-220). */
  startLaunch(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof LaunchStartedAcceptanceSchema>>>;
  /** A member says they are in a Launch that is on. */
  joinLaunch(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof LaunchJoinedAcceptanceSchema>>>;
  /** A player's answer to the open question; the server's clock decides whether it is in time and how long it took. */
  answerLaunch(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof LaunchAnsweredAcceptanceSchema>>>;
  /** A device found the Launch over: it is settled now, with the room's star when two people played. */
  finishLaunch(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof LaunchFinishedAcceptanceSchema>>>;
  /**
   * The finished Launch this member may replay and its five questions without their keys, or none (v3 R-7, D-241). Writes nothing:
   * nothing about the person replaying is kept.
   */
  replay(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomReplaySchema>>>;
  /** One question of the replay shown: the key and reason, and who got it right, in an order that says nothing of speed. Writes nothing. */
  replayRound(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ReplayRoundSchema>>>;
  /** Leaves a question for the next person: a topic, a card in General and, when asked, a resident's answer (v3 R-7, D-242). */
  leaveQuestion(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof QuestionLeftAcceptanceSchema>>>;
  /** The asker's own switch for being told when a person answers a question, and their acknowledgement of an answer. */
  questionNotice(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof QuestionNoticeAcceptanceSchema>>>;
  /** The member's vote on a debate's side, changeable until it closes (D-176). */
  voteDebate(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DebateVoteAcceptanceSchema>>>;
  list(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomListSchema>>>;
  read(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomViewSchema>>>;
  join(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomJoinAcceptanceSchema>>>;
  leave(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomLeaveAcceptanceSchema>>>;
  invite(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomInviteAcceptanceSchema>>>;
  moderate(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof RoomModerationAcceptanceSchema>>>;
  /** The caller's own AI level, keep-out choice and notice acknowledgement in a room (D-062). */
  setPreferences(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof RoomPreferencesAcceptanceSchema>>>;
  /**
   * The caller's device has the room open, or has closed it: a lease of one minute that shows their face (D-069). A return
   * after a long absence to enough new messages opens the window's "while you were away" (D-169).
   */
  setPresence(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomPresenceAckSchema>>>;
  /** The caller has read their "while you were away": it is not shown again. */
  dismissAway(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof AwayDismissalSchema>>>;
  /** The room's topics as a forum list: pinned first, then Hot, New or Unanswered, with one tag when asked (D-167). */
  topics(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomTopicsSchema>>>;
  create(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionCreationSchema>>>;
  send(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomMessageAcceptanceSchema>>>;
  pin(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionPinAcceptanceSchema>>>;
  hideMessage(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof RoomMessageHidingAcceptanceSchema>>>;
  /** The caller marks a message Useful, or takes the mark back: one per member per message, never their own (D-167). */
  markUseful(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof UsefulAcceptanceSchema>>>;
  /** The reports on this room's messages, for its moderators alone (D-055). */
  reports(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomReportsSchema>>>;
  readDiscussion(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionViewSchema>>>;
  history(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionHistoryPageSchema>>>;
  changes(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionChangesPageSchema>>>;
  openSnippet(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomSnippetOpeningSchema>>>;
  ask(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof InhabitantAskAcceptanceSchema>>>;
  /** The room stations of the caller's own map (U01, U02), each beside the place of its topic. */
  stations(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomStationsSchema>>>;
  /** Optional room activity (R03): a moderator's polls and quizzes, for members of the room only. */
  activities(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ActivityListSchema>>>;
  readActivity(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ActivityViewSchema>>>;
  createActivity(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ActivityCreationSchema>>>;
  votePoll(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof PollVoteAcceptanceSchema>>>;
  moderateActivity(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ActivityModerationAcceptanceSchema>>>;
}
export const ROOM_USE_CASES = Symbol('rooms.useCases');

/**
 * Port for the socket gateway: whether this account is a current member of the room, which is what lets a
 * socket subscribe to the room's hints. A lookup by IDs with no scope: it reads one membership row and decides
 * nothing else.
 */
export type ReadRoomMembership = (accountId: string, roomId: string) => Promise<boolean>;
export const READ_ROOM_MEMBERSHIP = Symbol('rooms.readRoomMembership');

/**
 * The worker's consumer of `rooms.contribute`: one member's ask of an AI inhabitant becomes at most
 * one labelled message. It acts as a system actor for the asker's universe and epoch and rechecks
 * membership, the room's status and the ask itself before it stores anything.
 */
export type ContributeAsInhabitant = (job: ContributeJob, signal: AbortSignal) => Promise<void>;
export const CONTRIBUTE_AS_INHABITANT = Symbol('rooms.contributeAsInhabitant');

/**
 * Port: a message of a room discussion the caller can see, for a report: its room and the account that
 * wrote it (none for an AI inhabitant). A caller who is not a current member of the room, a message a
 * moderator removed or that was deleted, and an unknown ID are all absent. Read inside the caller's
 * personal transaction; it decides nothing else.
 */
export type ReadReportableRoomMessage = (
  scope: PersonalScopeTx,
  accountId: string,
  messageId: string,
) => Promise<{ readonly roomId: string; readonly authorAccountId: string | null } | undefined>;
export const READ_REPORTABLE_ROOM_MESSAGE = Symbol('rooms.readReportableRoomMessage');

/** Bound by Feedback: the reports on one room's messages, for that room's moderators. */
export const READ_ROOM_REPORTS = Symbol('rooms.readRoomReports');

/**
 * The worker's consumers of `rooms.cast-due` and `rooms.cast-pass` (D-162, D-164): whether a resident answers a
 * message on its own, and the model call of a turn the router allowed. Registered only when the worker holds the
 * rooms grant (`KS_REASONING_ROOM_ENABLED`), so a world that leaves residents off leaves the jobs for one that
 * has it. Each acts as a system actor for the universe of the person whose message set it off and rechecks
 * everything before it writes.
 */
export type DecideCast = (job: CastDueJob) => Promise<void>;
export const DECIDE_CAST = Symbol('rooms.decideCast');
export type RunCastPass = (job: CastPassJob, signal: AbortSignal) => Promise<void>;
export const RUN_CAST_PASS = Symbol('rooms.runCastPass');

/**
 * The worker's consumer of `rooms.summarise` (D-169): the model call that writes one window's "while you were away", under
 * the room scope, as a resident's habit. Registered with the cast jobs, only where the worker holds the rooms grant.
 */
export type Summarise = (job: SummariseJob, signal: AbortSignal) => Promise<void>;
export const SUMMARISE = Symbol('rooms.summarise');

/**
 * Port for the socket gateway: a member of the room is typing in a discussion, which only holds back an AI turn
 * for a few seconds (D-067, D-165). Writes no person and no text; a non-member writes nothing and cannot tell.
 */
export type HoldCast = (hint: {
  readonly accountId: string;
  readonly roomId: string;
  readonly discussionId: string;
}) => Promise<void>;
export const HOLD_CAST = Symbol('rooms.holdCast');

/**
 * The picture of an approved painted backdrop, by the digest in its address (D-166): where it is in the media store and
 * what it is. Only an approved backdrop answers; a pending, rejected or replaced one is `undefined`, so a picture nobody
 * reviewed is never served. The API's media route reads it.
 */
export type ReadRoomBackdrop = (
  sha256: string,
) => Promise<
  { readonly key: string; readonly mime: 'image/jpeg' | 'image/png' | 'image/webp'; readonly size: number } | undefined
>;
export const READ_ROOM_BACKDROP = Symbol('rooms.readRoomBackdrop');

/**
 * The worker's consumer of `rooms.nightly-rituals` (D-176): drafts each room's day, a question from a library Scroll (a
 * template) and a Spot the flaw (one call under the room scope, as an `ambient` role), for an operator to approve. Registered
 * with the cast jobs, only where the worker holds the rooms grant. It throws when a room could not be drafted, so the job
 * retries; everything it stores is idempotent by (room, day, kind).
 */
export type RunNightlyRituals = (
  signal: AbortSignal,
  onRoomFailed: (slug: string, error: unknown) => void,
) => Promise<void>;
export const RUN_NIGHTLY_RITUALS = Symbol('rooms.runNightlyRituals');

/**
 * The worker's consumer of `rooms.feed-heartbeat` (v3 R-8, D-248): three times a day each open room with someone listening gets
 * a look from its residents. A look writes the room's memory again when due (one call, as an `ambient` role) and posts a find about
 * a library asset the room has not seen (one call, the model writing only the note; code chose the asset). Both run under the
 * nonpersonal `rooms` scope and make no call when there is nothing to do. Registered only where the worker holds the rooms grant
 * and `KS_ROOMS_FEED_ENABLED` is on. It throws when a room could not be looked at, so the job retries; everything it stores
 * is idempotent by (room, kind, slot).
 */
export type RunFeedHeartbeat = (
  signal: AbortSignal,
  onRoomFailed: (slug: string, error: unknown) => void,
) => Promise<void>;
export const RUN_FEED_HEARTBEAT = Symbol('rooms.runFeedHeartbeat');
