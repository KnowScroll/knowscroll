import type {
  GeographyRevisions,
  GeographyAlias,
  GeographyObject,
  GeographyRoute,
  UniverseDelta,
  ReadGeography,
  GeographySnapshot,
  ReadUniverseDeltas,
  UniverseDeltas,
  EmergingUniverse,
  ReadEmergingUniverse,
  PlaceConcepts,
  ReadPlaceConcepts,
} from '@knowscroll/contracts';
import type {
  WithPersonalScope,
  PersonalScopeTx,
  PersonalAuthority,
  CheckPersonalOwnerActive,
  FenceOwnAccount,
  FencePersonalRecording,
  RecordingScopeTx,
} from '../../identity/public.js';
import type {
  ClearCoverageDirty,
  MarkCoverageDirty,
  ReadCoverageDirty,
  ReadCoverageInputs,
  ReadExplorationSnapshot,
  ReadTrustedCoverage,
  TrustedCoverageQuery,
  TrustedCoverageRead,
} from '../../personal-context/public.js';
import type { RecordingReasoningHarness } from '../../../reasoning/public.js';
import type { Catalogue } from '../domain/catalogue.js';
import type { Mac } from '../domain/ids.js';
import type { PlaceSchedule } from '../domain/quiet.js';
import type { GeographyProposal, FormationFacts, Place, Route } from '../domain/policy.js';
import type { CartographyJob, PublishDeltaJob } from '../events.js';
import type { RegionEncounterTarget } from '@knowscroll/contracts';
/** Current established own hierarchy only; no Scene label, evidence or renderer authority. */
export interface GeographyRegionConstraint {
  readonly version: 'geography-region-constraint.v1';
  readonly target: RegionEncounterTarget;
  readonly planetId: string;
  readonly planetObjectRevision: number;
  readonly systemId: string;
  readonly topicId: string;
  readonly facetId: string;
  readonly truthStatus: 'factual';
  readonly catalogueVersion: 'content-concepts.v1';
}
export type ReadOwnRegionConstraint = (
  scope: PersonalScopeTx,
  target: RegionEncounterTarget,
) => Promise<
  | { readonly kind: 'read'; readonly constraint: GeographyRegionConstraint }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'stale_target' | 'unsupported_region' | 'temporarily_unavailable';
      readonly geographyRevision: number;
    }
  | { readonly kind: 'refused' }
>;
/** One of the caller's own established factual systems and its catalogue topic (#697); `topicId` is a library system id. */
export type ReadOwnSystemTopic = (
  scope: PersonalScopeTx,
  systemId: string,
) => Promise<
  | { readonly kind: 'read'; readonly systemId: string; readonly topicId: string }
  | { readonly kind: 'unavailable'; readonly reason: 'not_on_map' | 'temporarily_unavailable' }
  | { readonly kind: 'refused' }
>;
export interface RegionConstraintPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly state: GeographyStore['state'];
  /** One indexed own/epoch lookup per call, never the whole Geography view. */
  readonly object: (
    scope: PersonalScopeTx,
    selector: { readonly id: string } | { readonly key: string },
  ) => Promise<unknown>;
}
export type GeographySource = {
  readonly generation: number;
} & (
  | { readonly kind: 'material'; readonly sourceRevision: number }
  | { readonly kind: 'command'; readonly commandId: string }
  | { readonly kind: 'legacy1' }
);
export interface GeographyState extends GeographyRevisions {
  readonly desiredSource?: GeographySource;
  readonly desiredRevision: number;
  readonly materialRevision: number;
  readonly publishedRevision: number;
  readonly activeRunId?: string;
  /** The earliest the next run may start (`pacing.ts`); absent means no wait. */
  readonly nextRunNotBefore?: string;
}
export interface GeographyView {
  readonly state: GeographyState;
  readonly objects: readonly Place[];
  readonly routes: readonly Route[];
  readonly aliases: readonly GeographyAlias[];
}
/**
 * What an incremental evaluation read (D-416): the topics whose supports its facts hold, the personal scope revision it
 * read the dirty set at (a dirty row at or below it was seen), and whether more topics were dirty than one run takes.
 */
