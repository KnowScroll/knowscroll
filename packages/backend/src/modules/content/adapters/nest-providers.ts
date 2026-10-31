import { lockKeepPositionTarget } from './keep-position-target.js';
import { LOCK_KEEP_POSITION_TARGET } from '../public.js';
import { lockCurrentEncounters } from './current-encounters.js';
import { LOCK_CURRENT_ENCOUNTERS } from '../public.js';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeImportEditorialScroll } from '../application/import-editorial-scroll.js';
import { makeEnqueueScrollProduction } from './enqueue-production.js';
import {
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  READ_CONTINUATIONS,
  READ_SERIES_TOTAL,
  RESOLVE_CONTINUITY_LINK,
  READ_ENCOUNTER_TOPICS,
  READ_SAVED_METADATA,
  READ_SAVED_PAGE_METADATA,
  READ_PUBLIC_CONTENT,
  READ_SHAREABLE_CONTENT,
  READ_CONTENT_SEQUENCE,
  VALIDATE_SNIPPET_ANCHOR,
  RESOLVE_SNIPPET_ANCHOR,
  READ_ENCOUNTER_ATTRIBUTION,
  FIND_ASSET_FOR_ACTION,
  FIND_OPENABLE_ASSET,
  READ_SCROLL_READING_FACTS,
  READ_SCROLL_PLAY_FACTS,
  READ_ADMITTED_COVERAGE_MAPPING,
  LOCK_CURRENT_COVERAGE_AUTHORITIES,
  READ_REGION_ENCOUNTER_CANDIDATES,
  LOCK_REGION_ENCOUNTER_CANDIDATES,
  RENDER_SCROLL,
  CHOOSE_SCROLL_RECIPE,
  READ_SCROLL_PRODUCTION,
  RECORD_MADE_TO_ORDER_SCROLL,
  READ_MADE_TO_ORDER_PRODUCTION,
  READ_SCROLL_SOURCE_PAGES,
  CHECK_ASSET_AUDIENCE,
  ENQUEUE_SCROLL_PRODUCTION,
  READ_PLAY_LEVEL,
  READ_LIBRARY_PASSAGES,
  READ_LIBRARY_PASSAGE_TEXT,
  type CheckAssetAudience,
  type EnqueueScrollProduction,
  type ReadMadeToOrderProduction,
  type ReadOrderAudience,
  type RenderScroll,
} from '../public.js';
import {
  readDiscoveryCandidates,
  readExactEncounter,
  readContinuations,
  resolveContinuityLink,
  readEncounterTopics,
  readSavedMetadata,
  readSavedPageMetadata,
  readEncounterAttribution,
  readPlayLevel,
} from './discovery-store.js';
import { makeRenderScroll } from './render-scroll.js';
import { readScrollPlayFacts } from './scroll-play-facts.js';
import { makeReadPublicContent, readShareableContent } from './shareable-content.js';
import { compileEditorialSource, parseEditorialSource } from './scroll-compiler.js';
import { findAssetForAction, findOpenableAsset, makeAdmissionStore, readScrollReadingFacts } from './postgres-store.js';
import {
  makeCheckAssetAudience,
  makeReadMadeToOrderProduction,
  readScrollSourcePages,
  recordMadeToOrderScroll,
} from './made-to-order.js';
import { readAdmittedCoverageMapping, lockCurrentCoverageAuthorities } from './coverage-store.js';
import { readContentSequence, readSeriesTotal } from './content-sequence.js';
import { resolveSnippetAnchor, validateSnippetAnchor } from './snippet-anchors.js';
import { chooseScrollRecipe, readScrollProduction } from './production-state.js';
import { readRegionEncounterCandidates, lockRegionEncounterCandidates } from './region-candidates.js';
import { makeReadLibraryPassages, makeReadLibraryPassageText } from './library-passages.js';

/**
 * Reusable outer wiring (blueprint §22): content's scope-bound read ports, used inside a personal
 * transaction by experience and evidence. Composition roots only.
 */
