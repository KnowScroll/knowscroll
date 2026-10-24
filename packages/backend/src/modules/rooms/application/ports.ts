import type { ConversationContentProjectionSchema, PublicPersonRef } from '@knowscroll/contracts';
import type { z } from 'zod';
import type {
  ReadContentSequence,
  ResolveSnippetAnchor,
  StoredSnippetAnchor,
  ValidateSnippetAnchor,
} from '../../content/public.js';
import type { ReadVisitedAssets } from '../../experience/public.js';
import type { ReadGeographySceneInput } from '../../geography/public.js';
import type { FenceOwnAccount, PersonalScopeTx, SharedScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ActivityKind, ActivityState, StoredDefinition } from '../domain/activities.js';
import type { ContributionKind, InhabitantId } from '../domain/contribution.js';
import type { EarlierPlace, JoinRule, RoomRole, RoomStatus } from '../domain/membership.js';

export type RoomRefusal = 'invalid_input' | 'unavailable' | 'command_key_reused' | 'rate_limited';
export type Result<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'refused'; readonly code: RoomRefusal };
export const refuse = (code: RoomRefusal): Result<never> => ({ kind: 'refused', code });
export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });

export type ContentCard = z.infer<typeof ConversationContentProjectionSchema>;
export interface ContentRef {
  readonly assetId: string;
  readonly assetRevision: number;
}

/** The envelope every room answer names: the caller's account and epoch. */
export const roomEnvelope = (scope: PersonalScopeTx) => {
  if (scope.authority.actor.kind !== 'account') throw new Error('ROOMS_ACCOUNT_REQUIRED');
  return {
    version: 'rooms.v1' as const,
    scope: { accountId: scope.authority.actor.accountId, privacyEpoch: scope.authority.privacyEpoch },
  };
};

// --- Rooms and members --------------------------------------------------------------------

export interface RoomRow {
  readonly roomId: string;
  readonly name: string;
  readonly description: string;
  readonly guidelines: string | null;
  readonly topic: { readonly kind: 'system' | 'planet'; readonly id: string };
  readonly joinRule: JoinRule;
  readonly status: RoomStatus;
  readonly inhabitants: readonly InhabitantId[];
}

export interface MemberRow {
  readonly accountId: string;
  readonly role: RoomRole;
  readonly endedBy: 'left' | 'removed' | null;
}

/** A locked room root: the room row, held after the actor's personal root and own account gate. */
export interface RoomLock {
  readonly shared: SharedScopeTx;
  readonly roomId: string;
}

/** Where a caller stands in a room, read under its lock. */
export interface Standing {
  readonly room: RoomRow;
  /** The caller's member row, open or ended; none if they never joined. */
  readonly own: MemberRow | undefined;
  /** A current member invited the caller. */
  readonly invited: boolean;
  /** At least one current member is a moderator. */
  readonly hasModerator: boolean;
}

export interface RoomListRow {
  readonly room: RoomRow;
  readonly standing: 'member' | 'moderator' | 'invited';
}

/** A room on the caller's map: where the caller stands in it (`none` for an outsider). */
export interface RoomStationRow {
  readonly room: RoomRow;
  readonly standing: 'member' | 'moderator' | 'invited' | 'none';
}

export interface ReceiptKey {
  readonly commandId: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly outcomeVersion: number;
}
export type ReceiptLookup =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly outcome: unknown }
  | { readonly kind: 'refused'; readonly code: RoomRefusal };

/**
 * Room rows. Each method is one explicit query or write; none decides access. Writes and locked
 * reads take a `RoomLock`, obtained by the use case after the caller's gates.
 */