export interface EvaluationScope {
  /** The topics evaluated in full (the newest keys of each facet): the dirty rows of these are cleared when the run settles. */
  readonly topics: readonly string[];
  /** Other topics of the same systems read beside them, one key of each facet: read, never cleared, so a neighbour that was dirty still is. */
  readonly neighbours?: readonly string[];
  readonly dirtyThrough: number;
  readonly hasMore: boolean;
  /**
   * The systems whose other supported topics were read beside the touched ones. Their last support is taken from what was
   * read, never from what an earlier evaluation stored, and a re-read of the same topics must do the same.
   */
  readonly systemsRead?: readonly string[];
  /**
   * The evaluated topics that have support keys none of which is trusted now (content withdrawn, a map corrected, a read that
   * observed nothing). Their dirty rows are kept in backoff, not cleared, so they are judged again when the content is trusted.
   */
  readonly untrusted?: readonly string[];
  /** Nothing trusted was found in the evaluated topics but the reader's other recent topics hold trusted support: healthy. */
  readonly otherTrusted?: true;
}
export interface GeographyContext {
  readonly version: 'cartographer-context.v1';
  readonly transitionId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly desiredRevision: number;
  readonly pcRevision: number;
  readonly scopeRevision: number;
  readonly probes: readonly TrustedCoverageQuery['probes'][number][];
  readonly facts: FormationFacts;
  readonly factsSha256: string;
  /** The trusted read the facts come from. Its certificate bodies stay in Personal Context; the witnesses name their digests. */
  readonly coverage: TrustedCoverageRead;
  readonly base: GeographyRevisions;
  /** Absent in a context frozen before incremental evaluation, which held every topic the person had reached. */
  readonly evaluated?: EvaluationScope;
}
/**
 * Why no frozen context could be prepared. Each is recorded as the run's outcome (`geography.runs.outcome`)
 * so a healthy new reader is told apart from a limit that needs an engineer:
 * - `no_support_yet`: the person has no coverage references yet. Healthy; nothing was read or allocated.
 * - `coverage_limit`: the trusted read cannot hold even one probe's proof.
 * - `coverage_authority_changed`: Content or Evidence moved while the proof was read; the next reading tries again.
 * - `structure_limit`: more places or routes than one universe may hold.
 * - `context_too_large`: the frozen context would pass its size bound.
 */
export type PreparationRefusal =
  'no_support_yet' | 'coverage_limit' | 'coverage_authority_changed' | 'structure_limit' | 'context_too_large';
export type GeographyPreparation =
  | {
      readonly kind: 'prepared';
      readonly context: GeographyContext;
      /** Distinct supports the catalogue and truth checks accept (the context holds them all). */
      readonly supportKeys: number;
      /** Places and relations stored, as the structure limit counts them. */
      readonly structure: StructureCounts;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: PreparationRefusal;
      /** What a run was trying to evaluate: the dirty topics it took and the revision it read them at. Absent when no dirty set was read. */
      readonly attempted?: { readonly topics: readonly string[]; readonly dirtyThrough: number };
    };
