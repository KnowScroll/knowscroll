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
  PublicPersonRef,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx, ReadOn } from '../identity/public.js';
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

/**
 * A stored snippet anchor as the card every thread surface shows (friend threads and idea rooms): the
 * quote, label and settings words are copied from the exact revision and shown only while the content
 * is not withdrawn.
 */
export { snippetCard } from './application/thread-view.js';

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

/** A person other modules may name: a claimed sharing profile and the account behind it. */
export interface PublicPerson {
  readonly accountId: string;
  readonly person: PublicPersonRef;
}

/**
 * Port: the public profiles of people, by account or by public person ID, read inside the caller's
 * personal transaction. Only a claimed profile of an active account is returned; a person with none
 * is absent. It decides nothing about who may see whom.
 */
export type ReadPublicPeople = (
  scope: PersonalScopeTx,
  query: { readonly accountIds: readonly string[] } | { readonly personIds: readonly string[] },
) => Promise<readonly PublicPerson[]>;
export const READ_PUBLIC_PEOPLE = Symbol('social.readPublicPeople');

/**
 * Port: the caller's current friends (an accepted friendship neither side removed or blocked), at
 * most `limit` of them, or the one friend with this public person ID. Read inside the caller's
 * personal transaction. Another module uses it to decide an invitation or a rule such as "friends
 * of members"; it never reveals why someone is absent.
 */
export type ReadFriendAccounts = (
  scope: PersonalScopeTx,
  accountId: string,
  query: { readonly limit: number } | { readonly personId: string },
) => Promise<readonly PublicPerson[]>;
export const READ_FRIEND_ACCOUNTS = Symbol('social.readFriendAccounts');

/**
 * Port: of these accounts, the ones the caller has blocked. Read inside the caller's personal
 * transaction. Another module uses it to collapse a blocked person's words for the blocker; it says
 * nothing of who blocked the caller, so it can never tell a person they were blocked.
 */
export type ReadBlockedAmong = (
  scope: PersonalScopeTx,
  accountId: string,
  candidates: readonly string[],
) => Promise<ReadonlySet<string>>;
export const READ_BLOCKED_AMONG = Symbol('social.readBlockedAmong');
/**
 * What another module may do inside a thread (scenarios; later rooms): enter it as a member, read a
 * bounded window of its messages, keep receipts on it and tell the inboxes. It decides nothing about
 * who may take part: that stays Social's. See `application/thread-guest.ts`.
 */
export type { ThreadContextMessage, ThreadGuest, ThreadVisit, ThreadWindow } from './application/thread-guest.js';
export type { ReceiptKey as ThreadReceiptKey } from './application/ports.js';
export const THREAD_GUEST = Symbol('social.threadGuest');

/**
 * Whether the account takes part in the thread right now. A read with no lock; whatever acts on it
 * rechecks. `on` is where it reads: a caller inside a personal write passes its scope and the read
 * uses that transaction, never a second connection.
 */
export type ReadThreadStanding = (on: ReadOn, accountId: string, threadId: string) => Promise<boolean>;
export const READ_THREAD_STANDING = Symbol('social.readThreadStanding');

/** Tells every participant's inbox the thread changed, after a commit. A disposable hint; polling repairs a lost one. */
export type AnnounceThread = (threadId: string) => Promise<void>;
export const ANNOUNCE_THREAD = Symbol('social.announceThread');