export interface RoomStore {
  /** Takes the room's root lock: FOR UPDATE for commands that change who is in, the status or roles, FOR SHARE otherwise. */
  lock(scope: PersonalScopeTx, roomId: string, mode: 'read' | 'write'): Promise<RoomLock | undefined>;
  standing(lock: RoomLock, accountId: string): Promise<Standing>;
  /** Whether any of these accounts is a current member. */
  anyMember(lock: RoomLock, accountIds: readonly string[]): Promise<boolean>;
  memberOf(lock: RoomLock, accountId: string): Promise<MemberRow | undefined>;
  /** The caller's open rooms and open invitations, newest first. */
  listFor(scope: PersonalScopeTx, accountId: string): Promise<readonly RoomListRow[]>;
  /**
   * The rooms of these topics that are not closed, with the caller's standing in each, ordered by name.
   * An unlocked read of rows that change rarely; it shows no member, count or activity.
   */
  forTopics(
    scope: PersonalScopeTx,
    accountId: string,
    topics: readonly { readonly kind: 'system' | 'planet'; readonly id: string }[],
  ): Promise<readonly RoomStationRow[]>;
  join(lock: RoomLock, accountId: string, now: Date): Promise<RoomRole>;
  end(lock: RoomLock, accountId: string, by: 'left' | 'removed', now: Date): Promise<void>;
  invite(lock: RoomLock, input: { inviteeAccountId: string; inviterAccountId: string; now: Date }): Promise<void>;
  setStatus(lock: RoomLock, status: RoomStatus): Promise<void>;
  findReceipt(lock: RoomLock, key: ReceiptKey): Promise<ReceiptLookup>;
  beginReceipt(lock: RoomLock, key: ReceiptKey): Promise<void>;
  completeReceipt(lock: RoomLock, key: ReceiptKey, outcome: object): Promise<void>;
}

/** Earlier place of a caller, for the join rule. */
export const earlierPlaceOf = (own: MemberRow | undefined): EarlierPlace =>
  own === undefined || own.endedBy === null ? 'never' : own.endedBy;

// --- Discussions and messages -------------------------------------------------------------

export interface DiscussionRow {
  readonly discussionId: string;
  readonly roomId: string;
  readonly title: string;
  readonly root: ContentRef | null;
  readonly originMessageId: string | null;
  /** Null once the starter's account was deleted. */
  readonly startedByAccountId: string | null;
  readonly pinned: boolean;
  readonly lastSequence: number;
  readonly lastChangeSequence: number;
  readonly lastActivityAt: Date;
}

export interface NewDiscussion {
  readonly discussionId: string;
  readonly title: string;
  readonly root: ContentRef | undefined;
  readonly originMessageId: string | undefined;
  readonly startedByAccountId: string;
  readonly now: Date;
}

/** A stored message: a person's text or card, an AI inhabitant's contribution, or a tombstone. */
export interface MessageRow {
  readonly sequence: number;
  readonly changeSequence: number;
  readonly messageId: string;
  readonly commandId: string | null;
  readonly recordedAt: Date;
  /** A moderator removed it; the row keeps its place and number. */
  readonly hidden: boolean;
  /** The author's account, null for an AI inhabitant and for a tombstone. */
  readonly authorAccountId: string | null;
  readonly inhabitant: InhabitantId | null;
  readonly aiKind: ContributionKind | null;
  readonly text: string | null;
  readonly content: ContentRef | null;
  readonly note: string | null;
}

export type NewMessage =
  | {
      readonly kind: 'person';
      readonly messageId: string;
      readonly commandId: string;
      readonly authorAccountId: string;
      readonly recordedAt: Date;
      readonly text?: string;
      readonly content?: ContentRef;
      readonly note?: string;
    }
  | {
      readonly kind: 'ai';
      readonly messageId: string;
      readonly inhabitant: InhabitantId;
      readonly aiKind: ContributionKind;
      readonly text: string;
      readonly recordedAt: Date;
    };

export interface Counters {
  readonly sequence: number;
  readonly changeSequence: number;
}

/**
 * Discussion rows. Every method is one explicit query or write, inside the room's lock; none
 * decides access. Counters are atomic increments on the discussion row, so sends in one discussion
 * are gapless without a second lock.
 */
