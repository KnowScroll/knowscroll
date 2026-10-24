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
  RoomSnippetOpeningSchema,
  RoomStationsSchema,
  RoomViewSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../identity/public.js';
import type { ContributeJob } from './events.js';
import type { Result } from './application/ports.js';

export type { Result as RoomResult, RoomRefusal } from './application/ports.js';
export { contributeQueue, ContributeJobSchema, type ContributeJob } from './events.js';
export { libraryRoomSeeds } from './application/library-rooms.js';
export type { RoomSeed } from './application/seeds.js';

/**
 * Idea rooms: a room bound to a library topic, its members, the discussions held in it and the
 * labelled AI inhabitants that answer when a member asks (D-051). Every method takes the caller's
 * claimed authority and an unparsed body and rechecks authority itself: membership of the room,
 * its status and the caller's role. Answers use one `unavailable` shape for a stranger, a person
 * who left or was removed, and a missing room, so nothing says why. Reads create no evidence, and
 * no answer counts members, shows who is online or says what anyone watched.
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
  create(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionCreationSchema>>>;
  send(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomMessageAcceptanceSchema>>>;
  pin(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof DiscussionPinAcceptanceSchema>>>;
  hideMessage(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof RoomMessageHidingAcceptanceSchema>>>;
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
