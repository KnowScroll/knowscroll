import type { EngineRecordFacts, RunOutcome, RunResultFacts, RunStatusFacts } from '../../domain/reel/chain.js';
import type { ReelOnRecord } from '../../domain/reel/fingerprint.js';
import type { ReelScript, ReelUntil } from '../../domain/reel/script.js';

/** The blueprint's attempt states. `dispatched` means "may have been sent". */
export type AttemptState =
  'reserved' | 'not_sent' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'reconciled' | 'written_off';

/** What the shared pool holds for an attempt: nothing, an open claim, or a closed one. */
export type PoolState = 'none' | 'claimed' | 'settled' | 'released';

export interface ReelOrderRecord {
  readonly id: string;
  readonly scriptName: string;
  readonly recipeKey: string;
  readonly until: ReelUntil;
  readonly scriptSha256: string;
  readonly approvalRef: string;
  /** The approved script this order was made from, as it was then. */
  readonly script: ReelScript;
  /** The published Reel, once there is one. */
  readonly assetId: string | null;
}

export interface FinishedFacts {
  readonly outcome: RunOutcome;
  readonly costCents: number;
  readonly finalRunId: string;
  readonly runIds: readonly string[];
  /** Cutroom's reason for a stop, redacted and cut. For the operator only. */
  readonly detail: string | null;
}

export interface ReelAttemptRecord {
  readonly id: string;
  readonly orderId: string;
  readonly take: number;
  readonly paid: boolean;
  readonly requestId: string;
  readonly requestUtf8: string;
  readonly requestSha256: string;
  readonly ceilingCents: number;
  readonly state: AttemptState;
  readonly outcomeCode: string | null;
  /** When the dispatch intent was committed: the request may have left from then on. */
  readonly dispatchedAt: Date | null;
  /** The first run Cutroom made for the request. */
  readonly runId: string | null;
  readonly poolState: PoolState;
  readonly finished: FinishedFacts | null;
}

export interface NewReelOrder {
  readonly scriptName: string;
  readonly recipeKey: string;
  readonly until: ReelUntil;
  readonly scriptSha256: string;
  readonly approvalRef: string;
  readonly script: ReelScript;
}

export interface NewReelAttempt {
  readonly orderId: string;
  readonly take: number;
  readonly paid: boolean;
  readonly requestId: string;
  readonly requestUtf8: string;
  readonly requestSha256: string;
  readonly ceilingCents: number;
}

/**
 * One step forward of an attempt. Each step names the state it starts from, so a repeated or
 * racing command changes nothing twice.
 */