export interface DiscussionStore {
  exists(lock: RoomLock, discussionId: string): Promise<boolean>;
  load(lock: RoomLock, discussionId: string): Promise<DiscussionRow | undefined>;
  /** The room's discussions, pinned first and then newest activity. */
  list(lock: RoomLock, limit: number): Promise<readonly DiscussionRow[]>;
  /** The pinned discussion with the newest pin, if any. */
  pinnedTitle(lock: RoomLock): Promise<string | undefined>;
  create(lock: RoomLock, discussion: NewDiscussion): Promise<void>;
  setPinned(lock: RoomLock, discussionId: string, pinnedAt: Date | null): Promise<void>;
  append(lock: RoomLock, discussionId: string, message: NewMessage): Promise<Counters>;
  messages(
    lock: RoomLock,
    discussionId: string,
    query: { readonly before?: number; readonly after?: number; readonly limit: number },
  ): Promise<readonly MessageRow[]>;
  messageById(lock: RoomLock, discussionId: string, messageId: string): Promise<MessageRow | undefined>;
  /** A message of this room, in any discussion, by its ID (for starting a discussion from a card). */
  messageInRoom(
    lock: RoomLock,
    messageId: string,
  ): Promise<{ readonly discussionId: string; readonly message: MessageRow } | undefined>;
  /** Hides or restores a message and gives it a fresh change number, so catch-up replaces the bubble. */
  setHidden(lock: RoomLock, discussionId: string, messageId: string, hiddenAt: Date | null): Promise<void>;
  saveSnippet(lock: RoomLock, messageId: string, anchor: StoredSnippetAnchor): Promise<void>;
  snippetsOf(lock: RoomLock, messageIds: readonly string[]): Promise<ReadonlyMap<string, StoredSnippetAnchor>>;
  snippetOfMessage(
    lock: RoomLock,
    discussionId: string,
    messageId: string,
  ): Promise<{ readonly target: ContentRef; readonly anchor: StoredSnippetAnchor } | undefined>;
}

// --- AI inhabitants -----------------------------------------------------------------------

export interface AiRequestRow {
  readonly requestId: string;
  readonly roomId: string;
  readonly discussionId: string;
  readonly inhabitant: InhabitantId;
  readonly requestedByAccountId: string | null;
  readonly state: 'queued' | 'completed' | 'declined' | 'failed';
  readonly createdAt: Date;
}

export interface AiProvenance {
  readonly roleVersion: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly attemptId: string | undefined;
}

/**
 * The AI inhabitants' requests: the rate-bound ledger and the provenance of every contribution.
 * An inhabitant cannot write a message without a request row that a member created.
 */
export interface AiStore {
  /** Asks counted against the bound since `since` (queued or answered, never failed), in the room and by the person. */
  countAsks(
    lock: RoomLock,
    query: { readonly accountId: string; readonly since: Date },
  ): Promise<{ readonly room: number; readonly person: number }>;
  /** Requests of this discussion still queued and not lapsed at `now`, by inhabitant. */
  openAsks(lock: RoomLock, discussionId: string, now: Date): Promise<readonly InhabitantId[]>;
  /** The caller's newest ask of this discussion that ended without a contribution since `since`. */
  lastUnansweredAsk(
    lock: RoomLock,
    discussionId: string,
    accountId: string,
    since: Date,
  ): Promise<{ readonly inhabitant: InhabitantId; readonly state: 'declined' | 'failed' } | undefined>;
  insert(lock: RoomLock, request: AiRequestRow & { readonly commandId: string }): Promise<void>;
  /** The request by ID inside the room's lock, for the worker's apply step. */
  read(lock: RoomLock, requestId: string): Promise<AiRequestRow | undefined>;
  settle(
    lock: RoomLock,
    requestId: string,
    outcome:
      | { readonly state: 'declined' | 'failed'; readonly at: Date }
      | {
          readonly state: 'completed';
          readonly at: Date;
          readonly messageId: string;
          readonly provenance: AiProvenance;
        },
  ): Promise<void>;
  /**
   * The request a job names, found without a room lock from the job's own universe, with the asker
   * only if that universe belongs to them. The worker uses it to learn which room to lock.
   */
  forJob(scope: PersonalScopeTx, requestId: string): Promise<AiRequestRow | undefined>;
}

// --- Optional room activity (R03) ---------------------------------------------------------