export function contentProviders() {
  return [
    { provide: READ_REGION_ENCOUNTER_CANDIDATES, useValue: readRegionEncounterCandidates },
    { provide: LOCK_REGION_ENCOUNTER_CANDIDATES, useValue: lockRegionEncounterCandidates },
    { provide: LOCK_KEEP_POSITION_TARGET, useValue: lockKeepPositionTarget },
    { provide: LOCK_CURRENT_ENCOUNTERS, useValue: lockCurrentEncounters },
    { provide: READ_DISCOVERY_CANDIDATES, useValue: readDiscoveryCandidates },
    { provide: READ_EXACT_ENCOUNTER, useValue: readExactEncounter },
    { provide: READ_CONTINUATIONS, useValue: readContinuations },
    { provide: READ_SERIES_TOTAL, useValue: readSeriesTotal },
    { provide: RESOLVE_CONTINUITY_LINK, useValue: resolveContinuityLink },
    { provide: READ_ENCOUNTER_TOPICS, useValue: readEncounterTopics },
    { provide: READ_SAVED_METADATA, useValue: readSavedMetadata },
    { provide: READ_SAVED_PAGE_METADATA, useValue: readSavedPageMetadata },
    { provide: READ_SHAREABLE_CONTENT, useValue: readShareableContent },
    { provide: READ_CONTENT_SEQUENCE, useValue: readContentSequence },
    { provide: VALIDATE_SNIPPET_ANCHOR, useValue: validateSnippetAnchor },
    { provide: RESOLVE_SNIPPET_ANCHOR, useValue: resolveSnippetAnchor },
    { provide: READ_ENCOUNTER_ATTRIBUTION, useValue: readEncounterAttribution },
    { provide: READ_PLAY_LEVEL, useValue: readPlayLevel },
    { provide: FIND_ASSET_FOR_ACTION, useValue: findAssetForAction },
    { provide: FIND_OPENABLE_ASSET, useValue: findOpenableAsset },
    { provide: RECORD_MADE_TO_ORDER_SCROLL, useValue: recordMadeToOrderScroll },
    { provide: READ_SCROLL_SOURCE_PAGES, useValue: readScrollSourcePages },
    { provide: READ_SCROLL_READING_FACTS, useValue: readScrollReadingFacts },
    { provide: READ_SCROLL_PLAY_FACTS, useValue: readScrollPlayFacts },
    { provide: READ_ADMITTED_COVERAGE_MAPPING, useValue: readAdmittedCoverageMapping },
    { provide: LOCK_CURRENT_COVERAGE_AUTHORITIES, useValue: lockCurrentCoverageAuthorities },
    { provide: CHOOSE_SCROLL_RECIPE, useValue: chooseScrollRecipe },
    { provide: READ_SCROLL_PRODUCTION, useValue: readScrollProduction },
  ];
}

/** The audience of an order when no module claims it: nobody. */
const denyOrderAudience: ReadOrderAudience = () => Promise.resolve(new Set());

/**
 * Reads of Scrolls ordered from code that need the database handle: where an order's production
 * stands (the resolver, in the worker) and whether a caller may read an asset (the API's document
 * read). `orderAudience` names the token of the module that orders Scrolls.
 */
export function madeToOrderProviders(tokens: { readonly database: symbol; readonly orderAudience?: symbol }) {
  return [
    {
      provide: READ_MADE_TO_ORDER_PRODUCTION,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): ReadMadeToOrderProduction => makeReadMadeToOrderProduction(db),
    },
    {
      provide: CHECK_ASSET_AUDIENCE,
      inject: [tokens.database, ...(tokens.orderAudience === undefined ? [] : [tokens.orderAudience])],
      useFactory: (db: Kysely<Database>, audience?: ReadOrderAudience): CheckAssetAudience =>
        makeCheckAssetAudience(db, audience ?? denyOrderAudience),
    },
  ];
}

/**
 * The library's prose for a room's daily items (v3 R-5): the Scrolls under a topic, and one block's text on the exact current
 * revision. Shared public content read on the pool with no personal scope, for the worker and the operator.
 */
export function libraryPassageProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: READ_LIBRARY_PASSAGES,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeReadLibraryPassages(db),
    },
    {
      provide: READ_LIBRARY_PASSAGE_TEXT,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeReadLibraryPassageText(db),
    },
  ];
}

/** The sender of production jobs outside a transaction, over the process's pg-boss (the branch resolver, the operator). */
export function scrollProductionSenderProviders(tokens: { readonly boss: symbol }) {
  return [
    {
      provide: ENQUEUE_SCROLL_PRODUCTION,
      inject: [tokens.boss],
      useFactory: (boss: PgBoss): EnqueueScrollProduction => makeEnqueueScrollProduction(boss),
    },
  ];
}

