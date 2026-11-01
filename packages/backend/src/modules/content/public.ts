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
import {
  INTERACTION_KINDS,
  INTERACTION_KINDS_V2,
  type BlockStateSnapshot,
  type Framing,
  type ScrollDocument,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';
import type { AccountAccess, PersonalAuthority, PersonalScopeTx, ReadOn } from '../identity/public.js';
import type { AssetKind } from './domain/provenance.js';
import type { CoverageAuthority } from './domain/coverage.js';
import type { ReadingFacts } from './domain/reading-facts.js';
import type { PlayLevel } from './domain/traits.js';

export { PROVENANCE_KINDS, type AssetKind, type ProvenanceKind } from './domain/provenance.js';
export { type ReadingFacts } from './domain/reading-facts.js';
export { PLAY_LEVELS, type EncounterTraits, type PlayLevel } from './domain/traits.js';
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
  /**
   * Present when the caller named a revision: whether that revision exists and the review gate has not
   * held or rejected it (D-138). A revision the gate withheld was never served, so nobody has met it.
   */
  readonly revisionReleased?: boolean;
}

/**
 * Port: read one asset inside the caller's personal transaction (no lock). With `revision`, also whether
 * that exact revision may be named by a caller (`revisionReleased`).
 */
export type FindAssetForAction = (
  scope: PersonalScopeTx,
  assetId: string,
  revision?: number,
) => Promise<AssetForAction | undefined>;

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

/**
 * One call of a `scroll-document.v2`: the stop, what it asks and offers, which option is right and what the reveal
 * says. The server judges a locked pick from it, and a thread shows the question to everyone and the rest at the reveal.
 */
export interface ScrollCallFacts {
  readonly stopId: string;
  readonly kind: 'call_it' | 'final_call';
  readonly optionCount: number;
  /** The question, as the reader sees it. */
  readonly prompt: string;
  /** The options, as the reader sees them, in order; `optionCount` of them. */
  readonly options: readonly string[];
  /** Zero-based index of the right option. Never sent to another module's ranking or planning (D-063). */
  readonly answer: number;
  /** Why the answer is what it is: shown after the lock, to everyone. */
  readonly explain: string;
  /** The warm second look shown after a wrong pick. */
  readonly twist: string;
  /**
   * The option that is the common wrong guess and the label of the source that says so, only when the source was
   * reviewed by a person: an unreviewed label is never given (admission requires it, so this is the same rule the
   * reader applies). Authored with the recipe, never counted from what people picked (D-157).
   */
  readonly commonGuess: { readonly option: number; readonly source: string } | undefined;
}

/** What a Scroll revision awards when its Final call is locked: the stable key and the name the reader sees (D-188). */
export interface ScrollLandmarkFacts {
  readonly key: string;
  readonly name: string;
}

/** What play needs of one Scroll revision: its calls, and the landmark its Final call awards (none for most). */
export interface ScrollPlayFacts {
  readonly calls: readonly ScrollCallFacts[];
  readonly landmark: ScrollLandmarkFacts | undefined;
}

/**
 * Port: the calls and the landmark of one stored Scroll revision, read from its immutable document
 * inside the caller's personal transaction. `undefined` when the revision does not exist, is not a
 * `scroll-document.v2`, or is held or rejected by the review gate (D-138); no calls when it has none.
 */
export type ReadScrollPlayFacts = (
  scope: PersonalScopeTx,
  assetId: string,
  revision: number,
) => Promise<ScrollPlayFacts | undefined>;

export const READ_SCROLL_PLAY_FACTS = Symbol('content.readScrollPlayFacts');

/** What "Ask from here" needs of one stop of a Scroll revision: where it is and what the Scroll itself suggests asking. */
export interface ScrollAskFacts {
  /** The Scroll's own title: public, shown to the writer as the subject. */
  readonly title: string;
  /** The words of the stop the question was asked from. */
  readonly stopText: string;
  /** The questions the Scroll invites, authored with it and checked with it (one to three). */
  readonly suggestions: readonly string[];
}

