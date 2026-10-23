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
  ReadCoverageInputs,
  ReadExplorationSnapshot,
  ReadTrustedCoverage,
  TrustedCoverageQuery,
  TrustedCoverageRead,
} from '../../personal-context/public.js';
import type { RecordingReasoningHarness } from '../../../reasoning/public.js';
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
}
export interface GeographyView {
  readonly state: GeographyState;
  readonly objects: readonly Place[];
  readonly routes: readonly Route[];
  readonly aliases: readonly GeographyAlias[];
}
export interface GeographyContext {
  readonly version: 'cartographer-context.v1';
  readonly transitionId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly desiredRevision: number;
  readonly pcRevision: number;
  readonly scopeRevision: number;
  readonly probes: TrustedCoverageQuery['probes'];
  readonly facts: FormationFacts;
  readonly factsSha256: string;
  readonly coverage: TrustedCoverageRead;
  readonly base: GeographyRevisions;
  readonly routeIds: Readonly<Record<string, string>>;
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
  retire(scope: PersonalScopeTx, id: string): Promise<void>;
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
  writeRun(scope: PersonalScopeTx, run: GeographyRun): Promise<void>;
  findDelta(
    scope: PersonalScopeTx,
    transitionId: string,
  ): Promise<{ readonly hash: string; readonly delta: UniverseDelta } | undefined>;
  deltas(scope: PersonalScopeTx, after: number, limit: number): Promise<readonly UniverseDelta[]>;
  saveObject(scope: PersonalScopeTx, object: Place, supportRefs: readonly string[]): Promise<void>;
  saveRoute(scope: PersonalScopeTx, route: Route, supportRefs: readonly string[]): Promise<void>;
  writeDelta(scope: PersonalScopeTx, runId: string, hash: string, delta: UniverseDelta): Promise<void>;
}
export interface GeographyPorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
  readonly ownerActive: CheckPersonalOwnerActive;
  readonly store: GeographyStore;
  readonly readInputs: ReadCoverageInputs;
  readonly readTrusted: ReadTrustedCoverage;
  readonly hash: (value: unknown) => string;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly enqueue: (
    scope: RecordingScopeTx,
    runId: string,
    delayed?: { readonly expectedClaimId: string; readonly startAfter: Date },
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
