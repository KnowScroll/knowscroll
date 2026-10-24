import type { z } from 'zod';
import type {
  DiscussionChangesPageSchema,
  DiscussionCreationSchema,
  DiscussionHistoryPageSchema,
  DiscussionPinAcceptanceSchema,
  DiscussionViewSchema,
  InhabitantAskAcceptanceSchema,
  RoomInviteAcceptanceSchema,
  RoomJoinAcceptanceSchema,
  RoomLeaveAcceptanceSchema,
  RoomListSchema,
  RoomMessageAcceptanceSchema,
  RoomMessageHidingAcceptanceSchema,
  RoomModerationAcceptanceSchema,
  RoomSnippetOpeningSchema,
  RoomViewSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../identity/public.js';
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
}
export const ROOM_USE_CASES = Symbol('rooms.useCases');

/**
 * The worker's consumer of `rooms.contribute`: one member's ask of an AI inhabitant becomes at most
 * one labelled message. It acts as a system actor for the asker's universe and epoch and rechecks
 * membership, the room's status and the ask itself before it stores anything.
 */
export type ContributeAsInhabitant = (job: ContributeJob, signal: AbortSignal) => Promise<void>;
export const CONTRIBUTE_AS_INHABITANT = Symbol('rooms.contributeAsInhabitant');
