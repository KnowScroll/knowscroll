import type { ConversationContentProjectionSchema, PublicPersonRef } from '@knowscroll/contracts';
import type { z } from 'zod';
import type {
  ReadContentSequence,
  ReadLibraryReels,
  ResolveSnippetAnchor,
  StoredSnippetAnchor,
  ValidateSnippetAnchor,
} from '../../content/public.js';
import type { ReadVisitedAssets } from '../../experience/public.js';
import type { ReadGeographySceneInput } from '../../geography/public.js';
import type {
  FenceOwnAccount,
  FencePersonalRecording,
  PersonalScopeTx,
  SharedScopeTx,
  WithPersonalScope,
} from '../../identity/public.js';
import type { ActivityKind, ActivityState, StoredDefinition } from '../domain/activities.js';
import type { LaunchRow, ReadyDeck, StoredAnswer } from './launch-ports.js';
import type { WatchSessionRow } from './watch-ports.js';
import type { UnnoticedQuestion } from './question-ports.js';
import type { AskKind } from '../domain/asks.js';
import type { CastMember } from '../domain/cast.js';
import type { ContributionKind, InhabitantId } from '../domain/contribution.js';
import type { AiLevel, EarlierPlace, JoinRule, RoomRole, RoomStatus } from '../domain/membership.js';
import type { CapCounts, RefusalCap } from '../domain/router.js';
import type { StarAct } from '../domain/sky.js';
import type { MessageTrigger, SpeechTrigger } from '../domain/triggers.js';
import type { CastDueJob, CastPassJob, LaunchSettleJob, SummariseJob } from '../events.js';
import type { FindQuery, FindRow, LiveEventRow, MemoryStaleCause, MemoryView, ResidentFacts } from './feed-ports.js';
import type { ScoutCadence } from '../domain/scout.js';

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
  readonly kind: 'general' | 'topic' | 'today' | 'find' | 'intro';
  readonly title: string;
  /**
   * The title is the first words of the message the topic began from, not what the starter typed. It is then another
   * person's words, shown only while that message is (`shownTitle`).
   */
  readonly titleDerived: boolean;
  /** A label the starter picked from a closed list; none for General and for a topic started without one. */
  readonly tag: TopicTag | null;
  readonly root: ContentRef | null;
  /** The address a person's post cites instead of a library asset (v3 R-8b); erased with the account that wrote it. */
  readonly source: string | null;
  /** A person wrote this find (a post, not a resident's or a scout's find). It stays true when the account is gone. */
  readonly personPost: boolean;
  /** The resident this discussion introduces (kind `intro`, v3 R-8b); none for every other discussion. */
  readonly introInhabitant: InhabitantId | null;
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
  /** The starter is told when a person answers: true only for a question (migration 0089). */
  readonly notifyAnswer?: boolean;
  /**
   * Makes this a member's post to the Feed (v3 R-8b): a find started by a person, rooted at `root` or citing `sourceUrl`, never both.
   */
  readonly post?: { readonly sourceUrl: string | undefined };
  /** Makes this a resident's introduction (v3 R-8b): a discussion of kind `intro`, started by the moderator who set it up. */
  readonly intro?: { readonly inhabitant: InhabitantId };
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
  /** The member whose scout wrote it (v3 R-9); the note's words are the scout's and it is signed with this member's name. */
  readonly agentOwnerAccountId: string | null;
  readonly inhabitant: InhabitantId | null;
  readonly aiKind: ContributionKind | null;
  readonly text: string | null;
  readonly content: ContentRef | null;
  readonly note: string | null;
  /** Why a resident spoke on its own; none for a person's message and for an asked contribution. */
  readonly trigger: MessageTrigger | null;
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
  readonly discussionKind: 'general' | 'topic' | 'today' | 'find' | 'intro';
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
  /** The room's Today discussion: one per room, made with it (migration 0085). */
  today(lock: RoomLock): Promise<DiscussionRow | undefined>;
  /**
   * When the newest message **a person** wrote that a member can see was sent, anywhere in the room; none while no person has written.
   * A resident's words are not counted: the quiet pill must not make a room look busy because an AI answered (D-243).
   */
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
  /**
   * Makes a discussion's first words its own: the message becomes its origin and its title is marked as made from that message
   * (`title_derived`), so the title is read only while the message is (D-168). It is a second step because the origin is a foreign key
   * to a message that cannot exist before the discussion does, and the title check needs the origin.
   */
  setOrigin(lock: RoomLock, discussionId: string, messageId: string): Promise<void>;
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

