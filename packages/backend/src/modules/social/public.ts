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

/** The account's current inbox revision, for the socket gateway's subscribe acknowledgement. */
export type ReadInboxRevision = (accountId: string) => Promise<number>;
export const READ_INBOX_REVISION = Symbol('social.readInboxRevision');
