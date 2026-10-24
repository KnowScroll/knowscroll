import type { z } from 'zod';
import type {
  ConversationChangesPageSchema,
  ConversationHistoryPageSchema,
  ConversationInboxSchema,
  ConversationLeaveAcceptanceSchema,
  ConversationMessageAcceptanceSchema,
  ConversationMuteAcceptanceSchema,
  ConversationReadAcceptanceSchema,
  ContentShareRevocationAcceptanceSchema,
  ContentThreadCreationSchema,
  ContentThreadViewSchema,
  ThreadChangesPageSchema,
  ThreadHistoryPageSchema,
  ThreadInboxSchema,
  ThreadInvitationResponseAcceptanceSchema,
  ThreadLeaveAcceptanceSchema,
  ThreadMessageAcceptanceSchema,
  ThreadReadAcceptanceSchema,
  ThreadSnippetOpeningSchema,
  CreateContentShareResultSchema,
  DirectConversationAcceptanceSchema,
  DirectConversationSnapshotSchema,
  OwnContentShareSchema,
  OwnContentSharesSchema,
  OwnConversationSendSchema,
  PublicContentSharePreviewSchema,
  ResolvedContentShareSchema,
  FriendPagesPageSchema,
  OwnFriendInvitesSchema,
  CreateFriendInviteResultSchema,
  FriendInviteAcceptanceSchema,
  ResolvedFriendInviteSchema,
  FriendCommandAcceptance,
  FriendPairResultSchema,
  OwnSharingProfileSchema,
  SharingPersonLookupSchema,
  SharingProfileAcceptanceSchema,
  SharingVisibilitySchema,
  SharingVisibilityAcceptanceSchema,
  OwnPresencePreferenceSchema,
  PresencePreferenceAcceptanceSchema,
  VisitorWorldSnapshotSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../identity/public.js';
import type { Operation } from './domain/friends.js';
import type { Result } from './application/ports.js';
/** Friends ports; live presence and visitor publication remain separate. */
export type { Result as SocialResult, SocialRefusal } from './application/ports.js';
export type { Operation as FriendOperation } from './domain/friends.js';
export interface SocialUseCases {
  readFriends(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof FriendPagesPageSchema>>>;
  readRequests(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof FriendPagesPageSchema>>>;
  readInvites(authority: PersonalAuthority): Promise<Result<z.infer<typeof OwnFriendInvitesSchema>>>;
  createInvite(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof CreateFriendInviteResultSchema>>>;
  revokeInvite(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof FriendInviteAcceptanceSchema>>>;
  resolveInvite(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ResolvedFriendInviteSchema>>>;
  readProfile(authority: PersonalAuthority): Promise<Result<z.infer<typeof OwnSharingProfileSchema>>>;
  setProfile(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof SharingProfileAcceptanceSchema>>>;
  lookup(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof SharingPersonLookupSchema>>>;
  readPair(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof FriendPairResultSchema>>>;
  command(authority: PersonalAuthority, operation: Operation, input: unknown): Promise<Result<FriendCommandAcceptance>>;
}
export const SOCIAL_USE_CASES = Symbol('social.useCases');

/**
 * Direct conversations and managed share links. Every method takes the caller's claimed
 * authority and an unparsed body, and re-checks authority itself. Reads create no evidence.
 */
export interface ConversationUseCases {
  readonly conversations: {
    start(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DirectConversationAcceptanceSchema>>>;
    send(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationMessageAcceptanceSchema>>>;
    markRead(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationReadAcceptanceSchema>>>;
    mute(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationMuteAcceptanceSchema>>>;
    leave(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationLeaveAcceptanceSchema>>>;
    inbox(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ConversationInboxSchema>>>;
    read(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DirectConversationSnapshotSchema>>>;
    history(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationHistoryPageSchema>>>;
    changes(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConversationChangesPageSchema>>>;
    readOwnSend(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof OwnConversationSendSchema>>>;
  };
  readonly shares: {
    create(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof CreateContentShareResultSchema>>>;
    revoke(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ContentShareRevocationAcceptanceSchema>>>;
    readOwn(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof OwnContentShareSchema>>>;
    list(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof OwnContentSharesSchema>>>;
    resolve(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ResolvedContentShareSchema>>>;
    /** For a visitor with no account; reads only public metadata of a live public link. */
    previewPublic(input: unknown): Promise<Result<z.infer<typeof PublicContentSharePreviewSchema>>>;
  };
}
export const CONVERSATION_USE_CASES = Symbol('social.conversationUseCases');

/**
 * Content threads (a Reel or Scroll, the people it was shared with and their conversation). Every
 * method takes the caller's claimed authority and an unparsed body and re-checks authority itself:
 * membership, the friendship an invitation rests on and the source's current state. Reads create
 * no evidence, and no answer carries another member's position, current episode or seen marker.
 */
export interface ThreadUseCases {
  create(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ContentThreadCreationSchema>>>;
  send(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadMessageAcceptanceSchema>>>;
  respond(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ThreadInvitationResponseAcceptanceSchema>>>;
  markRead(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadReadAcceptanceSchema>>>;
  leave(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadLeaveAcceptanceSchema>>>;
  read(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ContentThreadViewSchema>>>;
  history(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadHistoryPageSchema>>>;
  changes(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadChangesPageSchema>>>;
  inbox(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadInboxSchema>>>;
  openSnippet(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof ThreadSnippetOpeningSchema>>>;
}
export const THREAD_USE_CASES = Symbol('social.threadUseCases');

/** The account's current inbox revision, for the socket gateway's subscribe acknowledgement. */
export type ReadInboxRevision = (accountId: string) => Promise<number>;
export const READ_INBOX_REVISION = Symbol('social.readInboxRevision');

/**
 * What a person lets friends see (D-047): who may visit their universe and which systems, whether
 * they show as available, and a friend's visit. Every method takes the caller's claimed authority and
 * an unparsed body and rechecks authority itself. Reads create no evidence, and no method tells
 * anyone that a setting changed or that someone visited.
 */
export interface VisibilityUseCases {
  readVisibility(authority: PersonalAuthority): Promise<Result<z.infer<typeof SharingVisibilitySchema>>>;
  setVisibility(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof SharingVisibilityAcceptanceSchema>>>;
  readPresencePreference(authority: PersonalAuthority): Promise<Result<z.infer<typeof OwnPresencePreferenceSchema>>>;
  setPresencePreference(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof PresencePreferenceAcceptanceSchema>>>;
  /** A friend's published universe. Anyone not allowed gets the same `unavailable` answer. */
  readVisit(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof VisitorWorldSnapshotSchema>>>;
}
export const VISIBILITY_USE_CASES = Symbol('social.visibilityUseCases');

/**
 * One heartbeat from a signed-in person's open app. Stores a time only for a person who chose to show
 * availability, so a hidden person leaves nothing. The caller (the socket gateway) has already
 * checked the session; a heartbeat grants nothing and is never consumption evidence.
 */
export type RecordHeartbeat = (accountId: string) => Promise<void>;
export const RECORD_HEARTBEAT = Symbol('social.recordHeartbeat');

/**
 * Redraws one universe's published copy from the owner's current Geography. The worker runs it after
 * a scene projection, as a system actor that rechecks the universe and epoch itself.
 */
export type RefreshVisitPublication = (job: {
  readonly universeId: string;
  readonly privacyEpoch: number;
}) => Promise<'refreshed' | 'unchanged' | 'skipped'>;
export const REFRESH_VISIT_PUBLICATION = Symbol('social.refreshVisitPublication');