/**
 * Port: the ask facts of one stop of an exact Scroll revision, read from its immutable document inside the caller's
 * personal transaction. `undefined` when the revision does not exist, is not a `scroll-document.v2`, is held or
 * rejected by the review gate (D-138), or has no stop with that ID: an anchor that is not in the revision is no anchor.
 */
export type ReadScrollAskFacts = (
  scope: PersonalScopeTx,
  ref: ContentRef,
  stopId: string,
) => Promise<ScrollAskFacts | undefined>;

export const READ_SCROLL_ASK_FACTS = Symbol('content.readScrollAskFacts');

/** Shared semantic catalogue and exact-revision sidecars; no wire or personal coverage consumer. */
export { CONCEPT_CATALOGUE_VERSION, CONCEPTS, conceptLabel } from './domain/concepts.js';
/** Which Scene family draws a system, star or planet, and a system's haze family; defined by the library plan. */
export { sceneFamilyOf, hazeFamilyOf } from './domain/library/index.js';
export type { HazeFamilyName } from './domain/library/plan.js';
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
      /**
       * The document negotiated for the client: unsupported blocks replaced by fallbacks, never provenance.
       * A `scroll-document.v2` is served whole, to a client that declared the schema.
       */
      readonly document: ScrollDocument | ScrollDocumentV2;
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

/**
 * Whether the admitted block kind (a v1 block type, or a v2 call) declares this value-free
 * interaction in the canonical Scroll registry.
 */
export function isReadingInteractionAllowed(blockType: string, interactionKind: string): boolean {
  const declared: Readonly<Record<string, readonly string[] | undefined>> = {
    ...INTERACTION_KINDS,
    ...INTERACTION_KINDS_V2,
  };
  return Object.hasOwn(declared, blockType) && declared[blockType]?.includes(interactionKind) === true;
}

/**
 * Scroll production as shared worker jobs (D-037): the queue and its job, and the two reads
 * Quartermaster makes. A request is commissioned by choosing a library recipe by code and sending its
 * job in the request's own transaction; the shared run's standing is read without any lock.
 */
export {
  produceScrollQueue,
  produceScrollJob,
  produceScrollSingletonKey,
  ProduceScrollJobSchema,
  type ProduceScrollJob,
} from './production/events.js';
export type { RunScrollProduction, ScrollProductionJobOutcome, ProduceScroll } from './production/job.js';
export { libraryRecipes, planLibraryProduction, planRegeneration } from './domain/library/serving.js';
export type {
  CatalogueBrief,
  LibraryProductionPlan,
  LibraryRecipeStatus,
  ProductionSend,
  RegenerationPlan,
  RegenerationState,
  ScrollProductionReading,
  ScrollProductionState,
  ScrollRecipeChoice,
} from './domain/library/serving.js';
/** Chooses the library recipe a missing-supply request commissions; read inside the caller's personal transaction. */
export type ChooseScrollRecipe = (scope: PersonalScopeTx, brief: CatalogueBrief) => Promise<ScrollRecipeChoice>;
export const CHOOSE_SCROLL_RECIPE = Symbol('content.chooseScrollRecipe');
/**
 * Where one recipe's production stands (`stopped` for a key the plan does not hold) and the take a
 * send for it should name.
 */
export type ReadScrollProduction = (scope: PersonalScopeTx, recipe: string) => Promise<ScrollProductionReading>;
export const READ_SCROLL_PRODUCTION = Symbol('content.readScrollProduction');

/** Code-selected production topics and predictable model-request ceiling; no research is exported. */
export {
  parseScrollTopic,
  MAX_TAKES_PER_RECIPE,
  REQUEST_BOUND_PER_TOPIC,
  REQUEST_BOUND_V2_PER_TOPIC,
  requestBoundOf,
  SCROLL_PRODUCTION_VERSION,
} from './production/topics.js';
export type { ScrollTopic } from './production/topics.js';
/**
 * The words of a quote compared with a text, for a model's claim that a text says something (D-250, D-251): a claim
 * is accepted only when the quote is in the text. Pure.
 */
