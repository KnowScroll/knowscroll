import type { makeCommission } from './production/commission.js';
/**
 * Content's public surface for other modules and the apps: the read ports experience and evidence
 * use, and the admission use case's types. Everything here is framework-free; the ports are
 * implemented by `adapters/` and bound by the composition roots through
 * `adapters/nest-providers.ts`.
 *
 * Content is shared, not personal. Reads use the caller transaction; admission writes require
 * an operator-owned admission capability and never record who consumed content.
 */
import { INTERACTION_KINDS, type ScrollDocument } from '@knowscroll/scroll-model';
import type { AccountAccess, PersonalScopeTx } from '../identity/public.js';
import type { AssetKind } from './domain/provenance.js';
import type { ReadingFacts } from './domain/reading-facts.js';

export { PROVENANCE_KINDS, type AssetKind, type ProvenanceKind } from './domain/provenance.js';
export { type ReadingFacts } from './domain/reading-facts.js';
export {
  makeImportEditorialScroll,
  type ImportEditorialScroll,
  type ImportEditorialScrollResult,
  type ImportOutcome,
  type ImportRefusal,
} from './application/import-editorial-scroll.js';

/** The facts an action command needs about its target asset. */
export interface AssetForAction {
  readonly revision: number;
  readonly admitted: boolean;
}

/** Port: read one asset inside the caller's personal transaction (no lock). */
export type FindAssetForAction = (scope: PersonalScopeTx, assetId: string) => Promise<AssetForAction | undefined>;

export const FIND_ASSET_FOR_ACTION = Symbol('content.findAssetForAction');

/** An asset as opening it needs to know it: what it is, its current revision, whether it is admitted. */
export interface OpenableAsset {
  readonly assetId: string;
  readonly kind: AssetKind;
  /** The asset's current revision. */
  readonly revision: number;
  readonly admitted: boolean;
  /** `integrity.sha256` of the current revision's document; undefined when no stored revision exists. */
  readonly documentSha256: string | undefined;
}

/**
 * Port: the asset's current revision for opening it, read inside the caller's personal
 * transaction (no lock: assets are shared and withdrawal need not wait for personal commands).
 * `undefined` when the asset does not exist.
 */
export type FindOpenableAsset = (scope: PersonalScopeTx, assetId: string) => Promise<OpenableAsset | undefined>;

export const FIND_OPENABLE_ASSET = Symbol('content.findOpenableAsset');

/**
 * Port: the reading facts of one stored Scroll revision (block weights, owner of each nested block,
 * the reading estimate), read inside the caller's personal transaction. `undefined` when the
 * revision does not exist or is not a Scroll. Old derived versions are recovered from the immutable document; an unsupported stored document raises a typed operational failure.
 */
export type ReadScrollReadingFacts = (
  scope: PersonalScopeTx,
  assetId: string,
  revision: number,
) => Promise<ReadingFacts | undefined>;

export const READ_SCROLL_READING_FACTS = Symbol('content.readScrollReadingFacts');

/** Shared semantic catalogue and exact-revision sidecars; no wire or personal coverage consumer. */
export { CONCEPT_CATALOGUE_VERSION, CONCEPTS } from './domain/concepts.js';
export { COVERAGE_POLICY, CoverageCommandSchema, CoverageMappingSchema } from './domain/coverage.js';
export type { CoverageAuthority, CoverageCommand, CoverageMapping, CoverageRef } from './domain/coverage.js';
export type {
  AdmitCoverage,
  CoverageHead,
  CoverageRead,
  ReadAdmittedCoverageMapping,
  LockCurrentCoverageAuthorities,
} from './application/coverage-ports.js';
export const READ_ADMITTED_COVERAGE_MAPPING = Symbol('content.readAdmittedCoverageMapping');
export const LOCK_CURRENT_COVERAGE_AUTHORITIES = Symbol('content.lockCurrentCoverageAuthorities');

/** Why a stored revision cannot be rendered for a client. */
export type CannotRenderReason = 'capabilities_invalid' | 'unsupported_document' | 'missing_baseline';

