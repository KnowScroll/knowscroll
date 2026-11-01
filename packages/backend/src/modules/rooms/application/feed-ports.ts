import type { ProductionScopeTx } from '../../../reasoning/public.js';
import type { CastMember } from '../domain/cast.js';
import type { InhabitantId } from '../domain/contribution.js';
import type { FeedCap, FeedCounts } from '../domain/feed.js';
import type { RoomStatus } from '../domain/membership.js';
import type { ScoutCadence, ScoutCap, ScoutCounts } from '../domain/scout.js';
import type { ContentRef } from '../../content/public.js';

/**
 * What the heartbeat of residents needs from storage (v3 R-8, D-248). A feed pass is the room's own work: no person asked
 * for it and none is its actor, so it runs under the nonpersonal `rooms` reasoning scope, never a personal one. Every method
 * that takes a scope runs inside that scope's transaction (the one that also holds the harness's room root), so a decision,
 * its ledger row and a post commit together. No method reads a person: a member is only ever a count of listeners, a flag that
 * says whose words are left out, or text read after that flag was applied. The scouts' methods (v3 R-9) read one more thing of the
 * member who sent a scout: whether they are still in the room and whether their recording is on, never anything they did.
 */

/** A room the heartbeat may look at: where it is in the library. */
export interface FeedRoomRef {
  readonly roomId: string;
  readonly slug: string;
  readonly topic: { readonly kind: 'system' | 'planet'; readonly id: string };
}

/** The locked room, as a pass reads it. */
export interface FeedRoom extends FeedRoomRef {
  readonly name: string;
  readonly status: RoomStatus;
  readonly cast: readonly CastMember[];
  /** Current members whose AI level is not Off. */
  readonly listeners: number;
}

/**
 * Who writes a find and signs it: one of the room's residents, or a member's scout (v3 R-9). A scout has no resident and no account
 * of its own; its owner is the member who sent it.
 */
export type FindAuthor =
  | { readonly kind: 'resident'; readonly inhabitant: InhabitantId }
  | { readonly kind: 'scout'; readonly ownerAccountId: string };

/** A find or a refresh of the memory, as the ledger holds it. */
export interface FeedTurn {
  readonly turnId: string;
  readonly kind: 'feed_find' | 'memory_refresh' | 'scout_find';
  readonly author: FindAuthor;
  readonly state: 'queued' | 'completed' | 'declined' | 'failed' | 'refused';
  /** The asset a find is about; none for a refresh. */
  readonly asset: ContentRef | undefined;
  readonly createdAt: Date;
}

/** What a stored AI turn records of the call that made it. */
export interface FeedProvenance {
  readonly roleVersion: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly attemptId: string | undefined;
}

export interface NewFeedTurn {
  readonly turnId: string;
  readonly roomId: string;
  readonly kind: 'feed_find' | 'memory_refresh' | 'scout_find';
  readonly author: FindAuthor;
  readonly asset: ContentRef | undefined;
  readonly decision: { readonly kind: 'allowed' } | { readonly kind: 'refused'; readonly cap: FeedCap | ScoutCap };
  readonly counts: FeedCounts | ScoutCounts;
  readonly now: Date;
}

/** How a queued turn ended. A turn that reached the provider stays counted: `dispatched` is only ever raised. */
export type FeedTurnOutcome =
  | { readonly state: 'declined' | 'failed'; readonly at: Date; readonly dispatched: boolean }
  | { readonly state: 'completed'; readonly at: Date; readonly provenance: FeedProvenance };

/** The find to post: a discussion rooted at the asset, with the resident's note as its first message. */
export interface NewFind {
  readonly turnId: string;
  readonly roomId: string;
  readonly discussionId: string;
  readonly messageId: string;
  readonly author: FindAuthor;
  readonly asset: ContentRef;
  readonly title: string;
  readonly note: string;
  readonly at: Date;
  readonly provenance: FeedProvenance;
}

/** The memory a room has, as a pass reads it. */
export interface MemoryRow {
  readonly state: 'ready' | 'stale';
  readonly source: 'derived' | 'moderator';
  readonly body: string | null;
  readonly coversThrough: Date | undefined;
}

/** One retained message a memory may read: its words, who wrote it (never shown) and when. */
export interface MemoryMessage {
  readonly messageId: string;
  readonly accountId: string;
  readonly text: string;
  readonly recordedAt: Date;
}

export interface NewMemory {
  readonly roomId: string;
  readonly turnId: string;
  readonly body: string;
  readonly coversFrom: Date;
  readonly coversThrough: Date;
  readonly messagesRead: number;
  readonly at: Date;
}

export interface FeedStore {
  // --- Reads on the pool: the cheap look before any transaction ---------------------------------

  /** Open rooms with a resident and at least one member whose AI level is not Off, in a stable order. */
  roomsToLook(limit: number): Promise<readonly FeedRoomRef[]>;
  /** A room by its slug, for an operator who names it. */
  roomBySlug(slug: string): Promise<FeedRoomRef | undefined>;
  /**
   * Which of these assets the room has already seen, itself or in its twin: a find about it, a find turn that was made or is
   * being made, or a card of it a member shared, for the asset or for any asset of the same explanation (a Reel and the Scroll
   * made from one explanation are one find, not two).
   */
  seenAmong(roomId: string, assetIds: readonly string[]): Promise<ReadonlySet<string>>;

  // --- In the room scope's transaction ------------------------------------------------------------