/** Places and relations a universe stores, each counted up to 1001, which is past the structure limit. */
export interface StructureCounts {
  readonly objects: number;
  readonly relations: number;
}
/** A stored place with when the newest support under it was last seen. */
export interface StoredPlace {
  readonly place: Place;
  readonly lastSupportAt: string | undefined;
}
export interface GeographyRunHeader {
  readonly recording?: { readonly accountId: string; readonly source: GeographySource };
  readonly contextSha256?: string;
  readonly modelContextSha256?: string;
  readonly normalWakeId?: string;
  readonly claimWakeClaimId?: string;
  readonly hasContext: boolean;
  readonly id: string;
  readonly desiredRevision: number;
  readonly status: 'queued' | 'prepared' | 'blocked' | 'unknown' | 'accepted' | 'rejected' | 'stale' | 'insufficient';
  readonly claimId?: string;
  readonly claimUntil?: string;
  readonly outcome?: string;
}
export interface GeographyAccountingHeader {
  readonly claimId?: string;
  readonly claimUntil?: string;
  readonly claimWakeClaimId?: string;
  readonly normalWakeId?: string;
  readonly legacyOrigin: boolean;
  readonly id: string;
  readonly status: GeographyRunHeader['status'];
  readonly accountId?: string;
  readonly generation?: number;
}
export interface GeographyRun extends Omit<GeographyRunHeader, 'hasContext'> {
  readonly id: string;
  readonly desiredRevision: number;
  readonly status: 'queued' | 'prepared' | 'blocked' | 'unknown' | 'accepted' | 'rejected' | 'stale' | 'insufficient';
  readonly claimId?: string;
  readonly claimUntil?: string;
  readonly context?: GeographyContext;
  readonly proposal?: GeographyProposal;
  readonly attemptId?: string;
  readonly outcome?: string;
}
export interface GeographyStore {
  root(scope: RecordingScopeTx): Promise<{ readonly accountId: string; readonly revision: number }>;
  header(scope: PersonalScopeTx, id: string): Promise<GeographyRunHeader | undefined>;
  accountingHeader(scope: PersonalScopeTx, id: string): Promise<GeographyAccountingHeader | undefined>;
  context(scope: RecordingScopeTx, id: string): Promise<GeographyContext | undefined>;
  /** Ends a run nothing will resume; `outcome` says why (default: a revoked recording generation). */
  retire(scope: PersonalScopeTx, id: string, outcome?: string): Promise<void>;
  /** Settles the exact claimed run the harness refused before admitting it, and releases its claim. */
  finishUnadmitted(
    scope: PersonalScopeTx,
    id: string,
    claimId: string,
    settlement: { readonly status: 'accepted' | 'insufficient' | 'stale'; readonly outcome: string },
  ): Promise<void>;
  consumeNormalWake(scope: PersonalScopeTx, id: string, wakeId: string): Promise<boolean>;
  setNormalWake(scope: PersonalScopeTx, id: string, wakeId: string): Promise<boolean>;
  state(scope: PersonalScopeTx): Promise<GeographyState>;
  writeState(scope: PersonalScopeTx, state: GeographyState): Promise<void>;
  view(scope: PersonalScopeTx): Promise<GeographyView>;
  /** How many places and relations are stored, each up to 1001. One indexed count, never the rows. */
  structure(scope: PersonalScopeTx): Promise<StructureCounts>;
  /** The stored places with these semantic keys, by the unique (universe, epoch, key) index, with their last support. */
  places(scope: PersonalScopeTx, keys: readonly string[]): Promise<readonly StoredPlace[]>;
  /** The stored places with these ids; ids of another universe or epoch find nothing. */
  placesById(scope: PersonalScopeTx, ids: readonly string[]): Promise<readonly Place[]>;
  /** The stored routes with these semantic keys (the sorted pair of planet keys). */
  routes(scope: PersonalScopeTx, keys: readonly string[]): Promise<readonly Route[]>;
  /**
   * The universe's place secret (hex). With `create` it is made at the first call and kept until the universe is cleared
   * or erased; without it a universe that has none answers undefined and nothing is written.
   */
  placeSecret(scope: PersonalScopeTx, create: boolean): Promise<string | undefined>;
  /** Writes when each place was last supported and when it next needs a look, by semantic key. */
  saveSchedule(scope: PersonalScopeTx, schedules: readonly PlaceSchedule[]): Promise<void>;
  /** Moves the next look of these places (by id) to `at`, for places a settle could not decide. */
  deferQuiet(scope: PersonalScopeTx, ids: readonly string[], at: Date): Promise<void>;
  /**
   * Looks at these places again later because a settle could not read them: `unreadRetryMs` after `now`, doubling with each
   * look, and not at all from the `QUIET_SWEEP.unreadAttempts`th look (their next look is cleared until reading stores it again).
   */
  backOffQuiet(scope: PersonalScopeTx, ids: readonly string[], now: Date): Promise<void>;
  /** Places due for a look at `at` (oldest first, at most `limit`): what the dry run says a settle would see. */
  duePlaces(scope: PersonalScopeTx, at: Date, limit: number): Promise<readonly Place[]>;
  writeRun(scope: PersonalScopeTx, run: GeographyRun): Promise<void>;
  findDelta(
    scope: PersonalScopeTx,
    transitionId: string,
  ): Promise<{ readonly hash: string; readonly delta: UniverseDelta } | undefined>;
  deltas(scope: PersonalScopeTx, after: number, limit: number): Promise<readonly UniverseDelta[]>;
  saveObject(scope: PersonalScopeTx, object: Place, supportRefs: readonly string[]): Promise<void>;
  saveRoute(scope: PersonalScopeTx, route: Route, supportRefs: readonly string[]): Promise<void>;
  /** `runId` is absent for a delta no Cartographer run made (a quiet-sweep settle). */
  writeDelta(scope: PersonalScopeTx, runId: string | undefined, hash: string, delta: UniverseDelta): Promise<void>;
}
export interface GeographyPorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly store: GeographyStore;
  readonly readDirty: ReadCoverageDirty;
  readonly clearDirty: ClearCoverageDirty;
  readonly markDirty: MarkCoverageDirty;
  readonly readInputs: ReadCoverageInputs;
  readonly readTrusted: ReadTrustedCoverage;
  readonly catalogue: Catalogue;
  readonly hash: (value: unknown) => string;
  /** HMAC-SHA-256 as hex. Derived ids are `mac(placeSecret, key)`. */
  readonly mac: Mac;
  /** A new place secret (256 random bits as hex). */
  readonly seed: () => string;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  /**
   * Wakes a run. Without `delayed` the wake is immediate; `startAfter` alone delays the ordinary wake;
   * with `expectedClaimId` it is the recovery wake bound to that claim.
   */
  readonly enqueue: (
    scope: RecordingScopeTx,
    runId: string,
    delayed?: { readonly startAfter: Date; readonly expectedClaimId?: string },
  ) => Promise<boolean>;
  /** Necessary metadata cleanup only: current desired source may wake a revoked older header. */
  readonly enqueueRetirement: (scope: RecordingScopeTx, runId: string) => Promise<void>;
  readonly applied: GeographyApplied;
  readonly rootRevision: (scope: PersonalScopeTx) => Promise<number>;
  readonly enqueueDelta: (scope: PersonalScopeTx, delta: UniverseDelta) => Promise<void>;
  readonly notify: (scope: PersonalScopeTx, revision: number, eventId: string) => Promise<void>;
  readonly receipts: {
    find(
      scope: PersonalScopeTx,
      commandId: string,
      input: unknown,
    ): Promise<
      { readonly kind: 'new' | 'refused' } | { readonly kind: 'replay'; readonly outcome: RequestCartographyResult }
    >;
    insert(scope: PersonalScopeTx, commandId: string, input: unknown): Promise<void>;
    complete(scope: PersonalScopeTx, commandId: string, outcome: RequestCartographyResult): Promise<void>;
  };
}
export interface CartographerPorts extends GeographyPorts {
  readonly harness: RecordingReasoningHarness;
  /** The `KS_CARTOGRAPHER_ENABLED` switch. Spend stays bounded by the shared reasoning budgets. */
  readonly enabled: () => boolean;
}
export type MaterialGeographyChange = (
  scope: RecordingScopeTx,
  input: { readonly sourceRevision: number; readonly recordingGeneration: number },
) => Promise<void>;
export type RequestCartographyResult =
  | {
      readonly kind: 'accepted';
      readonly runId: string;
      readonly desiredRevision: number;
      readonly privacyEpoch: number;
      readonly revision: number;
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'scope_refused' | 'command_key_reused' | 'run_not_resumable' | 'recording_required';
    };
