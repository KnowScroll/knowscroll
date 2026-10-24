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
import type { z } from 'zod';
import type { ConversationContentProjectionSchema } from '@knowscroll/contracts';
import { INTERACTION_KINDS, type ScrollDocument } from '@knowscroll/scroll-model';
import type { AccountAccess, PersonalScopeTx } from '../identity/public.js';
import type { AssetKind } from './domain/provenance.js';
import type { CoverageAuthority } from './domain/coverage.js';
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
/** Which Scene family draws a system, star or planet; defined by the library plan. */
export { sceneFamilyOf } from './domain/library/index.js';
export {
  COVERAGE_POLICY,
  CoverageCommandSchema,
  CoverageMappingSchema,
  CoverageAuthoritySchema,
} from './domain/coverage.js';
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
/** Saved membership owner supplies at most100 exact refs. Actual kind survives withdrawal;
 * this read conveys no content access, position or encounter authority. */
export type ReadSavedPageMetadata = (
  scope: PersonalScopeTx,
  refs: readonly EncounterRef[],
) => Promise<readonly (Awaited<ReturnType<ReadSavedMetadata>>[number] & { readonly kind: 'reel' | 'scroll' })[]>;
export const READ_SAVED_PAGE_METADATA = Symbol('content.readSavedPageMetadata');
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

/** Canonical factual facet retrieval only. No text/topic-tag/global discovery fallback.
 * At most100 validated rows plus a key-only lookahead; incomplete selection is explicit. */
export interface RegionEncounterCandidate {
  readonly encounter: EncounterSnapshot;
  readonly coverage: CoverageAuthority;
}
export interface RegionEncounterQuery {
  readonly topicId: string;
  readonly facetId: string;
  readonly truthStatus: 'factual';
  readonly capabilities: unknown;
  readonly expected?: EncounterRef;
}
export type ReadRegionEncounterCandidates = (
  scope: PersonalScopeTx,
  query: RegionEncounterQuery,
) => Promise<
  | { readonly kind: 'read'; readonly candidates: readonly RegionEncounterCandidate[]; readonly hasMore: boolean }
  | { readonly kind: 'unsupported' }
>;
/** Holds exact current asset + canonical mapping SHARE fences until personal commit. */
export type LockRegionEncounterCandidates = (
  scope: PersonalScopeTx,
  query: Omit<RegionEncounterQuery, 'expected'> & {
    readonly candidates: readonly {
      readonly ref: EncounterRef;
      readonly coverage: CoverageAuthority;
    }[];
  },
) => Promise<boolean>;
export const READ_REGION_ENCOUNTER_CANDIDATES = Symbol('content.readRegionEncounterCandidates');
export const LOCK_REGION_ENCOUNTER_CANDIDATES = Symbol('content.lockRegionEncounterCandidates');

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

/** One exact content revision, as a message card or share link names it. */
export interface ContentRef {
  readonly assetId: string;
  readonly assetRevision: number;
}

/** What a card or link shows of one exact revision: available, corrected (original ref kept) or unavailable. */
export type ShareableContent = z.infer<typeof ConversationContentProjectionSchema>;

/**
 * Port: public metadata of exact revisions (at most 100), read inside the caller's personal
 * transaction (a pair-locked shared scope carries one too). Gives each ref `available`,
 * `corrected` (original ref kept, current revision's metadata attached) or `unavailable`. It
 * decides nothing about who may see a card.
 */
export type ReadShareableContent = (
  scope: PersonalScopeTx,
  refs: readonly ContentRef[],
) => Promise<readonly ShareableContent[]>;
export const READ_SHAREABLE_CONTENT = Symbol('content.readShareableContent');

/** The same read for a visitor with no account: shared content only, outside any transaction. */
export type ReadPublicContent = (refs: readonly ContentRef[]) => Promise<readonly ShareableContent[]>;
export const READ_PUBLIC_CONTENT = Symbol('content.readPublicContent');

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

/** C1 source-review packet, never consumer metadata or human-approval authority. */
export {
  prepareCommissionReview,
  reelFingerprint,
  normalizeReelNarration,
  checkReelCorpus,
} from './production/commission-review.js';
export type {
  ReelTemplateDescriptor,
  ReelArgumentDescriptor,
  ReelCorpusRecord,
  ReelCorpusManifest,
  CommissionReviewDraft,
  CommissionReviewPacket,
  CommissionReviewPreparation,
  CommissionHumanApproval,
  CommissionReviewVerdict,
  CommissionReviewStore,
} from './production/commission-review-ports.js';

/** Default-disabled snapshot preapproval only. No live corpus/approval registry or normal binding. */
export { makeCommissionPreparation } from './production/commission-review.js';
export type { CommissionPreparationStore } from './production/commission-review-ports.js';

/** Pure pinned chain metadata only; no remote, settlement or publication authority. */
export { validatePinnedCutroomChain } from './production/commission-chain.js';
export { CUTROOM_CHAIN_UPSTREAM_REVISION, CUTROOM_CHAIN_LIMITS } from './production/commission-contracts.js';
export type {
  CutroomChainInput,
  CutroomChainStatusSnapshot,
  CutroomChainResultSnapshot,
  CutroomChainRecordSnapshot,
  CutroomChainReport,
  CutroomChainLabel,
} from './production/commission-contracts.js';

export { CUTROOM_CHAIN_COLLECTION_LIMITS } from './production/commission-contracts.js';
export type {
  CutroomChainCollector,
  CutroomChainCollectorSettings,
  CutroomChainCollection,
} from './production/commission-contracts.js';

/** Sanitized evidence data/ports only; no adapter or dispatch/settlement factory here. */
export type {
  CutroomCollectedChain,
  CutroomChainSnapshotCollection,
  CutroomChainSnapshotCollector,
} from './production/commission-contracts.js';
export type {
  ChainDocument,
  ChainDocumentKind,
  ChainSnapshotHeader,
  SealedChainSnapshot,
  StoredChainSnapshot,
  ChainSnapshotSelector,
  ChainStoreRefusal,
  ChainStoreResult,
  CommissionChainStore,
  CommissionChainStorePorts,
  CommissionChainSnapshots,
} from './production/commission-chain-store-ports.js';

export type { Commissioning, CommissioningPorts } from './production/commissioning-ports.js';
export type { CommissionPublication, CommissionPublicationResult } from './production/commission-publication-ports.js';
export {
  parseCommissionReviewPacket,
  parseCommissionReviewDraft,
  CommissionHumanApprovalSchema,
  ReelCorpusManifestSchema,
} from './production/commission-review.js';

export { parseCommissioningSetup } from './production/commissioning.js';
export type { CommissioningSetup } from './production/commissioning.js';
export {
  CommissionReceiveSetupSchema,
  CommissionReceivePayloadSchema,
  CommissionReceiveBindingSchema,
  ReceiveWorkSchema,
  ReceiveRecoveryWorkSchema,
  receiveCutroomQueue,
  recoverReceiveCutroomQueue,
} from './production/commission-receive-contracts.js';
export type {
  CommissionReceiveSetup,
  CommissionReceivePayload,
  CommissionReceiveBinding,
} from './production/commission-receive-contracts.js';
export type {
  CommissionReceive,
  CommissionReceivePorts,
  ReceiveResult,
  ReceiveEnvelope,
  ReceiveReceipt,
  ReceiveScopeTx,
  WithReceiveScope,
  ReceiveStore,
  ReceiveRecord,
  ReceiveMedia,
  ReceiveMediaProof,
  CommissionReceiveOrigin,
} from './production/commission-receive-ports.js';
export { makeCommissionReceiveExport } from './production/commission-receive-export.js';