export type AttemptMove =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'not_sent'; readonly code: string }
  | { readonly kind: 'dispatching' }
  | { readonly kind: 'accepted'; readonly runId: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unknown'; readonly code: string }
  | { readonly kind: 'reconciled'; readonly runId: string }
  | { readonly kind: 'written_off'; readonly reason: string }
  | { readonly kind: 'finished'; readonly facts: FinishedFacts }
  | { readonly kind: 'settled' }
  | { readonly kind: 'released' };

/**
 * The world's record of what it asked Cutroom for. Every method is one short transaction.
 * Nothing here calls Cutroom or the pool.
 */
export interface ReelLedger {
  /** The order for this script content, created once. */
  ensureOrder(order: NewReelOrder): Promise<ReelOrderRecord>;
  /** The newest order of a script name at a stage, whatever its content was. */
  latestOrderOf(scriptName: string, until: ReelUntil): Promise<ReelOrderRecord | undefined>;
  /** Attempts of an order, lowest take first. */
  attemptsOf(orderId: string): Promise<readonly ReelAttemptRecord[]>;
  /** Records a new attempt. `undefined` when that take or request id already exists. */
  reserve(attempt: NewReelAttempt): Promise<ReelAttemptRecord | undefined>;
  /** The updated attempt, or `undefined` when it was no longer in the state the move starts from. */
  advance(attemptId: string, move: AttemptMove): Promise<ReelAttemptRecord | undefined>;
  readAttempt(attemptId: string): Promise<ReelAttemptRecord | undefined>;
  listOrders(): Promise<
    readonly { readonly order: ReelOrderRecord; readonly attempts: readonly ReelAttemptRecord[] }[]
  >;
}

export interface PoolIdentity {
  readonly requestId: string;
  readonly scriptSha256: string;
  readonly take: number;
  readonly requestSha256: string;
  readonly world: string;
  readonly ceilingCents: number;
  readonly approvalRef: string;
}

export type PoolClaimResult =
  | { readonly kind: 'claimed' }
  /** Another order of this script is open or already made the Reel: only receive it. */
  | { readonly kind: 'already_ordered'; readonly requestId: string; readonly orderedBy: string }
  | { readonly kind: 'cap_exceeded' }
  | { readonly kind: 'take_taken' };

export interface PoolOrder {
  readonly requestId: string;
  readonly scriptSha256: string;
  readonly take: number;
  readonly requestSha256: string;
  readonly orderedBy: string;
  readonly ceilingCents: number;
  readonly state: 'claimed' | 'settled' | 'released';
  readonly outcome: RunOutcome | null;
  readonly spentCents: number | null;
  readonly finalRunId: string | null;
}

export interface PoolBudget {
  readonly capCents: number;
  readonly committedCents: number;
  readonly leftCents: number;
}

/**
 * The shared spend record (`knowscroll_pool`, ADR-0050). It is the only authority on money: a claim
 * counts its whole ceiling until it is settled at the real cost or released unsent. Methods throw
 * when the pool cannot be reached; callers treat that as "unknown", never as a refusal.
 */
export interface ReelPool {
  nextTake(scriptSha256: string): Promise<number>;
  claim(identity: PoolIdentity): Promise<PoolClaimResult>;
  /** Settling again with the same figures is a no-op; different figures throw. */
  settle(settlement: {
    readonly requestId: string;
    readonly world: string;
    readonly outcome: RunOutcome;
    readonly spentCents: number;
    readonly finalRunId: string | null;
  }): Promise<'settled' | 'already_settled'>;
  /** Gives back a claim whose request was never sent. */
  release(requestId: string, world: string): Promise<'released' | 'already_released'>;
  orders(): Promise<readonly PoolOrder[]>;
  budget(): Promise<PoolBudget>;
}

export type EngineSubmit =
  | { readonly kind: 'accepted'; readonly runId: string; readonly replayed: boolean }
  /** 409 or 422: Cutroom made no run. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The request may or may not have arrived. */
  | { readonly kind: 'unknown'; readonly code: string };

export type EngineRun =
  | { readonly kind: 'found'; readonly status: RunStatusFacts }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreachable' };

/** Cutroom over its published HTTP contract, loopback only (CF-60). One POST per `submit`. */
export interface ReelEngine {
  ready(): Promise<boolean>;
  /** Sends exactly these bytes once. No retry, no second route. */
  submit(requestUtf8: string): Promise<EngineSubmit>;
  /** The newest run of a request id. */
  lookup(requestId: string): Promise<EngineRun>;
  status(runId: string): Promise<EngineRun>;
  result(
    runId: string,
  ): Promise<
    | { readonly kind: 'finished'; readonly result: RunResultFacts }
    | { readonly kind: 'running' }
    | { readonly kind: 'unreachable' }
  >;
  record(
    runId: string,
  ): Promise<
    | { readonly kind: 'finished'; readonly record: EngineRecordFacts }
    | { readonly kind: 'running' }
    | { readonly kind: 'unreachable' }
  >;
  /** The last few plain progress lines of a run, for the operator. */
  progress(runId: string): Promise<readonly string[]>;
}

export interface ReelProbe {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
}

export interface InstalledReel {
  /** Content-addressed key in the media store. */
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
  readonly probe: ReelProbe & Readonly<Record<string, unknown>>;
}

export type InstallResult =
  | { readonly kind: 'installed'; readonly media: InstalledReel }
  /** The file may become readable: wrong permissions, not there yet. The claim stays open. */
  | { readonly kind: 'unreadable'; readonly code: string }
  /** The bytes are not an acceptable Reel and never will be. */
  | { readonly kind: 'refused'; readonly code: string };

/** Copies the finished video out of Cutroom's artifact folder into the media store. No database. */
export interface ReelMedia {
  install(video: { readonly path: string; readonly runId: string }): Promise<InstallResult>;
}

/** The Scroll a Reel twins, as admitted in this world. */
export interface TwinScroll {
  readonly assetId: string;
  readonly revision: number;
  readonly explanationUnitId: string;
}

export interface ReelCatalogue {
  /** `undefined` unless that exact revision of the Scroll is admitted and current. */
  admittedScroll(assetId: string, revision: number): Promise<TwinScroll | undefined>;
  /** Fingerprints of every Reel already in this world, except the one with this asset id. */
  reelsOnRecord(exceptAssetId: string): Promise<readonly ReelOnRecord[]>;
}

export interface PublishReel {
  /** The name the script is ordered by; recorded with the import. */
  readonly scriptName: string;
  readonly script: ReelScript;
  readonly twin: TwinScroll;
  readonly topicId: string;
  readonly media: InstalledReel;
  /** Public provenance: how this Reel came to be. Never served to a reader. */
  readonly provenance: Readonly<Record<string, unknown>>;
  /** The order that asked for it, when this world made one. */
  readonly orderId: string | undefined;
  readonly runId: string;
}

export type PublishResult =
  | { readonly kind: 'published'; readonly assetId: string; readonly created: boolean }
  | { readonly kind: 'refused'; readonly code: 'asset_exists_for_other_run' | 'twin_changed' | 'run_id_not_uuid' };

/** Admits one Reel as a revision of the script's asset, with the twin's explanation unit and topic. */
export interface ReelPublisher {
  publish(reel: PublishReel): Promise<PublishResult>;
}

export interface ReelPorts {
  /** The world this process serves; the pool records it as the ordering world. */
  readonly world: string;
  readonly scripts: ReadonlyMap<string, ReelScript>;
  readonly ledger: ReelLedger;
  readonly pool: ReelPool;
  readonly engine: ReelEngine;
  readonly media: ReelMedia;
  readonly catalogue: ReelCatalogue;
  readonly publisher: ReelPublisher;
  readonly sha256: (text: string) => string;
  readonly now: () => Date;
}