export type RequestCartography = (
  authority: PersonalAuthority,
  command: { readonly commandId: string; readonly resumeRunId?: string; readonly recordingGeneration?: number },
) => Promise<RequestCartographyResult>;
export type RunCartographer = (job: CartographyJob, signal: AbortSignal) => Promise<void>;
export type PublishGeographyDelta = (job: PublishDeltaJob) => Promise<void>;
export type ReadOwnGeography = (
  authority: PersonalAuthority,
  query: ReadGeography,
) => Promise<
  | { readonly kind: 'read'; readonly snapshot: GeographySnapshot }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' | 'selection_not_found' }
>;
export type ReadOwnDeltas = (
  authority: PersonalAuthority,
  query: ReadUniverseDeltas,
) => Promise<
  | { readonly kind: 'read'; readonly deltas: UniverseDeltas }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' }
>;

/** Dust cues read the same scope and store as the other own reads, plus Personal Context's snapshot. */
export interface EmergingPorts extends Pick<GeographyPorts, 'withScope' | 'ownerActive' | 'store' | 'hash' | 'now'> {
  readonly readSnapshot: ReadExplorationSnapshot;
}
export type ReadOwnPlaceConcepts = (
  authority: PersonalAuthority,
  query: ReadPlaceConcepts,
) => Promise<
  | { readonly kind: 'read'; readonly concepts: PlaceConcepts }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' }
>;
export type ReadOwnEmerging = (
  authority: PersonalAuthority,
  query: ReadEmergingUniverse,
) => Promise<
  | { readonly kind: 'read'; readonly emerging: EmergingUniverse }
  | { readonly kind: 'refused'; readonly reason: 'scope_refused' }
>;

/** Minimized canonical Geography projection input; never evidence, prompts or support refs. */
export interface GeographySceneInput {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly personalRevision: number;
  readonly geography: GeographyRevisions;
  readonly objects: readonly (GeographyObject & { readonly meaningId: string })[];
  readonly routes: readonly GeographyRoute[];
  readonly aliases: readonly GeographyAlias[];
}
export type ReadGeographySceneInput = (scope: PersonalScopeTx) => Promise<
  | { readonly kind: 'read'; readonly input: GeographySceneInput }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'limit' | 'temporarily_unavailable';
      readonly geography: GeographyRevisions;
      readonly personalRevision: number;
    }
  | { readonly kind: 'refused' }
>;
export type GeographyApplied = (
  scope: RecordingScopeTx,
  input: {
    readonly transitionId: string;
    readonly recordingGeneration: number;
    readonly geography: GeographyRevisions;
    readonly personalRevision: number;
    /** Actual creation operations from the just-committed delta, not model proposals or Scene
     * inference. Optional only for old fixture/composition callers; apply always supplies it. */
    readonly committedCreations?: {
      readonly recordedAt: string;
      readonly targets: readonly {
        readonly operation: 'create_system' | 'establish_star' | 'form_planet' | 'add_region';
        readonly objectId: string;
        readonly parentId: string;
        readonly kind: 'system' | 'star' | 'planet' | 'region';
        readonly objectRevision: number;
        readonly label: string;
        readonly truthStatus: 'factual' | 'hypothetical';
      }[];
    };
  },
) => Promise<void>;