export { hasEnoughWords, isAbout, quoteIsIn } from './domain/ask-support.js';
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
import type { CatalogueBrief, ScrollProductionReading, ScrollRecipeChoice } from './domain/library/serving.js';
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
/**
 * How many units the admitted series revision holds (`content.series_units`), or `undefined` when it
 * holds none. The only source of a series total: it is counted, never declared or invented (D-059).
 */
export type ReadSeriesTotal = (
  scope: PersonalScopeTx,
  series: { readonly seriesId: string; readonly seriesRevision: number },
) => Promise<number | undefined>;
export const READ_SERIES_TOTAL = Symbol('content.readSeriesTotal');
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

/**
 * The play level of one exact revision, derived from its stored document (D-192). A Reel, a revision the
 * review gate holds and one that does not exist read as `plain`. Shared content only: it says nothing
 * of the reader, and it is read at a projection, not served to a client.
 */
export type ReadPlayLevel = (scope: PersonalScopeTx, ref: EncounterRef) => Promise<PlayLevel>;
export const READ_PLAY_LEVEL = Symbol('content.readPlayLevel');

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

/** One exact content revision, as a message card or share link names it. */
export interface ContentRef {
  readonly assetId: string;
  readonly assetRevision: number;
}

export { madeToOrderKey } from './domain/order-key.js';

/**
 * One admitted library Scroll's prose, for a room's daily items (v3 R-5): the current revision of a Scroll that anyone may
 * be served (not held by the review gate, not made for a thread), with the text of its prose blocks. A block is a
 * paragraph of a v1 document, or one stop's paragraph and line blocks joined by a space for a v2 document, and its
 * `blockId` is the block's own ID (a v2 stop's ID). Shared public content: no person, no scope.
 */
export interface LibraryPassageSource {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly { readonly blockId: string; readonly text: string }[];
}

/**
 * The library Scrolls under a topic: a system covers every planet of it, a planet is its own. At most `limit` (1 to 100), by
 * asset ID. With `only` the read is for that one exact revision (found only while it is still a served library Scroll
 * under the topic), so a check of one Scroll never depends on how many others the topic has.
 */
export type ReadLibraryPassages = (
  topic: { readonly kind: 'system' | 'planet'; readonly id: string },
  limit: number,
  only?: { readonly assetId: string; readonly assetRevision: number },
) => Promise<readonly LibraryPassageSource[]>;
export const READ_LIBRARY_PASSAGES = Symbol('content.readLibraryPassages');

/**
 * The text of one block of the exact revision, only while that revision is still the current admitted one that anyone may
 * be served: the re-check that a cited passage still says what it did. Absent when the Scroll was corrected, withdrawn or
 * held, or the block is gone.
 */
export type ReadLibraryPassageText = (ref: ContentRef & { readonly blockId: string }) => Promise<string | undefined>;
export const READ_LIBRARY_PASSAGE_TEXT = Symbol('content.readLibraryPassageText');

/**
 * One admitted library Scroll's calls, for a room's Launch (v3 R-6): the current revision of a `scroll-document.v2` that anyone may
 * be served (the same Scrolls as `LibraryPassageSource`), with each call's question, options, right answer and reason as its authors
 * wrote and reviewed them. Shared public content: no person, no scope. A Scroll with no call is not listed.
 */
export interface LibraryCallSource {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly title: string;
  readonly calls: readonly {
    readonly stopId: string;
    readonly prompt: string;
    readonly options: readonly string[];
    /** Zero-based index of the right option. Never sent to another module's ranking or planning (D-063). */
    readonly answer: number;
    readonly explain: string;
  }[];
}

/**
 * The library Scrolls under a topic with their calls: a system covers every planet of it, a planet is its own. At most `limit` (1 to
 * 100), by asset ID. With `only` the read is for that one exact revision, found only while it is still a served library Scroll under
 * the topic, so a check of one Scroll never depends on how many others the topic has.
 */
export type ReadLibraryCalls = (
  topic: { readonly kind: 'system' | 'planet'; readonly id: string },
  limit: number,
  only?: { readonly assetId: string; readonly assetRevision: number },
) => Promise<readonly LibraryCallSource[]>;
export const READ_LIBRARY_CALLS = Symbol('content.readLibraryCalls');