// --- The sky, debates and Today (migration 0085) ------------------------------------------

export type StarActName = StarAct;

export interface StarRecord {
  readonly starId: string;
  readonly act: StarActName;
  readonly sourceKey: string;
  readonly at: Date;
  readonly day: string;
  readonly constellationNo: number;
}

export interface ConstellationRow {
  readonly no: number;
  readonly completedAt: Date;
  readonly candidates: readonly [string, string, string];
  readonly voteClosesAt: Date;
  readonly name: string | null;
}

/** What a station needs of a room's sky, read without a room lock. */
export interface SkyFigures {
  readonly stars: number;
  /** The latest finished constellation has a name. */
  readonly latestIsNamed: boolean;
  readonly latestName: string | undefined;
}

/**
 * The room's stars and constellations. A star names no account. `lock` takes the room's sky lock, the last lock of a
 * transaction: the daily count, the unique insert and the constellation check that follow are exact under it.
 */
export interface SkyStore {
  lock(lock: RoomLock): Promise<void>;
  hasStar(lock: RoomLock, act: StarActName, sourceKey: string): Promise<boolean>;
  starsOn(lock: RoomLock, day: string): Promise<number>;
  starTotal(lock: RoomLock): Promise<number>;
  insertStar(lock: RoomLock, star: StarRecord): Promise<void>;
  latestStars(
    lock: RoomLock,
    limit: number,
  ): Promise<readonly { act: StarActName; day: string; constellation: number }[]>;
  constellations(lock: RoomLock): Promise<readonly ConstellationRow[]>;
  insertConstellation(lock: RoomLock, row: Omit<ConstellationRow, 'name'>): Promise<void>;
  name(lock: RoomLock, no: number, name: string, at: Date): Promise<void>;
  /** Votes for each of the three names of constellation `no`. */
  votes(lock: RoomLock, no: number): Promise<readonly [number, number, number]>;
  yourVote(lock: RoomLock, no: number, accountId: string): Promise<0 | 1 | 2 | undefined>;
  setVote(lock: RoomLock, no: number, accountId: string, candidate: 0 | 1 | 2, now: Date): Promise<void>;
  /**
   * Deletes what a member contributed here that is theirs to take back when they leave or are removed: their votes on
   * constellation names and debates and their taps on Spot the flaw. A star they earned has no account and stays.
   */
  forgetMember(lock: RoomLock, accountId: string): Promise<void>;
  /** The sky of each of these rooms, for the stations of a map. */
  figures(scope: PersonalScopeTx, roomIds: readonly string[]): Promise<ReadonlyMap<string, SkyFigures>>;
}

export interface DebateRow {
  readonly discussionId: string;
  readonly sides: readonly [string, string];
  readonly closesAt: Date;
  readonly state: 'open' | 'closed';
  readonly winner: 'a' | 'b' | null;
}

export interface DebateStore {
  insert(
    lock: RoomLock,
    debate: { discussionId: string; sides: readonly [string, string]; closesAt: Date },
  ): Promise<void>;
  load(lock: RoomLock, discussionId: string, rowLock: 'none' | 'share'): Promise<DebateRow | undefined>;
  tally(lock: RoomLock, discussionId: string): Promise<{ readonly a: number; readonly b: number }>;
  yourVote(lock: RoomLock, discussionId: string, accountId: string): Promise<'a' | 'b' | undefined>;
  setVote(lock: RoomLock, discussionId: string, accountId: string, side: 'a' | 'b', now: Date): Promise<void>;
  /**
   * Closes every open debate of the room whose time has come, and answers the ones this call closed with their tallies,
   * so each earns its star once even when two members' commands meet it together.
   */
  closeDue(
    lock: RoomLock,
    now: Date,
    decide: (tally: { readonly a: number; readonly b: number }) => { readonly winner: 'a' | 'b' | undefined },
  ): Promise<readonly { readonly discussionId: string; readonly voters: number }[]>;
}

