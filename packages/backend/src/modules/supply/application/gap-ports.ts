import type { GapRecipe, ReleasedCoverage } from '../../content/public.js';
import type {
  CatalogueTopic,
  GapKind,
  GapStatus,
  GapTarget,
  GapTransition,
  GapCandidate,
  ProposalResult,
} from '../domain/gaps.js';
import type { CanonicalBrief } from './ports.js';

export type { GapSignalInput, RecordGapSignals, GapMarkStore } from './gap-signal-ports.js';

/** A gap as the loop reads it. */
export interface GapRow {
  readonly id: string;
  readonly kind: GapKind;
  readonly planet: string;
  readonly facet?: string;
  readonly status: GapStatus;
  readonly priority: number;
  readonly readers: number;
  /** Failed proposing attempts so far (0 to 2). */
  readonly attempts: number;
  /** Failed production rounds so far (a rejected take, or recipes that all ended without a release). */
  readonly rounds: number;
  /** The UTC day of the attempt in flight, pinned so a redelivery sends the same request. */
  readonly attemptDay?: string;
  readonly recipes: readonly string[];
  readonly firstSeenAt: Date;
}

/** The signals of one UTC day for one planet and, when known, facet: distinct readers only. */
export interface SignalDay extends GapTarget {
  readonly day: string;
  readonly readers: number;
}

/** What the scan does to the store, all inside the scan's one transaction and advisory lock. */
export interface GapScanTx {
  /** Counts the marks not yet counted into `supply.gap_signals` and marks them counted; returns how many it counted. */
  rollUpMarks(): Promise<number>;
  /** Deletes marks, counters and ended gaps past their retention in bounded batches; returns what it deleted. */
  purge(now: Date): Promise<{ readonly marks: number; readonly signals: number; readonly gaps: number }>;
  /** The counted signals of the days from `sinceDay` on. */
  readSignals(sinceDay: string): Promise<readonly SignalDay[]>;
  /** Every gap that has not ended (open, briefed, commissioned or blocked). */
  readLiveGaps(): Promise<readonly GapRow[]>;
  /** For each given hole, the latest gap rejected for it: why, and when it ended. */
  readLastRejected(
    holes: readonly (GapTarget & { readonly kind: GapKind })[],
  ): Promise<readonly (GapTarget & { readonly kind: GapKind; readonly reason: string; readonly endedAt: Date })[]>;
  /** Opens a gap for the hole unless one is already open for its key; says whether it did. */
  createGap(candidate: GapCandidate, priority: number, id: string, now: Date): Promise<boolean>;
  refreshGap(id: string, candidate: GapCandidate, priority: number, now: Date): Promise<void>;
  closeGap(id: string, reason: string, now: Date): Promise<void>;
  /**
   * Ends a failed production round of a commissioned gap: `open` (its recipes ended for good; they are cleared) or `briefed` (a take was
   * rejected and another may start; the stored recipe is kept to be commissioned again), with the round counted.
   */
  endRound(id: string, to: 'open' | 'briefed', rounds: number, now: Date): Promise<void>;
  /** Rejects a gap whose failed rounds reached the bound, with the reason code. */
  rejectGap(id: string, reason: string, rounds: number, now: Date): Promise<void>;
}

export interface GapScanStore {
  /** Runs `work` in one transaction holding the scan's advisory lock, or returns `undefined` when another scan holds it. */
  exclusively<T>(work: (tx: GapScanTx) => Promise<T>): Promise<T | undefined>;
}

export interface GapScanPorts {
  /** The planets of the topic catalogue and their facets, with the planets that are not servable yet (`catalogueTopics`). */
  readonly readCatalogue: () => Promise<readonly CatalogueTopic[]>;
  /** `KS_SUPPLY_GROWTH_ENABLED`. Off: the scan does nothing and reads nothing. */
  readonly enabled: boolean;
  readonly depthTarget: number;
  /** How many failed production rounds reject a gap (`KS_SUPPLY_GAP_MAX_ROUNDS`). */
  readonly maxRounds: number;
  readonly store: GapScanStore;
  readonly readCoverage: () => Promise<ReleasedCoverage>;
  readonly readRecipeStates: (keys: readonly string[]) => Promise<ReadonlyMap<string, GapRecipe['state']>>;
  readonly now: () => Date;
  readonly newId: () => string;
}

/** What one scan did. */
export type GapScanResult =
  | { readonly kind: 'disabled' }
  /** Another scan held the lock. */
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'scanned';
      readonly counted: number;
      readonly opened: number;
      readonly refreshed: number;
      readonly closed: number;
      /** Commissioned gaps put back to `open` (every recipe ended) or to `briefed` (a take was rejected). */
      readonly reopened: number;
      readonly rebriefed: number;
      /** Gaps whose failed production rounds reached the bound. */
      readonly rejected: number;
      readonly purged: number;
    };

/** The scheduled SQL scan (`supply.scan-gaps`): finds the holes and merges the signals into `supply.gaps`. No model. */
export type ScanGaps = () => Promise<GapScanResult>;

