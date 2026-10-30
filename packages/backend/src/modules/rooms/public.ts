import type { z } from 'zod';
import type {
  ActivityCreationSchema,
  ActivityListSchema,
  ActivityModerationAcceptanceSchema,
  ActivityViewSchema,
  DiscussionChangesPageSchema,
  DiscussionCreationSchema,
  DiscussionHistoryPageSchema,
  DiscussionPinAcceptanceSchema,
  DiscussionViewSchema,
  InhabitantAskAcceptanceSchema,
  PollVoteAcceptanceSchema,
  RoomInviteAcceptanceSchema,
  RoomJoinAcceptanceSchema,
  RoomLeaveAcceptanceSchema,
  RoomListSchema,
  RoomMessageAcceptanceSchema,
  RoomMessageHidingAcceptanceSchema,
  RoomModerationAcceptanceSchema,
  RoomPreferencesAcceptanceSchema,
  RoomPresenceAckSchema,
  RoomReportsSchema,
  RoomSnippetOpeningSchema,
  RoomStationsSchema,
  RoomViewSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../identity/public.js';
import type { ContributeJob } from './events.js';
import type { Result } from './application/ports.js';

export type { Result as RoomResult, RoomRefusal, ReadRoomReports, RoomReportRow } from './application/ports.js';
export { contributeQueue, ContributeJobSchema, type ContributeJob } from './events.js';
export { libraryRoomSeeds } from './application/library-rooms.js';
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
  /** The caller's device has the room open, or has closed it: a lease of one minute that shows their face (D-069). */
  setPresence(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomPresenceAckSchema>>>;
  create(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionCreationSchema>>>;
  send(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomMessageAcceptanceSchema>>>;
  pin(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionPinAcceptanceSchema>>>;
  hideMessage(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof RoomMessageHidingAcceptanceSchema>>>;
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