export type RenderScrollResult =
  | {
      readonly kind: 'rendition';
      /** The document negotiated for the client: unsupported blocks replaced by fallbacks, never provenance. */
      readonly document: ScrollDocument;
      /** Essential blocks the client will see only as fallback text. */
      readonly degradedEssential: readonly { readonly blockId: string; readonly originalType: string }[];
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cannot_render'; readonly reason: CannotRenderReason };

/**
 * Port: the consumer document of one stored Scroll revision, negotiated for the client's declared
 * capabilities (D-012). Reads shared, immutable content outside any personal transaction. The
 * internal provenance is never read here.
 */
export type RenderScroll = (request: {
  readonly assetId: string;
  readonly revision: number;
  readonly capabilities: unknown;
}) => Promise<RenderScrollResult>;

export const RENDER_SCROLL = Symbol('content.renderScroll');

/** Whether the admitted block kind declares this value-free interaction in the canonical Scroll registry. */
export function isReadingInteractionAllowed(blockType: string, interactionKind: string): boolean {
  if (!Object.hasOwn(INTERACTION_KINDS, blockType)) return false;
  const declared: Readonly<Record<string, readonly string[] | undefined>> = INTERACTION_KINDS;
  return declared[blockType]?.includes(interactionKind) === true;
}

/** Code-selected production topics and predictable model-request ceiling; no research is exported. */
export { parseScrollTopic, REQUEST_BOUND_PER_TOPIC } from './production/topics.js';
export type { ScrollTopic } from './production/topics.js';
export type { ProduceScrollResult } from './production/types.js';
export {
  validateTopics,
  type EncounterRef,
  type EncounterSnapshot,
  type EncounterQuery,
  type TopicAttribution,
  type ContinuityLink,
  type ContinuityAdmission,
} from './domain/discovery.js';
import type {
  EncounterRef,
  EncounterSnapshot,
  EncounterQuery,
  TopicAttribution,
  ContinuityLink,
  ContinuityAdmission,
} from './domain/discovery.js';
import type { AdmissionTx } from './application/ports.js';
export type ReadDiscoveryCandidates = (
  scope: PersonalScopeTx,
  query: EncounterQuery,
) => Promise<readonly EncounterSnapshot[]>;
export type ReadExactEncounter = (
  scope: PersonalScopeTx,
  request: EncounterRef & { readonly capabilities: unknown },
) => Promise<EncounterSnapshot | undefined>;
export type ReadContinuations = (scope: PersonalScopeTx, source: EncounterRef) => Promise<readonly ContinuityLink[]>;
export type ResolveContinuityLink = (
  scope: PersonalScopeTx,
  expected: {
    readonly linkId: string;
    readonly source: EncounterRef;
    readonly target: EncounterRef;
    readonly revision?: number;
  },
) => Promise<ContinuityLink | undefined>;
export type ReadEncounterTopics = (scope: PersonalScopeTx, ref: EncounterRef) => Promise<readonly TopicAttribution[]>;
export type ReadSavedMetadata = (
  scope: PersonalScopeTx,
  refs: readonly EncounterRef[],
) => Promise<
  readonly {
    readonly ref: EncounterRef;
    readonly metadata?: EncounterSnapshot['metadata'];
    readonly availability: 'available' | 'corrected' | 'withdrawn';
    readonly currentAssetRevision?: number;
  }[]
>;
/** Admission composition only. Caller supplies real authorized facts; no title inference. */
export type AdmitContinuity = (tx: AdmissionTx, admission: ContinuityAdmission) => Promise<void>;
export const READ_DISCOVERY_CANDIDATES = Symbol('content.readDiscoveryCandidates');
export const READ_EXACT_ENCOUNTER = Symbol('content.readExactEncounter');
export const READ_CONTINUATIONS = Symbol('content.readContinuations');
export const RESOLVE_CONTINUITY_LINK = Symbol('content.resolveContinuityLink');
export const READ_ENCOUNTER_TOPICS = Symbol('content.readEncounterTopics');
export const READ_SAVED_METADATA = Symbol('content.readSavedMetadata');

/** Historical attribution only: no document/provenance or permission to open withdrawn content. */
export type EncounterAttribution = Pick<
  EncounterSnapshot,
  'explanationUnitId' | 'topics' | 'facets' | 'catalogWatermark' | 'attributionVersion'
>;
export type ReadEncounterAttribution = (
  scope: PersonalScopeTx,
  ref: EncounterRef,
) => Promise<EncounterAttribution | undefined>;
export const READ_ENCOUNTER_ATTRIBUTION = Symbol('content.readEncounterAttribution');

/** Current-head authority for one-time Supply binding, separate from legacy historical reads.
 * Personal root first; locks all existing asset rows SHARE in UUID order and holds them to commit.
 * Missing/withdrawn/corrected/unsupported references have no encounter. Counters are Content-owned
 * and increase on actual status/current revision changes, including withdrawal/re-admission.
 */
export type LockCurrentEncounters = (
  scope: PersonalScopeTx,
  query: { readonly refs: readonly EncounterRef[]; readonly capabilities: unknown },
) => Promise<
  readonly {
    readonly ref: EncounterRef;
    readonly availabilityRevision: number;
    readonly changedAt: string;
    readonly encounter?: EncounterSnapshot;
  }[]
>;
export const LOCK_CURRENT_ENCOUNTERS = Symbol('content.lockCurrentEncounters');

/** Backend-internal Cutroom prerequisite; pure preparation, no commissioned content or permission. */
export {
  CUTROOM_COMMISSION_POLICY,
  CutroomCommissionScriptSchema,
  CutroomApprovalReferenceSchema,
  lintCutroomCommission,
  prepareCutroomCommission,
} from './production/commission-contracts.js';
export type {
  CutroomCommissionScript,
  CutroomCommissionRefusal,
  CutroomCommissionRun,
  CutroomObservedRun,
  ValidateCutroomRemoteChain,
} from './production/commission-contracts.js';

/** Minimized current immutable facts, bounded by canonical document validation. No rendering grant. */
export type KeepPositionTarget =
  | { readonly kind: 'reel'; readonly durationMs: number }
  | { readonly kind: 'scroll'; readonly topLevelBlockIds: readonly string[] };
/** Precondition: open own PersonalScopeTx, actual same-transaction FENCE_OWN_ACCOUNT, then exact
 * Saved membership check, before this Content SHARE lock. owner must be that fresh gate result.
 * Plain AccountAccess does NOT certify a held lock and cannot be cached/reused as authority.
 * Matching actor/account/universe/epoch is checked here; the caller owns the account-gate and
 * membership protocol. Missing/withdrawn/corrected/unsupported/malformed all return undefined.
 * Current eligibility is freshly read after SHARE waits and remains fenced until commit.
 * Ref uses the existing strict KeepAssetRef schema, not a guessed SQL UUID/revision cast.
 */
export type LockKeepPositionTarget = (
  scope: PersonalScopeTx,
  owner: AccountAccess,
  ref: unknown,
) => Promise<KeepPositionTarget | undefined>;
export const LOCK_KEEP_POSITION_TARGET = Symbol('content.lockKeepPositionTarget');

/** Optional unmounted B business prerequisite; no dispatch/publication/Supply binding. */
export type { CommissionBusiness, CommissionStore, CommissionPorts } from './production/commission-ports.js';
export type CommissionCutroom = ReturnType<typeof makeCommission>;
