import type { z } from 'zod';
import type { ConversationContentProjectionSchema, PublicPersonRef } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { PairLock, SharedLock, SocialPorts } from './ports.js';

export type ContentCard = z.infer<typeof ConversationContentProjectionSchema>;

export interface ContentRef {
  readonly assetId: string;
  readonly assetRevision: number;
}

export interface ConversationRow {
  readonly conversationId: string;
  /** Null once the friendship's pair row went with a deleted account; the conversation is then closed. */
  readonly pairId: string | null;
  /** The friendship lineage the conversation belongs to; it lives only as long as that lineage. */
  readonly lineage: string;
  readonly lastSequence: number;
  readonly lastChangeSequence: number;
  readonly lastActivityAt: Date;
  /** Set when a member left: history stays, nothing more can be sent. */
  readonly closed: boolean;
}

export interface MemberRow {
  readonly accountId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly readThroughSequence: number;
  readonly muted: boolean;
  readonly left: boolean;
}

/** A stored message: a text bubble, a content card, or (no author, no body) a tombstone. */
export interface MessageRow {
  readonly sequence: number;
  readonly changeSequence: number;
  readonly messageId: string;
  readonly commandId: string | null;
  readonly recordedAt: Date;
  readonly author: PublicPersonRef | null;
  readonly text: string | null;
  readonly content: ContentRef | null;
  readonly note: string | null;
}

/** The caller's own membership, found before any lock so the peer's account can be gated first. */
export interface OwnMembership {
  readonly pairId: string | null;
  /** The other person's account; undefined when it was deleted and its membership removed. */
  readonly peerAccountId: string | undefined;
  readonly own: MemberRow;
}

/**
 * Where a conversation's rows are read and its own member row changed: under the friendship's pair
 * lock, or, when the other person's account is gone and there is no friendship to lock, in the
 * person's own scope.
 */
export type ConversationReader = SharedLock | PersonalScopeTx;

export interface Conversation {
  readonly conversation: ConversationRow;
  readonly own: MemberRow;
  /** Undefined once the other person's account was deleted. */
  readonly peer: MemberRow | undefined;
}

export interface InboxRow extends Conversation {
  /** The other person, or "Deleted account" in their place. */
  readonly peerPerson: PublicPersonRef;
  readonly lastMessage: MessageRow | undefined;
}

export interface NewMessage {
  readonly messageId: string;
  readonly commandId: string;
  readonly authorAccountId: string;
  readonly recordedAt: Date;
  readonly text?: string;
  readonly content?: ContentRef;
  readonly note?: string;
}

export interface InboxChange {
  readonly accountId: string;
  readonly universeId: string;
}

/**
 * Conversation rows. Writes and the thread reads need the pair lock (`PairLock`), taken by the
 * use case after the actor's gates; the inbox and membership lookups need none. Every method is
 * one explicit query or write; none of them decides access.
 */
export interface ConversationStore {
  /** The caller's membership in this conversation, whether or not it is still open. */
  ownMembership(scope: PersonalScopeTx, accountId: string, conversationId: string): Promise<OwnMembership | undefined>;
  /** The conversation and its members, as seen from the caller's own account. */
  load(reader: PairLock | PersonalScopeTx, conversationId: string, ownAccountId: string): Promise<Conversation | undefined>;
  /** The open conversation of a friendship lineage, if one exists. */
  findOpen(lock: PairLock, lineage: string, ownAccountId: string): Promise<Conversation | undefined>;
  create(
    lock: PairLock,
    input: {
      readonly conversationId: string;
      readonly lineage: string;
      readonly now: Date;
      readonly members: readonly { readonly accountId: string; readonly membershipId: string }[];
    },
  ): Promise<void>;
  /**
   * Stores a message under the next sequence and change numbers, taken atomically from the
   * conversation row, and returns them. Atomic counters are why account erasure can tombstone
   * messages without holding the pair lock.
   */
  append(lock: SharedLock, conversationId: string, message: NewMessage): Promise<Counters>;
  messages(
    reader: ConversationReader,
    conversationId: string,
    query: { readonly before?: number; readonly after?: number; readonly limit: number },
  ): Promise<readonly MessageRow[]>;
  messageOfCommand(
    reader: ConversationReader,
    conversationId: string,
    authorAccountId: string,
    commandId: string,
  ): Promise<MessageRow | undefined>;
  setReadThrough(
    reader: ConversationReader,
    conversationId: string,
    accountId: string,
    sequence: number,
  ): Promise<void>;
  setMuted(reader: ConversationReader, conversationId: string, accountId: string, muted: boolean): Promise<void>;
  /** Ends the caller's membership and closes the conversation. */
  leave(reader: ConversationReader, conversationId: string, accountId: string, now: Date): Promise<void>;
  /**
   * Bumps each account's inbox revision (in canonical account order, inside the pair lock) and sends
   * the live hint after commit. Returns nothing: hints carry only IDs and the new revision.
   */
  announce(reader: ConversationReader, changes: readonly InboxChange[], newEventId: () => string): Promise<void>;
  /** Open conversations with at least one message, newest activity first. */
  inbox(
    scope: PersonalScopeTx,
    accountId: string,
    query: {
      readonly after?: { readonly activityMs: number; readonly conversationId: string };
      readonly limit: number;
    },
  ): Promise<readonly InboxRow[]>;
  inboxRevision(scope: PersonalScopeTx, accountId: string): Promise<number>;
  /** Cards for content refs, read inside the open scope's transaction. */
  cards(reader: ConversationReader, refs: readonly ContentRef[]): Promise<readonly ContentCard[]>;
}

export interface Counters {
  readonly sequence: number;
  readonly changeSequence: number;
}

export interface ShareRow {
  readonly shareId: string;
  readonly ownerAccountId: string;
  readonly commandId: string;
  readonly target: ContentRef;
  readonly conversationId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ShareStore {
  insert(scope: PersonalScopeTx, share: ShareRow & { readonly tokenHash: string }): Promise<void>;
  byId(scope: PersonalScopeTx, shareId: string): Promise<ShareRow | undefined>;
  byCommand(scope: PersonalScopeTx, accountId: string, commandId: string): Promise<ShareRow | undefined>;
  byTokenHash(scope: PersonalScopeTx, tokenHash: string): Promise<ShareRow | undefined>;
  /** Marks the link revoked; false when it was already revoked. */
  revoke(scope: PersonalScopeTx, shareId: string, now: Date): Promise<boolean>;
  live(scope: PersonalScopeTx, accountId: string, now: Date, limit: number): Promise<readonly ShareRow[]>;
  /** The caller's open membership in a conversation whose friendship still stands, read without locks. */
  openMembership(
    scope: PersonalScopeTx,
    accountId: string,
    conversationId: string,
  ): Promise<OpenMembership | undefined>;
  cards(scope: PersonalScopeTx, refs: readonly ContentRef[]): Promise<readonly ContentCard[]>;
  /** Reads for a visitor with no account: shared content and a link found by its token, on the pool. */
  anonymous: {
    byTokenHash(tokenHash: string): Promise<ShareRow | undefined>;
    cards(refs: readonly ContentRef[]): Promise<readonly ContentCard[]>;
  };
}

export interface OpenMembership {
  readonly membershipId: string;
  readonly membershipRevision: number;
}

/** The friends ports plus what conversations and share links need. */
export interface ConversationPorts extends SocialPorts {
  conversations: ConversationStore;
  shares: ShareStore;
  /** A new share-link token (`kssh_` plus 43 random characters). */
  shareToken(): string;
}
