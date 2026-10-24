import { lockKeepPositionTarget } from './keep-position-target.js';
import { LOCK_KEEP_POSITION_TARGET } from '../public.js';
import { lockCurrentEncounters } from './current-encounters.js';
import { LOCK_CURRENT_ENCOUNTERS } from '../public.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeImportEditorialScroll } from '../application/import-editorial-scroll.js';
import {
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  READ_CONTINUATIONS,
  RESOLVE_CONTINUITY_LINK,
  READ_ENCOUNTER_TOPICS,
  READ_SAVED_METADATA,
  READ_SAVED_PAGE_METADATA,
  READ_PUBLIC_CONTENT,
  READ_SHAREABLE_CONTENT,
  READ_ENCOUNTER_ATTRIBUTION,
  FIND_ASSET_FOR_ACTION,
  FIND_OPENABLE_ASSET,
  READ_SCROLL_READING_FACTS,
  READ_ADMITTED_COVERAGE_MAPPING,
  LOCK_CURRENT_COVERAGE_AUTHORITIES,
  READ_REGION_ENCOUNTER_CANDIDATES,
  LOCK_REGION_ENCOUNTER_CANDIDATES,
  RENDER_SCROLL,
  CHOOSE_SCROLL_RECIPE,
  READ_SCROLL_PRODUCTION,
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
} from './discovery-store.js';
import { makeRenderScroll } from './render-scroll.js';
import { makeReadPublicContent, readShareableContent } from './shareable-content.js';
import { compileEditorialSource, parseEditorialSource } from './scroll-compiler.js';
import { findAssetForAction, findOpenableAsset, makeAdmissionStore, readScrollReadingFacts } from './postgres-store.js';
import { readAdmittedCoverageMapping, lockCurrentCoverageAuthorities } from './coverage-store.js';
import { chooseScrollRecipe, readScrollProduction } from './production-state.js';
import { readRegionEncounterCandidates, lockRegionEncounterCandidates } from './region-candidates.js';

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
    { provide: RESOLVE_CONTINUITY_LINK, useValue: resolveContinuityLink },
    { provide: READ_ENCOUNTER_TOPICS, useValue: readEncounterTopics },
    { provide: READ_SAVED_METADATA, useValue: readSavedMetadata },
    { provide: READ_SAVED_PAGE_METADATA, useValue: readSavedPageMetadata },
    { provide: READ_SHAREABLE_CONTENT, useValue: readShareableContent },
    { provide: READ_ENCOUNTER_ATTRIBUTION, useValue: readEncounterAttribution },
    { provide: FIND_ASSET_FOR_ACTION, useValue: findAssetForAction },
    { provide: FIND_OPENABLE_ASSET, useValue: findOpenableAsset },
    { provide: READ_SCROLL_READING_FACTS, useValue: readScrollReadingFacts },
    { provide: READ_ADMITTED_COVERAGE_MAPPING, useValue: readAdmittedCoverageMapping },
    { provide: LOCK_CURRENT_COVERAGE_AUTHORITIES, useValue: lockCurrentCoverageAuthorities },
    { provide: CHOOSE_SCROLL_RECIPE, useValue: chooseScrollRecipe },
    { provide: READ_SCROLL_PRODUCTION, useValue: readScrollProduction },
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

export { makeCutroomReelImporter, type CutroomImportSettings } from './import-cutroom-reel.js';
export { makeMediaAccess } from './media-access.js';

/** Composition-only factory for the worker's bounded, nonpersonal Scroll operator. */
export { makeProduceScroll as produceScrollUseCase } from '../production/produce.js';
/** The job one `content.produce-scroll` delivery runs, and the operator's enqueue and status reads. */
export { makeRunScrollProduction } from '../production/job.js';
export { makeEnqueueScrollProduction, type EnqueueScrollProduction } from './enqueue-production.js';
export { readLibraryStatus } from './production-state.js';
/** Bounded shared retrieval capabilities; no feature consumers are installed by this slice. */
export {
  readEncounterAttribution,
  readDiscoveryCandidates,
  readExactEncounter,
  readContinuations,
  resolveContinuityLink,
  readEncounterTopics,
  readSavedMetadata,
} from './discovery-store.js';
export { admitContinuity } from './continuity-admission.js';
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

/** The operator's Reel commands over real adapters (#240, D-041). */
export { checkShippedReelScript, composeReelOperator, type ReelSettings } from './reel/compose.js';
export { contentReelStores } from './reel/stores.js';
export type { ReelOperator } from '../application/reel/operator.js';
