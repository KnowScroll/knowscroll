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
import type { AskKind } from '../domain/asks.js';
import type { CastMember } from '../domain/cast.js';
import type { ContributionKind, InhabitantId } from '../domain/contribution.js';
import type { AiLevel, EarlierPlace, JoinRule, RoomRole, RoomStatus } from '../domain/membership.js';
import type { CapCounts, RefusalCap } from '../domain/router.js';
import type { SpeechTrigger } from '../domain/triggers.js';
import type { CastDueJob, CastPassJob, SummariseJob } from '../events.js';

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
  /** The residents that live here, in the order they are shown (D-163). */
  readonly cast: readonly CastMember[];
  /** The kit and backdrop an operator approved, as stored; none until one is (D-170). Checked when shown. */
  readonly face: { readonly kit: unknown; readonly backdropSha256: string | null };
}

/** Whether the room has this resident. */
export const hasResident = (room: RoomRow, inhabitant: InhabitantId): boolean =>
  room.cast.some((member) => member.inhabitant === inhabitant);

export interface MemberRow {
  readonly accountId: string;
  readonly role: RoomRole;
  readonly endedBy: 'left' | 'removed' | null;
  /** How much the room's AI inhabitants may speak to this member. */
  readonly aiLevel: AiLevel;
  /** Their messages are replaced by a placeholder before any model reads the room. */
  readonly keepOut: boolean;
  /** When they acknowledged the AI notice; null until they do. */
  readonly noticeSeenAt: Date | null;
}