export interface RitualRow {
  readonly ritualId: string;
  readonly day: string;
  readonly kind: 'question' | 'flaw';
  /** The stored shape as written (`ritual.v1`); the use case parses it before serving. */
  readonly payload: unknown;
}

export interface TodayStore {
  /** The room's approved items for a day. */
  approvedOn(lock: RoomLock, day: string): Promise<readonly RitualRow[]>;
  /** One approved item of this room, any day. */
  approved(lock: RoomLock, ritualId: string): Promise<RitualRow | undefined>;
  /** The approved questions of the days before `day`, newest first. */
  pastQuestions(lock: RoomLock, day: string, limit: number): Promise<readonly RitualRow[]>;
  solveOf(
    lock: RoomLock,
    ritualId: string,
    accountId: string,
  ): Promise<{ readonly picked: number; readonly correct: boolean } | undefined>;
  /** Records the person's one tap; false when they already tapped (the first stands). */
  insertSolve(
    lock: RoomLock,
    solve: { ritualId: string; accountId: string; picked: number; correct: boolean; now: Date },
  ): Promise<boolean>;
  found(lock: RoomLock, ritualId: string): Promise<number>;
  /** How many messages by people, shown and with words, Today has had since `since`. */
  messagesSince(lock: RoomLock, discussionId: string, since: Date): Promise<number>;
}

// --- The Launch (migration 0088) ----------------------------------------------------------

/**
 * The Launch's rows. Every method is one explicit query inside the room's lock; none decides access or a result. The use case takes the
 * room root first, then a Launch row (`share` to answer or join, `update` to settle), and the sky lock last.
 */
export interface LaunchStore {
  /** The room's unfinished Launch, if any. `share` and `update` hold its row: an answer waits for a settlement and the other way round. */
  unfinished(lock: RoomLock, rowLock: 'none' | 'share' | 'update'): Promise<LaunchRow | undefined>;
  /** The room's newest Launch, finished or not. */
  latest(lock: RoomLock): Promise<LaunchRow | undefined>;
  /**
   * The room's newest Launch whose play time has ended and whose answers are still kept: it started between the two times given, both
   * included (`replayWindow`). Whether it is `finished` yet does not matter: its answers are complete once its play time is over.
   */
  replayable(
    lock: RoomLock,
    window: { readonly startedBefore: Date; readonly startedAfter: Date },
  ): Promise<LaunchRow | undefined>;
  /** The newest approved deck dated from `fromDay` to `toDay` (UTC days, both included) that no Launch has used. */
  readyDeck(lock: RoomLock, fromDay: string, toDay: string): Promise<ReadyDeck | undefined>;
  insert(
    lock: RoomLock,
    launch: {
      readonly launchId: string;
      readonly deckRitualId: string;
      readonly questions: unknown;
      readonly startsAt: Date;
      readonly now: Date;
    },
  ): Promise<void>;
  /** Puts a person in the Launch; false when they already were. */
  addPlayer(lock: RoomLock, launchId: string, accountId: string, now: Date): Promise<boolean>;
  players(
    lock: RoomLock,
    launchId: string,
  ): Promise<readonly { readonly accountId: string; readonly joinedAt: Date }[]>;
  isPlayer(lock: RoomLock, launchId: string, accountId: string): Promise<boolean>;
  answers(lock: RoomLock, launchId: string): Promise<readonly StoredAnswer[]>;
  /** One person's answer to one round, for the question that is still open: nobody else's row is read while it is. */
  ownAnswer(lock: RoomLock, launchId: string, round: number, accountId: string): Promise<StoredAnswer | undefined>;
  /** Stores an answer; false when the person already answered this round (the first stands). */
  addAnswer(lock: RoomLock, answer: StoredAnswer & { readonly launchId: string; readonly now: Date }): Promise<boolean>;
  /** Marks an unfinished Launch finished, once, at the moment its play time ended. False when another command finished it first. */
  finish(
    lock: RoomLock,
    launchId: string,
    result: { readonly at: Date; readonly played: number; readonly star: boolean },
  ): Promise<boolean>;
  /** Deletes the players and answers of this room's Launches that finished before `before`. */
  purgeResults(lock: RoomLock, before: Date): Promise<void>;
  /** Deletes what this person did in the room's Launches: they are not a member any more (leaving, removal). */
  forgetMember(lock: RoomLock, accountId: string): Promise<void>;
  /** Which of these rooms have an unfinished Launch whose play time has not passed at `now`, for a station on a map. */
  liveRooms(scope: PersonalScopeTx, roomIds: readonly string[], now: Date): Promise<ReadonlySet<string>>;
}