export interface ActivityRow {
  readonly activityId: string;
  readonly roomId: string;
  readonly kind: ActivityKind;
  readonly title: string;
  /** The stored definition as written; the use case checks its shape before serving it. */
  readonly definition: StoredDefinition;
  readonly state: ActivityState;
  readonly createdAt: Date;
}

export interface NewActivityRow {
  readonly activityId: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly definition: StoredDefinition;
  readonly createdByAccountId: string;
  readonly now: Date;
}

/** One option's votes: the exact count and the first voters, by account. */
export interface OptionTally {
  readonly optionId: string;
  readonly votes: number;
  readonly voterAccountIds: readonly string[];
}

/**
 * Polls and quizzes of a room. Every method is one explicit query or write inside the room's lock; none
 * decides access. A quiz stores nothing about anyone who reads it.
 */
export interface ActivityStore {
  /** Activities in any state but `removed`, open first and then newest first, with whether the caller voted. */
  list(
    lock: RoomLock,
    accountId: string,
    limit: number,
  ): Promise<readonly { readonly row: ActivityRow; readonly voted: boolean }[]>;
  /** One activity by ID in this room, in any state (a removed one is still found so a moderator's retry is exact). */
  load(lock: RoomLock, activityId: string, rowLock: 'none' | 'share' | 'update'): Promise<ActivityRow | undefined>;
  create(lock: RoomLock, activity: NewActivityRow): Promise<void>;
  setState(lock: RoomLock, activityId: string, state: 'closed' | 'removed', now: Date): Promise<void>;
  /** Activities of this room that are open now. */
  openCount(lock: RoomLock): Promise<number>;
  /** Activities started in this room since `since`, in any state. */
  startedSince(lock: RoomLock, since: Date): Promise<number>;
  /** Records or replaces the person's vote. */
  vote(lock: RoomLock, activityId: string, accountId: string, optionId: string, now: Date): Promise<void>;
  yourVote(lock: RoomLock, activityId: string, accountId: string): Promise<string | undefined>;
  tally(lock: RoomLock, activityId: string, votersPerOption: number): Promise<readonly OptionTally[]>;
}

// --- What the application needs from outside ----------------------------------------------

/** A person the caller can name: a public profile, by account. */
export interface PersonLookup {
  byAccounts(scope: PersonalScopeTx, accountIds: readonly string[]): Promise<ReadonlyMap<string, PublicPersonRef>>;
  /** The account behind a public person ID, for moderators naming whom to remove. */
  accountOf(scope: PersonalScopeTx, personId: string): Promise<string | undefined>;
  /** Whether the account has a claimed sharing profile. */
  hasProfile(scope: PersonalScopeTx, accountId: string): Promise<boolean>;
}

export interface FriendLookup {
  /** The caller's current friends' account IDs, at most `limit`. */
  accounts(scope: PersonalScopeTx, accountId: string, limit: number): Promise<readonly string[]>;
  /** The friend with this public person ID, if the caller and that person are current friends. */
  byPerson(scope: PersonalScopeTx, accountId: string, personId: string): Promise<string | undefined>;
}

export type ReadContent = (scope: PersonalScopeTx, refs: readonly ContentRef[]) => Promise<readonly ContentCard[]>;

/** Everything the room use cases need. Built once by the composition root; nothing here is global. */
export interface RoomPorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly rooms: RoomStore;
  readonly discussions: DiscussionStore;
  readonly ai: AiStore;
  readonly activities: ActivityStore;
  readonly people: PersonLookup;
  readonly friends: FriendLookup;
  readonly readContent: ReadContent;
  readonly readSequence: ReadContentSequence;
  readonly readVisited: ReadVisitedAssets;
  readonly validateSnippet: ValidateSnippetAnchor;
  readonly resolveSnippet: ResolveSnippetAnchor;
  /** The caller's own map, to place stations beside the systems it holds. */
  readonly readGeography: ReadGeographySceneInput;
  newId(): string;
  hash(operation: string, input: unknown): string;
  now(): Date;
  /** Queues the contribution job in the caller's open transaction. */
  enqueueContribution(scope: PersonalScopeTx, requestId: string): Promise<void>;
}