/** What the brief job does to gaps, one at a time, each settled in its own short transaction. */
export interface GapBriefStore {
  /** The gaps open or briefed, most pressing first (priority, then age). */
  actionable(limit: number): Promise<readonly GapRow[]>;
  /** The gaps whose production was sent and has not ended, oldest first. */
  commissioned(limit: number): Promise<readonly GapRow[]>;
  /** How many gaps a proposing attempt was begun for since `since`. */
  attemptedSince(since: Date): Promise<number>;
  /**
   * Pins the UTC day of the attempt (an attempt already in flight keeps its day) and stamps the time. Returns the pinned day, or
   * `undefined` when the gap is no longer open or briefed.
   */
  beginAttempt(id: string, day: string, now: Date): Promise<string | undefined>;
  /** Applies the outcome of an attempt. */
  settle(id: string, transition: GapTransition, now: Date): Promise<void>;
  /** Records that production of these recipes was sent for the gap. */
  commission(id: string, recipes: readonly string[], now: Date): Promise<void>;
}

/** What commissioning one recipe's production for a catalogue brief came to. */
export type GrowthOutcome =
  /** A group was started for the recipe: its job must be sent. */
  | { readonly kind: 'commissioned'; readonly recipe: string; readonly take: number }
  /** An active group already covers the brief: its job is sent again so a lost one resumes. */
  | { readonly kind: 'joined'; readonly recipe?: string; readonly take?: number }
  /** Today's growth cap is used up. */
  | { readonly kind: 'capped' }
  /** No stored recipe can be commissioned for the brief. */
  | { readonly kind: 'none' };

/** The shared store of production groups, in one transaction that holds the commissioning lock (as Create does). */
export interface GrowthStore {
  inCommissioning<T>(work: (tx: GrowthTx) => Promise<T>): Promise<T>;
  /** Groups of stored recipes started since `since`, outside a transaction: what the growth cap counts. */
  countGrowthSince(since: Date): Promise<number>;
}

export interface GrowthTx {
  countGrowthSince(since: Date): Promise<number>;
  /**
   * The recipes that would serve a brief and Create's choice among them, read on this transaction's own connection: the decision holds the
   * commissioning lock, so it never waits for a second connection of the pool (other transactions may be waiting on that lock for theirs).
   */
  readRecipes(target: { readonly topicId: string; readonly facetId?: string }): Promise<readonly GapRecipe[]>;
  chooseRecipe(
    brief: { readonly topicId: string; readonly facetId?: string },
    options: { readonly allow: { readonly code: boolean; readonly generated: boolean } },
  ): Promise<
    | { readonly kind: 'recipe'; readonly recipe: string; readonly take: number }
    | { readonly kind: 'none'; readonly capped?: true }
  >;
  findActiveWork(brief: CanonicalBrief): Promise<{ readonly id: string; readonly recipe?: string } | undefined>;
  joinOrCreate(
    brief: CanonicalBrief,
    id: string,
    recipe: string,
  ): Promise<{ readonly id: string; readonly joined: boolean }>;
  closeWork(id: string): Promise<void>;
}

/**
 * Keeps two passes of the brief job from overlapping: `work` runs only while this process holds the pass's session advisory lock, which a
 * crash releases with its connection. No transaction is open across the pass (a model call never holds one); `undefined` when another pass holds it.
 */
export interface GapBriefLock {
  exclusively<T>(work: () => Promise<T>): Promise<T | undefined>;
}

export interface GapBriefPorts {
  readonly enabled: boolean;
  readonly lock: GapBriefLock;
  /** `KS_SUPPLY_GROWTH_DAILY_CAP`: new Scrolls from stored recipes per UTC day, whoever asked; 0 turns growth off. */
  readonly growthDailyCap: number;
  readonly store: GapBriefStore;
  readonly growth: GrowthStore;
  readonly readGapRecipes: (target: {
    readonly topicId: string;
    readonly facetId?: string;
  }) => Promise<readonly GapRecipe[]>;
  /** Asks the brief role for recipes for a planet and facet that exist, on the request identity the caller names. */
  readonly propose: (
    request: { readonly topicId: string; readonly facetId?: string; readonly retry: number; readonly day: string },
    signal: AbortSignal,
  ) => Promise<ProposalResult>;
  /** Sends the production job of one take of a recipe, outside any transaction, below any person's request. */
  readonly enqueueProduction: (recipe: string, take: number) => Promise<void>;
  readonly now: () => Date;
  readonly newId: () => string;
}

/** What one pass of the brief job did, in counts. */
export type GapBriefResult =
  | { readonly kind: 'disabled' }
  /** Another pass holds the lock: this one did nothing. */
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'done';
      /** Proposing attempts made. */
      readonly proposed: number;
      /** Production jobs commissioned or sent again. */
      readonly commissioned: number;
      /** Gaps found already being filled. */
      readonly waiting: number;
      readonly failed: number;
      readonly rejected: number;
      readonly blocked: number;
      /** The budget (a day's cap or the provider's) ended the pass early. */
      readonly paused: boolean;
    };

export type BriefGaps = (signal: AbortSignal) => Promise<GapBriefResult>;