/**
 * One admitted library asset a room's resident may post about (v3 R-8, D-248): a Reel or a Scroll that is the current revision of
 * its asset, that anyone may be served (not held by the review gate, not made for a thread), with the title and summary its
 * authors wrote. Shared public content: no person, no scope. Nothing here says who watched or read it.
 */
export interface LibraryFindSource {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly kind: 'reel' | 'scroll';
  readonly title: string;
  readonly summary: string;
}

/**
 * The admitted library assets under a topic, newest first: a system covers every planet of it, a planet is its own. At most `limit`
 * (1 to 100). With `only` the read is for that one exact revision, found only while it is still a served asset under the topic, so the
 * check that a post's asset still stands never depends on how many others the topic has. With `within` it keeps only assets whose
 * primary topic is one of those planets of the topic (a scout's own choice, v3 R-9); a planet outside the topic is ignored, and an
 * empty list finds nothing.
 */
export type ReadLibraryFinds = (
  topic: { readonly kind: 'system' | 'planet'; readonly id: string },
  limit: number,
  only?: { readonly assetId: string; readonly assetRevision: number },
  within?: readonly string[],
) => Promise<readonly LibraryFindSource[]>;
export const READ_LIBRARY_FINDS = Symbol('content.readLibraryFinds');

/**
 * Scrolls ordered from code (D-049). A module that holds shared work (a scenario branch) builds a
 * brief, a framing and the research pages itself and orders a Scroll. Content stores the order,
 * researches the pages, writes the Scroll through the same production job and admits it, and adds
 * only what an order means: the Scroll is never offered in Explore, never attributed to a topic or
 * given coverage, never shareable as a card, and only the audience the ordering module names may open
 * it. The production job's recipe key is `order-…` and follows the same take rules as a library recipe.
 */
export interface MadeToOrderScroll {
  /** The order's identity, chosen by the caller (a scenario node's ID); a repeated order is the same order. */
  readonly orderId: string;
  /** The Scroll's identity, allocated by the caller. */
  readonly assetId: string;
  readonly mode: 'what_if' | 'perspective' | 'question';
  /** What the writer is told: subject, premise and direction, or a person's question. Built by the caller from validated parts. */
  readonly brief: string;
  /** One to three public pages the caller chose by code; research fetches them like any recipe's. */
  readonly pages: readonly string[];
  readonly kicker: string;
  /** Hypothetical or perspective framing, copied into the Scroll by code and shown by the reader. */
  readonly framing: Framing;
}

/** Stores the order in the caller's transaction; returns the recipe key to enqueue. A repeated order changes nothing. */
export type RecordMadeToOrderScroll = (
  scope: PersonalScopeTx,
  order: MadeToOrderScroll,
) => Promise<{ readonly recipe: string }>;
export const RECORD_MADE_TO_ORDER_SCROLL = Symbol('content.recordMadeToOrderScroll');

/** An order's production standing, as a library recipe's, with the admitted Scroll once there is one. */
export interface MadeToOrderStanding extends ScrollProductionReading {
  /** The admitted Scroll: its exact revision and the title the writer gave it. */
  readonly published?: ContentRef & { readonly title: string };
}
/** Where an order's production stands. Reads shared tables on the pool; a key that is no order is `stopped`. */
export type ReadMadeToOrderProduction = (recipe: string) => Promise<MadeToOrderStanding>;
export const READ_MADE_TO_ORDER_PRODUCTION = Symbol('content.readMadeToOrderProduction');

/** The same read on the caller's own personal transaction, for a use case that already holds one (no second connection). */
export type ReadMadeToOrderProductionIn = (scope: PersonalScopeTx, recipe: string) => Promise<MadeToOrderStanding>;
export const READ_MADE_TO_ORDER_PRODUCTION_IN = Symbol('content.readMadeToOrderProductionIn');

/**
 * Sends the production job of one take of a recipe or order outside any transaction. The queue keeps
 * one job per recipe, version and take while one is queued or running, so asking twice reaches one job
 * (`already_queued`); once it finished or failed, asking again resumes the same business run.
 */