// --- Watch together (migration 0094) ---------------------------------------------------------

/**
 * The rows of Watch together. Every method is one explicit query inside the room's lock; none decides access or a count. The use case
 * takes the room root first and then the session row (`share` to join or leave, `update` to settle or stop). Nothing here reads or
 * writes a playback position: there is none to keep (D-256).
 */
export interface WatchStore {
  /** The room's session that has not been stopped, if any. It may be past its end until a member command settles it. */
  live(lock: RoomLock, rowLock: 'none' | 'share' | 'update'): Promise<WatchSessionRow | undefined>;
  /** The room's newest session, stopped or not. */
  latest(lock: RoomLock): Promise<WatchSessionRow | undefined>;
  insert(
    lock: RoomLock,
    session: {
      readonly sessionId: string;
      readonly assetId: string;
      readonly assetRevision: number;
      readonly title: string;
      readonly durationMs: number;
      readonly startedBy: string;
      readonly startsAt: Date;
    },
  ): Promise<void>;
  /** Puts a person among the session's viewers; false when they already were. */
  addViewer(lock: RoomLock, sessionId: string, accountId: string): Promise<boolean>;
  /** Takes a person out; false when they were not in. */
  removeViewer(lock: RoomLock, sessionId: string, accountId: string): Promise<boolean>;
  /** Everyone who joined the session, as accounts, in no order a reader could use. */
  viewers(lock: RoomLock, sessionId: string): Promise<readonly string[]>;
  /** Marks an unstopped session stopped at `at`, once. False when another command stopped it first. */
  stop(lock: RoomLock, sessionId: string, at: Date): Promise<boolean>;
  /** Deletes the viewers of a session. */
  clearViewers(lock: RoomLock, sessionId: string): Promise<void>;
  /** How many sessions the room started at or after `since`. */
  startedSince(lock: RoomLock, since: Date): Promise<number>;
  /** Deletes this room's sessions that were stopped before `before` (their viewers went when they stopped). */
  purge(lock: RoomLock, before: Date): Promise<void>;
  /** Deletes what this person has in the room's sessions and empties the link that says they shared one (leaving, removal). */
  forgetMember(lock: RoomLock, accountId: string): Promise<void>;
  /** Which of these rooms have a session that has not been stopped and whose Reel has not run out at `now`, for a station on a map. */
  liveRooms(scope: PersonalScopeTx, roomIds: readonly string[], now: Date): Promise<ReadonlySet<string>>;
}

// --- Questions left for people (migration 0089) -------------------------------------------

/**
 * The notice state of the questions left for people. Every method is one explicit query inside the room's lock; none decides access. Whether
 * a question is still open is read from its messages, never stored.
 */