/** A member's own settings in a room; each is changed on its own. */
export interface MemberPreferences {
  readonly aiLevel?: AiLevel;
  readonly keepOut?: boolean;
  /** Acknowledges the AI notice; the first acknowledgement is kept. */
  readonly noticeSeen?: true;
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
  /** The locked room's own row, for work that has no caller (a resident's check). */
  roomRow(lock: RoomLock): Promise<RoomRow>;
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
  /** Joins (or rejoins) as an ordinary member. A new member starts at `aiLevel`; a person who comes back keeps their own settings. */
  join(lock: RoomLock, accountId: string, aiLevel: AiLevel, now: Date): Promise<RoomRole>;
  end(lock: RoomLock, accountId: string, by: 'left' | 'removed', now: Date): Promise<void>;
  /** How many current members the room has. */
  memberTotal(lock: RoomLock): Promise<number>;
  /** Changes the member's own settings and returns the row as it stands. */
  setPreferences(lock: RoomLock, accountId: string, patch: MemberPreferences, now: Date): Promise<MemberRow>;
  /** Which of these accounts keep their messages out of what AI reads, whether or not they are still members. */
  keepOutAmong(lock: RoomLock, accountIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Queues a room hint in this transaction: something changed that members of the room should read again. Disposable. */
  announce(lock: RoomLock, now: Date): Promise<void>;
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
  /** `general` is the room's own place to talk (one per room); `topic` is any other. */
  readonly kind: 'general' | 'topic' | 'today';
  readonly title: string;
  /**
   * The title is the first words of the message the topic began from, not what the starter typed. It is then another
   * person's words, shown only while that message is (`shownTitle`).
   */
  readonly titleDerived: boolean;
  /** A label the starter picked from a closed list; none for General and for a topic started without one. */
  readonly tag: TopicTag | null;
  readonly root: ContentRef | null;
  readonly originMessageId: string | null;
  /** Null once the starter's account was deleted. */
  readonly startedByAccountId: string | null;
  readonly pinned: boolean;
  readonly lastSequence: number;
  readonly lastChangeSequence: number;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
}

export type TopicTag = 'question' | 'debate' | 'explainer' | 'share';

export interface NewDiscussion {
  readonly discussionId: string;
  readonly title: string;
  readonly titleDerived: boolean;
  readonly tag: TopicTag | undefined;
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
  /** Why a resident spoke on its own; none for a person's message and for an asked contribution. */
  readonly trigger: SpeechTrigger | null;
  /** The topic a card names; set only on the card a topic started from a message leaves (D-167). */
  readonly topicDiscussionId: string | null;
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
      /** A topic card: the discussion started from a message of this one. It has no words of its own. */
      readonly topicDiscussionId?: string;
    }
  | {
      readonly kind: 'ai';
      readonly messageId: string;
      readonly inhabitant: InhabitantId;
      readonly aiKind: ContributionKind;
      readonly text: string;
      readonly recordedAt: Date;
      /** Why the resident spoke on its own; absent for an asked contribution. */
      readonly trigger?: SpeechTrigger;
    };

export interface Counters {
  readonly sequence: number;
  readonly changeSequence: number;
}

/** What a list row or a topic card says about a discussion: how much is in it, who spoke last, and what people found useful. */
export interface DiscussionFigures {
  /** Shown messages: not removed, not a deleted account's. */
  readonly replyCount: number;
  /** Marks of Useful on its messages. */
  readonly usefulCount: number;
  /** Someone other than its starter, or a resident, has written in it. */
  readonly answered: boolean;
  /** Who wrote the newest shown message: a person's account, or a resident's role. */
  readonly lastReplyBy: { readonly accountId: string } | { readonly inhabitant: InhabitantId } | undefined;
}

/** A shown message of the room's recent window, and the kind of discussion it sits in (never that discussion's title). */
export interface WindowMessage {
  readonly message: MessageRow;
  readonly discussionKind: 'general' | 'topic' | 'today';
}

/**
 * Discussion rows. Every method is one explicit query or write, inside the room's lock; none
 * decides access. Counters are atomic increments on the discussion row, so sends in one discussion
 * are gapless without a second lock.
 */
export interface DiscussionStore {
  exists(lock: RoomLock, discussionId: string): Promise<boolean>;
  load(lock: RoomLock, discussionId: string): Promise<DiscussionRow | undefined>;
  /** The room's discussions other than General, pinned first and then newest activity. */
  list(lock: RoomLock, limit: number): Promise<readonly DiscussionRow[]>;
  /** The room's topics (not General, not Today), with one tag when asked, the most recently active first, at most `limit`. */
  listTopics(
    lock: RoomLock,
    query: { readonly tag?: TopicTag; readonly limit: number },
  ): Promise<readonly DiscussionRow[]>;
  /** The figures a list or a topic card shows for these discussions. A discussion with no messages has zero of each. */
  figures(lock: RoomLock, discussionIds: readonly string[]): Promise<ReadonlyMap<string, DiscussionFigures>>;
  /**
   * The newest shown messages of the whole room recorded after `after` and no later than `through` (at most `limit`),
   * oldest first, each with the discussion it is in. A removed message and a deleted account's are not among them.
   */
  windowMessages(
    lock: RoomLock,
    query: { readonly after: Date; readonly through: Date; readonly limit: number },
  ): Promise<readonly WindowMessage[]>;
  /** How many shown messages recorded after `since` were written by someone other than this account (up to `limit`). */
  newMessagesFor(lock: RoomLock, accountId: string, since: Date, limit: number): Promise<number>;
  /** Marks a message Useful for this member, or takes the mark back. One mark per member per message. */
  setUseful(lock: RoomLock, messageId: string, accountId: string, marked: boolean, now: Date): Promise<void>;
  /** Which of these messages this member has marked Useful. */
  usefulAmong(lock: RoomLock, accountId: string, messageIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** The room's General discussion; every room has one. */
  general(lock: RoomLock): Promise<DiscussionRow | undefined>;
  /** When the newest message a member can see was sent, anywhere in the room; none while nobody has written. */
  lastMessageAt(lock: RoomLock): Promise<Date | undefined>;
  /** The pinned discussion with the newest pin, if any. */
  pinned(lock: RoomLock): Promise<DiscussionRow | undefined>;
  /**
   * For topics whose title is made from a message: whether that message is shown (not removed, its author's account not
   * deleted) and who wrote it. A discussion without such an origin is absent.
   */
  originsOf(
    lock: RoomLock,
    discussionIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly shown: boolean; readonly authorAccountId: string | null }>>;
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
  /** Where messages of this room sit: their discussion, its title and their number. Messages that are gone are absent. */
  locate(
    lock: RoomLock,
    messageIds: readonly string[],
  ): Promise<
    ReadonlyMap<
      string,
      {
        readonly discussionId: string;
        readonly discussionTitle: string;
        readonly titleDerived: boolean;
        readonly sequence: number;
      }
    >
  >;
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

// --- Presence -----------------------------------------------------------------------------

/**
 * Who has the room open: one lease row per member, renewed by their own device and read only while fresh.
 * Written only by the member's own presence command, never derived from messages or from another module.
 */
export interface PresenceStore {
  /** Renews the member's lease; `began` when they had none that was still fresh at `now`. */
  renew(lock: RoomLock, accountId: string, now: Date, leaseMs: number): Promise<'began' | 'renewed'>;
  /** Ends the member's lease; whether they had one. */
  clear(lock: RoomLock, accountId: string): Promise<boolean>;
  /** Members whose lease is newer than `since`, most recently renewed first, at most `limit`. */
  fresh(lock: RoomLock, since: Date, limit: number): Promise<readonly string[]>;
}

// --- AI turns -----------------------------------------------------------------------------

/** What set an AI turn going: a member's ask, or the reason a resident spoke on its own. */
export type TurnTrigger = 'asked' | SpeechTrigger;

export type TurnState = 'queued' | 'completed' | 'declined' | 'failed' | 'refused';

/** An answer the model already gave and the room paid for, kept on its turn while posting is put off for someone typing. */
export interface HeldAnswer {
  readonly kind: ContributionKind;
  readonly text: string;
  readonly attemptId: string;
}

export interface AiTurnRow {
  readonly turnId: string;
  readonly roomId: string;
  readonly discussionId: string;
  readonly inhabitant: InhabitantId;
  /** The member who asked; none for an unprompted turn, and none once the asker's account is deleted. */
  readonly requestedByAccountId: string | null;
  readonly state: TurnState;
  readonly createdAt: Date;
  readonly trigger: TurnTrigger;
  /** What a member asked (`ask`, `challenge`, `other_side`, `about` or `mention`); none for an unprompted turn. */
  readonly askKind: AskKind | null;
  /** The message an unprompted turn answers, or the one a pointed ask or a mention is about; none for a plain ask. */
  readonly causeMessageId: string | null;
  /** The answer held back while someone types; none otherwise. */
  readonly held: HeldAnswer | null;
}

/** The ask an AI message answers. `byAccountId` is none once the asker's account was deleted. */
export interface AskedFor {
  readonly kind: AskKind;
  readonly byAccountId: string | null;
  readonly aboutMessageId: string | null;
}

export interface AiProvenance {
  readonly roleVersion: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly attemptId: string | undefined;
}

/** The result of settling a queued turn. */
export type TurnOutcome =
  | { readonly state: 'declined' | 'failed'; readonly at: Date; readonly dispatched: boolean }
  | {
      readonly state: 'completed';
      readonly at: Date;
      readonly messageId: string;
      readonly provenance: AiProvenance;
    };

/** An unprompted turn the router decided: allowed (queued for the worker) or refused (settled at once, posts nothing). */
export interface NewDecision {
  readonly turnId: string;
  readonly discussionId: string;
  readonly inhabitant: InhabitantId;
  readonly trigger: SpeechTrigger;
  readonly causeMessageId: string;
  readonly decision: { readonly kind: 'allowed' } | { readonly kind: 'refused'; readonly cap: RefusalCap };
  readonly counts: CapCounts;
  readonly now: Date;
}

/**
 * The room's AI turns, asked or unprompted: the rate-bound ledger and the provenance of every AI message. An AI
 * message cannot exist without a row here that names what set it going (D-068, D-164).
 */
export interface AiStore {
  /**
   * Asks counted against the bounds: the room's over the UTC day and the person's over the last hour.
   * Queued, answered and declined asks count, and failed ones that reached the provider (`dispatched`); only an
   * ask that never reached the provider is not counted. `personRequests` is every ask of the person, whatever
   * became of it.
   */
  countAsks(
    lock: RoomLock,
    query: { readonly accountId: string; readonly dayStart: Date; readonly hourStart: Date },
  ): Promise<{ readonly room: number; readonly person: number; readonly personRequests: number }>;
  /**
   * Asks of this discussion still queued and not lapsed at `now`, by inhabitant. A resident preparing an unprompted answer
   * is not one: it never stops a member from asking.
   */
  openAsks(lock: RoomLock, discussionId: string, now: Date): Promise<readonly InhabitantId[]>;
  /** The caller's newest ask of this discussion that ended without a contribution since `since`. */
  lastUnansweredAsk(
    lock: RoomLock,
    discussionId: string,
    accountId: string,
    since: Date,
  ): Promise<{ readonly inhabitant: InhabitantId; readonly state: 'declined' | 'failed' } | undefined>;
  /** Writes a member's ask as a queued turn. */
  insertAsk(lock: RoomLock, ask: AiTurnRow & { readonly commandId: string }): Promise<void>;
  /** For these AI messages, what the member asked that they answer: the kind, who asked and which message it was about. */
  askedFor(lock: RoomLock, messageIds: readonly string[]): Promise<ReadonlyMap<string, AskedFor>>;
  /** The turn by ID inside the room's lock, for the worker's apply step. */
  read(lock: RoomLock, turnId: string): Promise<AiTurnRow | undefined>;
  /**
   * Settles a queued turn and clears any held answer. A turn that reached the provider stays counted: settling never
   * lowers `dispatched`, so a later "nothing was sent" cannot take back a call that was paid for.
   */
  settle(lock: RoomLock, turnId: string, outcome: TurnOutcome): Promise<void>;
  /**
   * Keeps the answer the model gave while posting is put off. The turn is marked as having reached the provider in the same
   * statement, so it counts against the caps whatever becomes of the words.
   */
  hold(lock: RoomLock, turnId: string, held: HeldAnswer): Promise<void>;
  /**
   * The ask a job names, found without a room lock from the job's own universe, with the asker only if that
   * universe belongs to them. The worker uses it to learn which room to lock.
   */
  forJob(scope: PersonalScopeTx, turnId: string): Promise<AiTurnRow | undefined>;
  /** Whether a turn, allowed or refused, already exists for this message and trigger. */
  decidedFor(lock: RoomLock, causeMessageId: string, trigger: SpeechTrigger): Promise<boolean>;
  /** The counts the unprompted caps compare at `now`, for the resident that would speak and the message's author. */
  capCounts(
    lock: RoomLock,
    query: { readonly now: Date; readonly inhabitant: InhabitantId; readonly authorAccountId: string | null },
  ): Promise<CapCounts>;
  /** Writes the router's decision as a turn row, in the same transaction as what follows from it. */
  insertDecision(lock: RoomLock, decision: NewDecision): Promise<void>;
}

/** What the router reads about a room that no other store holds. */
export interface CastStore {
  /** Current members whose AI level is not Off. */
  listeners(lock: RoomLock): Promise<number>;
  /** Person messages after `sequence` in a discussion by anyone but the author, and AI messages after it. */
  activityAfter(
    lock: RoomLock,
    discussionId: string,
    sequence: number,
    authorAccountId: string | null,
  ): Promise<{ readonly byOthers: number; readonly byAi: number }>;
  /** How many messages (of any kind but a tombstone) the account has written in the room. */
  messagesBy(lock: RoomLock, accountId: string): Promise<number>;
  /** Until when someone is typing in the discussion, if anyone is (D-165). Never says who. */
  typingUntil(lock: RoomLock, discussionId: string, now: Date): Promise<Date | undefined>;
}

// --- Where a member left off, and the summary of a window ---------------------------------

/** A member's own place in a room: the last time their device had it open, and the away mark of a long return. */
export interface ReadPosition {
  readonly hereUntil: Date;
  /** When they left, set when they came back after a long absence to enough new messages; none otherwise. */
  readonly awaySince: Date | undefined;
  /** The window of the summary written for that return. */
  readonly awayWindow: number | undefined;
}

/**
 * Where members left off (migration 0076): one private row per member per room, written only by the member's own
 * presence command. It is never read for anyone else, never sent, and carries no content.
 */
export interface PositionStore {
  /** Notes that the member's device has the room open at `now` and returns the row as it stood before. */
  touch(lock: RoomLock, accountId: string, now: Date): Promise<ReadPosition | undefined>;
  read(lock: RoomLock, accountId: string): Promise<ReadPosition | undefined>;
  /** Records a long return: when they left and the window of the summary written for it. */
  markAway(lock: RoomLock, accountId: string, away: { readonly since: Date; readonly window: number }): Promise<void>;
  /** The member has read it. */
  dismissAway(lock: RoomLock, accountId: string): Promise<void>;
  /** Their row goes when they leave or are removed. */
  forget(lock: RoomLock, accountId: string): Promise<void>;
}

export type SummaryState = 'queued' | 'ready' | 'declined' | 'failed' | 'stale';

/** One window's summary: a resident's words about what the room said, cached for everyone who returns in the window. */
export interface SummaryRow {
  readonly summaryId: string;
  readonly roomId: string;
  readonly windowNo: number;
  readonly state: SummaryState;
  readonly coversFrom: Date;
  readonly coversThrough: Date;
  /** The words; only while the summary is `ready`. */
  readonly body: string | null;
  readonly createdAt: Date;
}

export interface NewSummary {
  readonly summaryId: string;
  readonly windowNo: number;
  readonly coversFrom: Date;
  readonly coversThrough: Date;
  readonly now: Date;
}

/** How a queued summary ended. A summary that reached the provider stays dispatched whatever happens next. */
export type SummaryOutcome =
  | { readonly state: 'failed'; readonly at: Date; readonly dispatched: boolean }
  | { readonly state: 'declined'; readonly at: Date; readonly provenance: AiProvenance }
  | { readonly state: 'ready'; readonly at: Date; readonly body: string; readonly provenance: AiProvenance };

/**
 * The summaries of a room's windows (migration 0076). The unique key (room, window) is the cap: a window is claimed
 * once however many members return in it. A summary is the ledger of its own call.
 */
export interface SummaryStore {
  /** Claims the window with a queued summary, or answers the one that already holds it. */
  claim(lock: RoomLock, summary: NewSummary): Promise<{ readonly claimed: boolean; readonly summary: SummaryRow }>;
  read(lock: RoomLock, summaryId: string): Promise<SummaryRow | undefined>;
  forWindow(lock: RoomLock, windowNo: number): Promise<SummaryRow | undefined>;
  /** Settles a queued summary. A summary that reached the provider keeps `dispatched` whatever a later step believes. */
  settle(lock: RoomLock, summaryId: string, outcome: SummaryOutcome): Promise<void>;
  /**
   * Erases the words of every ready summary that covered what was just removed: a message recorded at `coveringAt` (a
   * moderator removed it), or any message `byAccount` wrote (they keep their messages out of what AI reads now). The window
   * is not written again.
   */
  markStale(lock: RoomLock, cause: { readonly coveringAt: Date } | { readonly byAccount: string }): Promise<void>;
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

/** Which of these accounts the caller has blocked (their words are collapsed for the caller only). */
export type BlockedLookup = (
  scope: PersonalScopeTx,
  accountId: string,
  candidates: readonly string[],
) => Promise<ReadonlySet<string>>;

export interface FriendLookup {
  /** The caller's current friends' account IDs, at most `limit`. */
  accounts(scope: PersonalScopeTx, accountId: string, limit: number): Promise<readonly string[]>;
  /** The friend with this public person ID, if the caller and that person are current friends. */
  byPerson(scope: PersonalScopeTx, accountId: string, personId: string): Promise<string | undefined>;
}

export type ReadContent = (scope: PersonalScopeTx, refs: readonly ContentRef[]) => Promise<readonly ContentCard[]>;

/** Everything the room use cases need. Built once by the composition root; nothing here is global. */
/** One message of a room that people have reported, as its moderators may see it: why, how many times and when. */
export interface RoomReportRow {
  readonly messageId: string;
  readonly categories: readonly string[];
  /** How many different people reported it. */
  readonly count: number;
  readonly lastReportedAt: Date;
}

/**
 * Port: the reports on messages of one room, newest first (D-055). It leaves out every report about the
 * asking account's own words and never carries who reported, a note or the author. Who may ask is the
 * Rooms module's check. Feedback implements it.
 */
export type ReadRoomReports = (
  scope: PersonalScopeTx,
  query: { readonly roomId: string; readonly excludingAccountId: string; readonly limit: number },
) => Promise<readonly RoomReportRow[]>;

export interface RoomPorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly rooms: RoomStore;
  readonly discussions: DiscussionStore;
  readonly presence: PresenceStore;
  readonly ai: AiStore;
  readonly cast: CastStore;
  readonly positions: PositionStore;
  readonly summaries: SummaryStore;
  readonly activities: ActivityStore;
  readonly people: PersonLookup;
  readonly friends: FriendLookup;
  readonly blocked: BlockedLookup;
  readonly readContent: ReadContent;
  readonly readSequence: ReadContentSequence;
  readonly readVisited: ReadVisitedAssets;
  /** Reports on the room's messages, for its moderators (D-055). */
  readonly readReports: ReadRoomReports;
  readonly validateSnippet: ValidateSnippetAnchor;
  readonly resolveSnippet: ResolveSnippetAnchor;
  /** The caller's own map, to place stations beside the systems it holds. */
  readonly readGeography: ReadGeographySceneInput;
  newId(): string;
  hash(operation: string, input: unknown): string;
  now(): Date;
  /** Queues the contribution job in the caller's open transaction. */
  enqueueContribution(scope: PersonalScopeTx, turnId: string): Promise<void>;
  /**
   * Whether residents may speak unprompted in this world (D-162). Off, a message schedules nothing, so a world that
   * leaves residents off queues no job.
   */
  readonly residentsEnabled: boolean;
  /** Queues the check that decides whether a resident answers a message, to run at `startAfter`. */
  enqueueCastDue(scope: PersonalScopeTx, job: CastDueJob, startAfter: Date): Promise<void>;
  /** Queues the model call of an allowed unprompted turn, now or at `startAfter`. */
  enqueueCastPass(scope: PersonalScopeTx, job: CastPassJob, startAfter?: Date): Promise<void>;
  /** Queues the model call that writes one window's "while you were away", in the caller's open transaction. */
  enqueueSummary(scope: PersonalScopeTx, job: SummariseJob): Promise<void>;
}