/** `renderScroll` for the API's composition root: reads the shared document outside any transaction. */
export function contentRenderProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: RENDER_SCROLL,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): RenderScroll => makeRenderScroll(db),
    },
    {
      provide: READ_PUBLIC_CONTENT,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>) => makeReadPublicContent(db),
    },
  ];
}

/**
 * The operator command's use case (`dist/operator.js content import-editorial`): admits an authored
 * editorial Scroll over its own database handle. Re-exported by the API's `modules/content.ts`,
 * because only composition roots choose concrete implementations.
 */
export function importEditorialScrollUseCase(db: Kysely<Database>) {
  return makeImportEditorialScroll({
    parseSource: parseEditorialSource,
    compile: compileEditorialSource,
    ...makeAdmissionStore(db),
  });
}

export { makeReadLibraryPassages, makeReadLibraryPassageText } from './library-passages.js';
export { makeCutroomReelImporter, type CutroomImportSettings } from './import-cutroom-reel.js';
export { makeMediaAccess } from './media-access.js';

/** Composition-only factory for the worker's bounded, nonpersonal Scroll operator. */
export { makeProduceScroll as produceScrollUseCase } from '../production/produce.js';
/** The operator's writer spike for `scroll-authoring.v2` (S-0, D-120): nothing is admitted or published. */
export {
  makeWriterSpikeV2,
  runSpikeBatch,
  SPIKE_MAX_CONCURRENCY,
  SPIKE_MODEL,
  type SpikeBatchSummary,
  type SpikeLine,
  type SpikeResult,
} from '../production/spike-v2/run.js';
export { parseSpikeTopics, SPIKE_TOPICS_V2 } from '../production/spike-v2/topics.js';
/** The job one `content.produce-scroll` delivery runs, and the operator's enqueue and status reads. */
export { makeRunScrollProduction } from '../production/job.js';
export { makeEnqueueScrollProduction } from './enqueue-production.js';
export { readLibraryStatus } from './production-state.js';
/** The operator's review gate for library v2 Scrolls: list, show, release, reject (D-138). */
export { makeReviewGate, recipeKeyOfAsset, type ReviewGate } from './review-gate.js';
/** Bounded shared retrieval capabilities; no feature consumers are installed by this slice. */
export {
  readEncounterAttribution,
  readPlayLevel,
  readDiscoveryCandidates,
  readExactEncounter,
  readContinuations,
  resolveContinuityLink,
  readEncounterTopics,
  readSavedMetadata,
} from './discovery-store.js';
export { admitContinuity } from './continuity-admission.js';
/** The operator's `content admit-continuity`: the library plan's series and related moves. */
export { admitLibraryContinuityUseCase } from './library-continuity.js';
export { makeAdmissionStore } from './postgres-store.js';
/** Trusted composition/CI fixture seam only. Never bind its approval callback to request input. */
export {
  coverageAdmissionUseCase,
  makeCoverageAdmissionPorts,
  coverageCatalogue,
  readAdmittedCoverageMapping,
  makeReadAdmittedCoverageMapping,
  coverageHeadPorts,
  lockCurrentCoverageAuthorities,
} from './coverage-store.js';
/** The operator's `content readmit-coverage`; decides generated Scrolls' coverage again from the plan. */
export { readmitCoverageUseCase } from './readmit-coverage.js';
export { readmitRecipeCoverage } from '../application/readmit-recipe-coverage.js';
export { makeAdmitCoverage } from '../application/admit-coverage.js';

export { lockCurrentEncounters } from './current-encounters.js';
export {
  readRegionEncounterCandidates,
  lockRegionEncounterCandidates,
  contentRegionStores,
} from './region-candidates.js';

export { lockKeepPositionTarget } from './keep-position-target.js';

export { readSavedPageMetadata } from './discovery-store.js';
export { makeReadPublicContent, readShareableContent } from './shareable-content.js';
export { readContentSequence } from './content-sequence.js';
export { readScrollPlayFacts } from './scroll-play-facts.js';
export { resolveSnippetAnchor, validateSnippetAnchor } from './snippet-anchors.js';

/** The operator's Reel commands over real adapters (#240, D-041). */
export { checkShippedReelScript, composeReelOperator, type ReelSettings } from './reel/compose.js';
export { contentReelStores } from './reel/stores.js';
export type { ReelOperator } from '../application/reel/operator.js';