export type EnqueueScrollProduction = (
  recipe: string,
  take: number,
  priority?: number,
) => Promise<'queued' | 'already_queued'>;
export const ENQUEUE_SCROLL_PRODUCTION = Symbol('content.enqueueScrollProduction');

/**
 * The public pages an exact revision rests on, chosen by code for a what-if of it: its own recorded
 * sources, else those of the Scroll that gives the same explanation, else the library recipe of that
 * explanation. At most three; empty when nothing is known. Never a page a person or a model named.
 */
export type ReadScrollSourcePages = (scope: PersonalScopeTx, root: ContentRef) => Promise<readonly string[]>;
export const READ_SCROLL_SOURCE_PAGES = Symbol('content.readScrollSourcePages');

/** One claim a Scroll cites: its ID in the provenance and the passage text of a public source, as stored. */
export interface ScrollEvidenceClaim {
  readonly claimId: string;
  readonly text: string;
}

/**
 * The claims an exact revision rests on, for a short answer a what-if may cite: those the revision's own provenance
 * records, else those of the admitted Scroll that gives the same explanation (a Reel's twin, a Scroll's other
 * revision). The same Scrolls, under the same review gate, as `ReadScrollSourcePages`. Stored research text only:
 * nothing is fetched. At most 24, in the order the provenance lists them; empty when nothing is known.
 */
export type ReadScrollEvidence = (scope: PersonalScopeTx, root: ContentRef) => Promise<readonly ScrollEvidenceClaim[]>;
export const READ_SCROLL_EVIDENCE = Symbol('content.readScrollEvidence');

/**
 * Port the ordering module implements: which of these Scrolls it ordered may this caller open? Content
 * asks only about assets that have an order, so everything else stays as public as it was. `on` is
 * where to read: a check made inside a personal write reads on that scope's own transaction and never
 * takes a second connection. Read without a lock; whatever changes later re-asks.
 */
export type ReadOrderAudience = (
  on: ReadOn,
  authority: PersonalAuthority,
  assetIds: readonly string[],
) => Promise<ReadonlySet<string>>;
export const READ_ORDER_AUDIENCE = Symbol('content.readOrderAudience');
/** The same port for the Scrolls ordered by a person's question (ask orders): only the person who asked may open one. */
export const READ_ASK_ORDER_AUDIENCE = Symbol('content.readAskOrderAudience');

/**
 * Which of these assets may this caller open, read, act on or see in a list: every asset that is not
 * an order, and an ordered one only if the ordering module says so. Reads on `on` (see
 * `ReadOrderAudience`). The answer is a subset of `assetIds`.
 */
export type CheckAssetAudience = (
  on: ReadOn,
  authority: PersonalAuthority,
  assetIds: readonly string[],
) => Promise<ReadonlySet<string>>;
export const CHECK_ASSET_AUDIENCE = Symbol('content.checkAssetAudience');

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

/** What a sender asks to anchor in an exact revision: untrusted input, checked by `ValidateSnippetAnchor`. */
export type SnippetAnchorInput =
  | { readonly kind: 'reel_range'; readonly startMs: number; readonly endMs: number }
  | {
      readonly kind: 'scroll_passage';
      readonly blockId: string;
      readonly start: number;
      readonly end: number;
      readonly quoteHash: string;
    }
  | {
      readonly kind: 'scroll_block';
      readonly blockId: string;
      readonly blockType: string;
      readonly blockVersion: number;
      /** Settings travel only when the sender included them; personal values also need `confirmPersonal`. */
      readonly settings?: { readonly snapshot: BlockStateSnapshot; readonly confirmPersonal: boolean };
    };

/** A snippet anchor after it was checked, with the text copied from the exact, immutable revision. */
export type StoredSnippetAnchor =
  | { readonly kind: 'reel_range'; readonly startMs: number; readonly endMs: number }
  | {
      readonly kind: 'scroll_passage';
      readonly blockId: string;
      readonly start: number;
      readonly end: number;
      readonly quote: string;
      readonly quoteHash: string;
    }
  | {
      readonly kind: 'scroll_block';
      readonly blockId: string;
      readonly blockType: string;
      readonly blockVersion: number;
      /** The block's own accessible label. */
      readonly label: string;
      readonly settings?: {
        readonly snapshot: BlockStateSnapshot;
        /** Built from the block's own parameter labels, never from sender text. */
        readonly description: string;
      };
    };

