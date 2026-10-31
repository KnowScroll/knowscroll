import type { z } from 'zod';
import type { ConversationContentProjectionSchema, MessageReactionKind, PublicPersonRef } from '@knowscroll/contracts';
import type { ReadScrollPlayFacts } from '../../content/public.js';
import type { FencePersonalRecording, PersonalScopeTx } from '../../identity/public.js';
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
  /**
   * How far this person has read while their SEEN switch was on (D-150): never ahead of `readThroughSequence`, and the
   * only position the other person can be told. Direct conversations only; a thread member's stays 0.
   */
  readonly sharedReadThroughSequence: number;
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
  /** The earlier message of this conversation this one answers; null for a plain message and for a tombstone. */
  readonly replyToSequence: number | null;
  /** Set when the card is a challenge (D-245): the stop of the card's exact revision that the friend is asked to call. */
  readonly challengeStop: string | null;
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
  /** The sequence of the message this one answers, already checked to be in the same conversation. */
  readonly replyToSequence?: number;
  /** Makes a content card a challenge for this stop of its revision (D-245); the use case has checked the stop is a call. */
  readonly challengeStop?: string;
}

/** The call a challenge asks about: one stop of one exact Scroll revision. */
export interface ChallengeCall {
  readonly assetId: string;
  readonly revision: number;
  readonly stopId: string;
}

/** One person's stored pick on a challenge's call, never whether it was right (D-156). */
export interface ChallengePickStored extends ChallengeCall {
  readonly accountId: string;
  readonly option: number;
}

/** One person's reaction on one message, as the reader may see it (their blocks already left out). */
export interface ReactionRow {
  readonly sequence: number;
  readonly kind: MessageReactionKind;
  readonly accountId: string;
  readonly person: PublicPersonRef;
}

/** The words a reply quotes: the original's author (null once removed) and its text or note. */
export interface QuoteRow {
  readonly sequence: number;
  readonly messageId: string;
  readonly author: PublicPersonRef | null;
  readonly text: string | null;
  readonly note: string | null;
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
  load(
    reader: PairLock | PersonalScopeTx,
    conversationId: string,
    ownAccountId: string,
  ): Promise<Conversation | undefined>;
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
  /** The message with this ID in this conversation (never another's), and whether it is a tombstone. */
  messageRef(
    reader: ConversationReader,
    conversationId: string,
    messageId: string,
  ): Promise<{ readonly sequence: number; readonly removed: boolean } | undefined>;
  /** Whether the person holds this reaction on this message now. */
  hasReaction(
    reader: ConversationReader,
    reaction: {
      readonly conversationId: string;
      readonly sequence: number;
      readonly accountId: string;
      readonly kind: MessageReactionKind;
    },
  ): Promise<boolean>;
  /**
   * Puts the reaction on or takes it off, and gives the message the conversation's next change number so
   * catch-up carries it. The caller has already seen that the state differs. Does not move the
   * conversation's activity time or its message sequence.
   */
  setReaction(
    lock: SharedLock,
    reaction: {
      readonly conversationId: string;
      readonly sequence: number;
      readonly accountId: string;
      readonly kind: MessageReactionKind;
      readonly present: boolean;
      readonly now: Date;
    },
  ): Promise<void>;
  /**
   * The reactions on these messages, without people `viewerAccountId` has blocked, ordered by the reactor's
   * display name and then person ID. Never by when they reacted: no order of reacting is carried (D-147).
   */
  reactionsOf(
    reader: ConversationReader,
    conversationId: string,
    sequences: readonly number[],
    viewerAccountId: string,
  ): Promise<readonly ReactionRow[]>;
  /** The originals that these message sequences are replies to. */
  quotesOf(
    reader: ConversationReader,
    conversationId: string,
    sequences: readonly number[],
  ): Promise<readonly QuoteRow[]>;
  /**
   * The challenge a message of this conversation is, when it is one that still stands: the call it asks about. Never a
   * tombstone and never a plain card.
   */
  challengeOf(
    reader: ConversationReader,
    conversationId: string,
    messageId: string,
  ): Promise<(ChallengeCall & { readonly sequence: number }) | undefined>;
  /** The picks of these calls in this conversation (at most the two people's). */
  picksOf(
    reader: ConversationReader,
    conversationId: string,
    calls: readonly ChallengeCall[],
  ): Promise<readonly ChallengePickStored[]>;
  /** Stores the account's first pick of a call. A call the account already locked is left as it was. */
  insertPick(
    lock: SharedLock,
    conversationId: string,
    accountId: string,
    call: ChallengeCall,
    option: number,
    day: string,
  ): Promise<void>;
  /** Gives the message the conversation's next change number, so catch-up carries its new state to both people. */
  touchMessage(lock: SharedLock, conversationId: string, sequence: number): Promise<void>;
  messageOfCommand(
    reader: ConversationReader,
    conversationId: string,
    authorAccountId: string,
    commandId: string,
  ): Promise<MessageRow | undefined>;
  /**
   * Moves the member's own read position. With `alsoShared`, the shared position (SEEN) moves to the same number in
   * the same statement; the caller passes it only while the reader's own switch is on.
   */
  setReadThrough(
    reader: ConversationReader,
    conversationId: string,
    accountId: string,
    sequence: number,
    alsoShared?: boolean,
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
  /** The question, options, answer and reveal words of a Scroll revision (content's public read). */
  readCallFacts: ReadScrollPlayFacts;
  /** A pick is a play result, so it is stored only while recording is on (D-083). */
  fenceRecording: FencePersonalRecording;
  /** A new share-link token (`kssh_` plus 43 random characters). */
  shareToken(): string;
}