  /** Locks the room's row FOR UPDATE, so every count below is exact, and reads it with its cast and its listeners. */
  lockRoom(scope: ProductionScopeTx, roomId: string): Promise<FeedRoom | undefined>;
  /** Ends the room's queued finds and refreshes created before `before`: their job is gone. They stay counted. */
  lapseLost(scope: ProductionScopeTx, roomId: string, before: Date, at: Date): Promise<void>;
  turn(scope: ProductionScopeTx, turnId: string): Promise<FeedTurn | undefined>;
  /** When each resident last had a find counted in the room, and the counts the caps compare, at `now`. */
  feedFacts(
    scope: ProductionScopeTx,
    roomId: string,
    now: Date,
  ): Promise<{ readonly lastFindAt: Readonly<Partial<Record<InhabitantId, Date>>>; readonly counts: FeedCounts }>;
  /** Whether the room has seen this asset, read under the lock. */
  seen(scope: ProductionScopeTx, roomId: string, assetId: string): Promise<boolean>;
  /** Writes the turn's ledger row; false when the turn already exists (the same look ran before). */
  insertTurn(scope: ProductionScopeTx, turn: NewFeedTurn): Promise<boolean>;
  settleTurn(scope: ProductionScopeTx, turnId: string, outcome: FeedTurnOutcome): Promise<void>;
  /** Makes the find's discussion and note, settles its turn as completed and announces the room, in this transaction. */
  postFind(scope: ProductionScopeTx, find: NewFind): Promise<void>;

  /** The room's memory row, if it has one. */
  memory(scope: ProductionScopeTx, roomId: string): Promise<MemoryRow | undefined>;
  /**
   * The newest `limit` retained messages of members: shown (not removed, not a deleted account's), plain text, by a member who
   * does not keep theirs out, in every discussion of the room, oldest first. No topic title, no card, no resident's words.
   */
  memoryWindow(scope: ProductionScopeTx, roomId: string, limit: number): Promise<readonly MemoryMessage[]>;
  /**
   * How many of these messages are still retained and readable now: they are what a refresh read, checked again before its
   * words are stored. The messages and their authors' member rows are locked shared while they are counted, so a removal,
   * a keep-out or a deletion in flight is waited for and its committed result is what is counted.
   */
  stillReadable(scope: ProductionScopeTx, roomId: string, messageIds: readonly string[]): Promise<number>;
  /**
   * The display names and handles of the room's members, current and past: the words a memory may not contain. Read for
   * that check only; they never reach a model.
   */
  memberNames(scope: ProductionScopeTx, roomId: string): Promise<readonly string[]>;
  /** When the room's last refresh that made a call and wrote nothing ended, if one did lately. */
  lastUnwrittenRefreshAt(scope: ProductionScopeTx, roomId: string, since: Date): Promise<Date | undefined>;
  /** Stores the derived text, unless a moderator's text stands. */
  storeMemory(scope: ProductionScopeTx, memory: NewMemory): Promise<void>;

  // --- Scouts (v3 R-9): the same pass, with a member's scout as the author ------------------------

  /**
   * Scouts that may post: open room, not paused, not stopped, the owner a current member, recording on, someone else listening.
   * The one who posted longest ago first, so a room's daily five go round. A cheap look before any transaction; every fact is
   * read again under the room's lock.
   */
  scoutsToLook(limit: number): Promise<readonly ScoutRef[]>;
  /** The scout of this owner in the room with this slug, for an operator who names it. */
  scoutIn(slug: string, ownerHandle: string): Promise<ScoutRef | undefined>;
  /** What decides whether this scout posts, read under the room's lock (see `ScoutStanding`). */
  scoutStanding(scope: ProductionScopeTx, roomId: string, ownerAccountId: string, now: Date): Promise<ScoutStanding>;
}

/** A scout the heartbeat may look at: the room it posts in, its owner and the topics the owner chose. */
export interface ScoutRef {
  readonly room: FeedRoomRef;
  readonly ownerAccountId: string;
  readonly interests: readonly string[];
}

/** What a scout's look decides from, as the room stores it now. The owner's recording is one unlocked read (D-259). */
export interface ScoutStanding {
  readonly scout:
    | {
        readonly cadence: ScoutCadence;
        readonly interests: readonly string[];
        readonly paused: boolean;
        readonly stopped: boolean;
      }
    | undefined;
  readonly ownerIsMember: boolean;
  readonly recording: boolean;
  /** Current members other than the owner whose AI level is not Off. */
  readonly otherListeners: number;
  readonly lastPostAt: Date | undefined;
  readonly scoutsToday: number;
}

// --- What a member's own use cases need, inside the personal scope and the room's lock ----------------------

/** One find as the feed lists it: the discussion, who posted, what it is about and the note. */
export interface FindRow {
  readonly discussionId: string;
  /** The resident that posted it, or the member whose scout did. */
  readonly author: FindAuthor;
  readonly asset: ContentRef;
  readonly postedAt: Date;
  /** The resident's note; none when a moderator removed it, and then the find is not listed. */
  readonly note: string | null;
  /** Messages shown after the note. */
  readonly replies: number;
}

export interface MemoryView {
  readonly state: 'ready' | 'stale';
  readonly source: 'derived' | 'moderator';
  readonly body: string | null;
}

/** Why a derived memory is no longer to be trusted. */
export type MemoryStaleCause =
  /** A message recorded at this time was removed by a moderator. */
  | { readonly coveringAt: Date }
  /** Everything this account wrote is out of what AI reads now: kept out, or the account was deleted. */
  | { readonly byAccount: string };