export type SnippetValidation =
  | { readonly status: 'valid'; readonly anchor: StoredSnippetAnchor }
  /** A rule failed: range outside the Reel, unknown block, quote that does not match, settings that do not fit. */
  | { readonly status: 'invalid' }
  /** The exact revision is not the current admitted one: withdrawn, missing, corrected or another kind. */
  | { readonly status: 'unavailable' };

/**
 * Port: checks a snippet anchor against the exact revision it names, inside the caller's personal
 * transaction. A Reel range must lie inside the Reel's duration and be at least one second
 * long (it may be as long as the Reel); a passage needs a stable block, a range on grapheme boundaries and the hash of the
 * quote; a block needs its id, type and version and, only when included, a snapshot that fits the
 * block's own parameter declarations (a value the sender entered themselves needs
 * `confirmPersonal`). Only the current revision of an admitted asset can be anchored. It decides
 * nothing about who may share and reads nothing personal.
 */
export type ValidateSnippetAnchor = (
  scope: PersonalScopeTx,
  target: ContentRef,
  anchor: SnippetAnchorInput,
) => Promise<SnippetValidation>;
export const VALIDATE_SNIPPET_ANCHOR = Symbol('content.validateSnippetAnchor');

export interface ContentLocation {
  readonly kind: 'reel' | 'scroll';
  readonly assetId: string;
  readonly assetRevision: number;
}

export type SnippetResolution =
  | { readonly status: 'unavailable' }
  | { readonly status: 'changed'; readonly current: ContentLocation }
  | {
      readonly status: 'ready';
      readonly content: ContentLocation;
      readonly anchor:
        | { readonly kind: 'reel_range'; readonly startMs: number; readonly endMs: number }
        | { readonly kind: 'scroll_passage'; readonly blockId: string; readonly start: number; readonly end: number }
        | { readonly kind: 'scroll_block'; readonly blockId: string; readonly snapshot?: BlockStateSnapshot };
      /** True when a correction moved the anchor through an explicit mapping. */
      readonly mapped: boolean;
      /** True when shared settings no longer fit the block and were dropped. */
      readonly settingsReset: boolean;
    };

/**
 * Port: where a stored snippet leads now. On the revision it was made against it holds as is. After
 * a correction a Scroll anchor is re-pointed only through the explicit anchor map of the two
 * revisions and says so (`mapped`); a Reel range has no time mapping, so a corrected Reel is always
 * `changed`. Never moves a reference silently, never plays or shows the old moment of changed
 * content. Withdrawn or missing content is `unavailable`.
 */
export type ResolveSnippetAnchor = (
  scope: PersonalScopeTx,
  target: ContentRef,
  anchor: StoredSnippetAnchor,
) => Promise<SnippetResolution>;
export const RESOLVE_SNIPPET_ANCHOR = Symbol('content.resolveSnippetAnchor');

/** One episode of a sequence: an exact revision, its format, and its part when the sequence is a declared series. */
export interface SequenceUnit extends ContentRef {
  readonly kind: 'reel' | 'scroll';
  readonly part?: number;
}

/** The sequence an exact revision belongs to: itself alone, or the declared series that contains it, by part. */
export type ContentSequence =
  | { readonly kind: 'single'; readonly unit: SequenceUnit }
  | {
      readonly kind: 'series';
      readonly seriesId: string;
      readonly seriesRevision: number;
      readonly units: readonly (SequenceUnit & { readonly part: number })[];
    };

/**
 * Port: the declared series (latest series revision) that contains this exact revision, if any;
 * otherwise the revision alone. Shared metadata only; a withdrawn unit still has its place and format.
 * `undefined` when the revision does not exist at all.
 */
export type ReadContentSequence = (scope: PersonalScopeTx, root: ContentRef) => Promise<ContentSequence | undefined>;
export const READ_CONTENT_SEQUENCE = Symbol('content.readContentSequence');

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