export interface QuestionStore {
  /** How many of the room's questions no person but their starter has spoken in. A question whose starter's account is gone is not waiting for anyone. */
  waiting(lock: RoomLock): Promise<number>;
  /**
   * The caller's own questions they asked to be told about, have not noticed, and a person other than `skipping` has spoken in; newest
   * first, at most `limit`, each with its first such person. The caller skips the people they blocked and the people with no profile to name,
   * so a question is told by the first person it can name, however many others spoke before them.
   */
  unnoticed(
    lock: RoomLock,
    accountId: string,
    limit: number,
    skipping: ReadonlySet<string>,
  ): Promise<readonly UnnoticedQuestion[]>;
  /**
   * Ends the starter's notice on their questions in this room: the switch is turned off and the marker is cleared. Done when they leave
   * or are removed, as their place and votes are, because both are theirs and mean nothing without the membership.
   */
  forgetMember(lock: RoomLock, accountId: string): Promise<void>;
  /**
   * Sets whether the starter is told and/or records that they noticed an answer. Undefined when the discussion is not a question in this
   * room that this account started, so a refusal never says which.
   */
  setNotice(
    lock: RoomLock,
    input: {
      readonly discussionId: string;
      readonly accountId: string;
      readonly notify?: boolean;
      readonly noticedAt?: Date;
    },
  ): Promise<{ readonly notify: boolean } | undefined>;
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

// --- The residents' feed and the room's memory (migration 0091) -----------------------------------

/**
 * The feed and the memory as a member's own use cases read them, inside the personal scope and the room's lock. The heartbeat's own
 * store, which has no person and no lock of a personal scope, is `FeedStore` in `feed-ports.ts`.
 */
export interface FeedReadStore {
  /**
   * The room's posts, at most `query.limit`: `new` newest first, `top` the posts of the window with the most votes first, `hot` the
   * newest hundred in the order of `new` for code to rank. A post whose first message was removed, or whose account is gone, is
   * left out.
   */
  finds(lock: RoomLock, query: FindQuery): Promise<readonly FindRow[]>;
  /** One resident's facts for its profile (v3 R-8b). */
  residentFacts(lock: RoomLock, inhabitant: InhabitantId): Promise<ResidentFacts>;
  /** The posts and the replies under them made since `since`, newest first, at most `limit`: what the live strip chooses among. */
  liveEvents(lock: RoomLock, since: Date, limit: number): Promise<readonly LiveEventRow[]>;
  memory(lock: RoomLock): Promise<MemoryView | undefined>;
  /** A moderator's own words become the memory, and the replacement is audited. */
  replaceMemory(
    lock: RoomLock,
    input: {
      readonly byAccountId: string;
      readonly text: string;
      readonly now: Date;
      readonly editId: string;
      readonly sha256: string;
    },
  ): Promise<void>;
  /** A moderator clears the memory: it is written again from what members said, and the clearing is audited. */
  clearMemory(
    lock: RoomLock,
    input: { readonly byAccountId: string; readonly now: Date; readonly editId: string },
  ): Promise<void>;
  /** Erases the words of a derived memory that read what was just removed, kept out or deleted. A moderator's text is not touched. */
  markMemoryStale(lock: RoomLock, cause: MemoryStaleCause): Promise<void>;
}

// --- A member's own scout, inside the personal scope and the room's lock ---------------------------

/** A member's scout in one room, as they set it and as a moderator may have stopped it. */
export interface ScoutRow {
  readonly scoutId: string;
  readonly interests: readonly string[];
  readonly cadence: ScoutCadence;
  readonly paused: boolean;
  readonly stopped: boolean;
}

/** A person's posts to the Feed and the votes on every post (migration 0098), inside the personal scope and the room's lock. */
export interface PostStore {
  /** How many posts this member has made in this room since `since`. */
  postsSince(lock: RoomLock, accountId: string, since: Date): Promise<number>;
  /** The room's find about this asset or source, whoever posted it. */
  existing(
    lock: RoomLock,
    link: { readonly kind: 'content'; readonly assetId: string } | { readonly kind: 'source'; readonly url: string },
  ): Promise<string | undefined>;
  /**
   * A post that people may vote on: a find of this room whose first message is shown (a resident's introduction takes no votes, D-300). Its author is the member who wrote it, or
   * none for a resident's or a scout's find.
   */
  votable(lock: RoomLock, discussionId: string): Promise<{ readonly authorAccountId: string | null } | undefined>;
  /** Records or takes back this member's vote on a post. One per member per post; the same value again changes nothing. */
  setVote(lock: RoomLock, discussionId: string, accountId: string, voted: boolean, now: Date): Promise<void>;
  /** The votes a post has now. */
  votesOf(lock: RoomLock, discussionId: string): Promise<number>;
  /** A post's votes and whether this member voted, for the post's own page. */
  voteView(
    lock: RoomLock,
    discussionId: string,
    accountId: string,
  ): Promise<{ readonly votes: number; readonly voted: boolean }>;
  /** The introduction a resident has in this room, if it has one. */
  introductionOf(lock: RoomLock, inhabitant: InhabitantId): Promise<string | undefined>;
  /** Deletes the member's votes in this room (leaving, removal). What they posted stays. */
  forgetMember(lock: RoomLock, accountId: string): Promise<void>;
}

export interface ScoutReadStore {
  /** The member's own scout in the room, if they sent one. */
  scoutOf(lock: RoomLock, accountId: string): Promise<ScoutRow | undefined>;
  /** Whether the member's own recording is on: a scout posts nothing while it is paused (D-259). */
  recordingOn(lock: RoomLock, accountId: string): Promise<boolean>;
  /** When the member's scout last had a find counted in this room; none when it has not posted. */
  lastPostOf(lock: RoomLock, accountId: string): Promise<Date | undefined>;
  /** Sends a scout, or changes the one that stands; a moderator's stop is kept. */
  save(
    lock: RoomLock,
    input: {
      readonly scoutId: string;
      readonly accountId: string;
      readonly interests: readonly string[];
      readonly cadence: ScoutCadence;
      readonly paused: boolean;
      readonly now: Date;
    },
  ): Promise<void>;
  /**
   * Ends the member's scout with their membership (leaving, removal): the row goes, a moderator's stop with it. It posts nothing
   * more; what it posted stays.
   */
  forgetMember(lock: RoomLock, accountId: string): Promise<void>;
  /**
   * The member takes their scout back. It posts nothing more; what it posted stays. A scout a moderator stopped is not deleted but
   * paused, with the stop kept, so sending it again cannot undo a moderator's stop (D-261).
   */
  takeBack(lock: RoomLock, accountId: string, now: Date): Promise<void>;
  /** A moderator stops a member's scout, or lets it post again. False when the member has none. */
  setStopped(
    lock: RoomLock,
    input: { readonly accountId: string; readonly stopped: boolean; readonly byAccountId: string; readonly now: Date },
  ): Promise<boolean>;
}

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
  /** Whether the person's recording is on, for the commands whose result the server stores as a play result (D-083). */
  readonly fenceRecording: FencePersonalRecording;
  readonly rooms: RoomStore;
  readonly discussions: DiscussionStore;
  readonly presence: PresenceStore;
  readonly ai: AiStore;
  readonly cast: CastStore;
  readonly positions: PositionStore;
  readonly summaries: SummaryStore;
  readonly activities: ActivityStore;
  readonly sky: SkyStore;
  readonly debates: DebateStore;
  readonly today: TodayStore;
  /** The Launch's rows (migration 0088). */
  readonly launches: LaunchStore;
  /** The rows of Watch together (migration 0094). */
  readonly watches: WatchStore;
  /** The residents' feed and the room's memory, as a member reads and a moderator changes them (migration 0091). */
  readonly feed: FeedReadStore;
  /** A member's own scout in a room (migration 0095). */
  readonly scouts: ScoutReadStore;
  /** A member's posts to the Feed and the votes on posts (migration 0098). */
  readonly posts: PostStore;
  /** The notice state of the questions left for people (migration 0089). */
  readonly questions: QuestionStore;
  readonly people: PersonLookup;
  readonly friends: FriendLookup;
  readonly blocked: BlockedLookup;
  readonly readContent: ReadContent;
  /** The library Reels under a topic, for Watch together (v3 R-10). */
  readonly readReels: ReadLibraryReels;
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
  /** Whether members may send scouts in this world (`KS_ROOMS_SCOUTS_ENABLED`, D-259). Off, a scout cannot be set and none is shown. */
  readonly scoutsEnabled: boolean;
  /** The most stars a room earns on one UTC day (D-174); the same in every process of a world. */
  readonly starsPerDay: number;
  /** The rest between the start of one Launch and the next, in milliseconds (`KS_ROOMS_LAUNCH_GAP_MINUTES`, D-178). */
  readonly launchGapMs: number;
  /** Queues the check that decides whether a resident answers a message, to run at `startAfter`. */
  enqueueCastDue(scope: PersonalScopeTx, job: CastDueJob, startAfter: Date): Promise<void>;
  /** Queues the settlement of a Launch to run at `startAfter`, its end, in the caller's open transaction. */
  enqueueLaunchSettle(scope: PersonalScopeTx, job: LaunchSettleJob, startAfter: Date): Promise<void>;
  /** Queues the model call of an allowed unprompted turn, now or at `startAfter`. */
  enqueueCastPass(scope: PersonalScopeTx, job: CastPassJob, startAfter?: Date): Promise<void>;
  /** Queues the model call that writes one window's "while you were away", in the caller's open transaction. */
  enqueueSummary(scope: PersonalScopeTx, job: SummariseJob): Promise<void>;
}
