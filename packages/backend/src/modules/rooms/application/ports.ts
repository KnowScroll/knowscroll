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
import type { CastMember } from '../domain/cast.js';
import type { ContributionKind, InhabitantId } from '../domain/contribution.js';
import type { AiLevel, EarlierPlace, JoinRule, RoomRole, RoomStatus } from '../domain/membership.js';
import type { CapCounts, RefusalCap } from '../domain/router.js';
import type { SpeechTrigger } from '../domain/triggers.js';
import type { CastDueJob, CastPassJob } from '../events.js';

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
  /** Why a resident spoke on its own; none for a person's message and for an asked contribution. */
  readonly trigger: SpeechTrigger | null;
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
      /** Why the resident spoke on its own; absent for an asked contribution. */
      readonly trigger?: SpeechTrigger;
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
  /** The room's discussions other than General, pinned first and then newest activity. */
  list(lock: RoomLock, limit: number): Promise<readonly DiscussionRow[]>;
  /** The room's General discussion; every room has one. */
  general(lock: RoomLock): Promise<DiscussionRow | undefined>;
  /** When the newest message a member can see was sent, anywhere in the room; none while nobody has written. */
  lastMessageAt(lock: RoomLock): Promise<Date | undefined>;
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
  /** Where messages of this room sit: their discussion, its title and their number. Messages that are gone are absent. */
  locate(
    lock: RoomLock,
    messageIds: readonly string[],
  ): Promise<
    ReadonlyMap<string, { readonly discussionId: string; readonly discussionTitle: string; readonly sequence: number }>
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
  /** The message an unprompted turn answers; none for an ask. */
  readonly causeMessageId: string | null;
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
  /** Turns of this discussion still queued and not lapsed at `now`, asked or not, by inhabitant. */
  openTurns(lock: RoomLock, discussionId: string, now: Date): Promise<readonly InhabitantId[]>;
  /** The caller's newest ask of this discussion that ended without a contribution since `since`. */
  lastUnansweredAsk(
    lock: RoomLock,
    discussionId: string,
    accountId: string,
    since: Date,
  ): Promise<{ readonly inhabitant: InhabitantId; readonly state: 'declined' | 'failed' } | undefined>;
  /** Writes a member's ask as a queued turn. */
  insertAsk(lock: RoomLock, ask: AiTurnRow & { readonly commandId: string }): Promise<void>;
  /** The turn by ID inside the room's lock, for the worker's apply step. */
  read(lock: RoomLock, turnId: string): Promise<AiTurnRow | undefined>;
  settle(lock: RoomLock, turnId: string, outcome: TurnOutcome): Promise<void>;
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
}
