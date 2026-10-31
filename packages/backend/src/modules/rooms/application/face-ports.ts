import type { ImageMime, ProductionScopeTx } from '../../../reasoning/public.js';
import type { BackdropAttemptState } from '../domain/backdrop-spend.js';

/**
 * What the operator's face commands need from storage (D-170, D-171, D-166). A room's face is not personal, so none of
 * this runs under a personal root: kits are stored inside the room reasoning scope's own transaction, and the money
 * ledger has its own short transactions. Every method here reads or writes room rows only.
 */

export type ReviewState = 'pending' | 'approved' | 'rejected' | 'superseded';

/** The room an operator names by slug: enough to build a kit's context and a backdrop's prompt. */
export interface FaceRoom {
  readonly roomId: string;
  readonly slug: string;
  readonly name: string;
  readonly topic: { readonly kind: 'system' | 'planet'; readonly id: string };
}

export interface KitRow {
  readonly roomId: string;
  readonly slug: string;
  readonly revision: number;
  /** As stored; checked against today's vocabulary whenever it is shown. */
  readonly kit: unknown;
  readonly reviewState: ReviewState;
  readonly proposedAt: Date;
  readonly reviewedBy: string | null;
}

export interface NewKit {
  readonly roomId: string;
  readonly revision: number;
  readonly kit: object;
  readonly kitVersion: string;
  readonly roleVersion: string;
  readonly model: string;
  readonly attemptId: string | undefined;
  readonly at: Date;
}

export type Decision = 'approved' | 'rejected';
export type DecisionOutcome = 'decided' | 'unknown' | 'not_pending';

export interface NewAttempt {
  readonly attemptId: string;
  readonly roomId: string;
  readonly kitRevision: number | undefined;
  readonly model: string;
  readonly promptSha256: string;
  readonly estimateMicroUsd: number;
  readonly priceSource: string;
  readonly priceCheckedOn: string;
  readonly requestedBy: string;
  readonly at: Date;
}

/** One image attempt as the operator reads it. */
export interface AttemptRow {
  readonly attemptId: string;
  readonly slug: string;
  readonly state: BackdropAttemptState;
  readonly chargeMicroUsd: number;
  readonly estimateMicroUsd: number;
  readonly outcomeCode: string | null;
  readonly dispatchedAt: Date;
}

export interface BackdropRow {
  readonly backdropId: string;
  readonly slug: string;
  readonly mediaKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: ImageMime;
  readonly reviewState: ReviewState;
  readonly createdAt: Date;
}

/** What settles an attempt that was dispatched. */
export type Settlement =
  | { readonly state: 'failed' | 'not_sent'; readonly code: string; readonly at: Date }
  | { readonly state: 'unknown'; readonly code: string; readonly at: Date }
  | {
      readonly state: 'succeeded';
      readonly code: string | undefined;
      readonly at: Date;
      /** The stored picture this attempt made, if it made a usable one. */
      readonly backdrop?: {
        readonly backdropId: string;
        readonly mediaKey: string;
        readonly sha256: string;
        readonly sizeBytes: number;
        readonly mime: ImageMime;
      };
    };

/** What the ledger knows about a room when an attempt is about to be reserved. */
export interface RoomBackdropState {
  readonly room: FaceRoom;
  /** The approved kit as stored (checked by the caller), and its revision. */
  readonly approvedKit: { readonly revision: number; readonly kit: unknown } | undefined;
  /** Attempts of this room that are dispatched or unknown: nothing more may be sent for it. */
  readonly unresolved: number;
  /** Pictures of this room waiting for review. */
  readonly pendingBackdrops: number;
}

/**
 * The money ledger inside one transaction that already holds the spend lock. Only `FaceStore.inLedgerTransaction` hands
 * one out; the lock is taken before the sum is read, so a check and its reservation cannot interleave with another.
 */
export interface BackdropLedgerTx {
  /** What every attempt counts against the cap now, in millionths of a dollar. */
  recordedSpend(): Promise<number>;
  roomState(slug: string): Promise<RoomBackdropState | undefined>;
  reserve(attempt: NewAttempt): Promise<void>;
}

export interface FaceStore {
  roomBySlug(slug: string): Promise<FaceRoom | undefined>;

  // --- Kits ---
  /** The next revision number for the room, and the proposal waiting for review, if any. */
  kitState(roomId: string): Promise<{ readonly nextRevision: number; readonly pending: boolean }>;
  /** Stores a proposal inside the room scope's transaction. `false` when one is already waiting. */
  insertKit(scope: ProductionScopeTx, kit: NewKit): Promise<boolean>;
  listKits(limit: number): Promise<readonly KitRow[]>;
  kit(slug: string, revision: number): Promise<KitRow | undefined>;
  /** Approves or rejects the waiting proposal of that revision; approving supersedes the kit shown so far. */
  decideKit(input: {
    slug: string;
    revision: number;
    decision: Decision;
    by: string;
    at: Date;
  }): Promise<DecisionOutcome>;

  // --- Backdrops ---
  /** Takes the spend lock, then runs `work`; the lock is held to the end of the transaction. */
  inLedgerTransaction<T>(work: (ledger: BackdropLedgerTx) => Promise<T>): Promise<T>;
  /** Settles a dispatched attempt (and stores its picture) in one transaction. `false` when it was not dispatched. */
  settleAttempt(attemptId: string, settlement: Settlement): Promise<boolean>;
  /** Dispatched attempts older than `olderThan` become unknown; they are never sent again. Returns how many. */
  markStaleUnknown(olderThan: Date, at: Date): Promise<number>;
  /** An operator's decision on an unknown attempt, with the reason. `charged` false settles it at nothing. */
  resolveUnknown(
    input:
      | { attemptId: string; resolution: 'reconciled'; charged: boolean; reason: string; by: string; at: Date }
      | { attemptId: string; resolution: 'written_off'; reason: string; by: string; at: Date },
  ): Promise<'resolved' | 'unknown_attempt' | 'not_unknown'>;
  listBackdrops(limit: number): Promise<readonly BackdropRow[]>;
  backdrop(backdropId: string): Promise<BackdropRow | undefined>;
  /** Approves or rejects a waiting picture; approving supersedes the one shown so far. */
  decideBackdrop(input: { backdropId: string; decision: Decision; by: string; at: Date }): Promise<DecisionOutcome>;
  /** The recorded total, and the attempts that still wait for an outcome. */
  spend(limit: number): Promise<{
    readonly recordedMicroUsd: number;
    readonly attempts: number;
    readonly unresolved: readonly AttemptRow[];
  }>;
}

/** Where a picture's bytes go, and whether a stored picture can be found again. */
export interface BackdropMedia {
  put(
    bytes: Uint8Array,
    mime: ImageMime,
  ): Promise<{ readonly key: string; readonly sha256: string; readonly size: number }>;
  has(key: string, size: number): Promise<boolean>;
}
