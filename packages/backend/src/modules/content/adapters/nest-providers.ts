import type { CutroomBusinessLock } from '../../../reasoning/public.js';
import { postgresCommissionStore } from './postgres-commission-store.js';
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
  READ_ENCOUNTER_ATTRIBUTION,
  FIND_ASSET_FOR_ACTION,
  FIND_OPENABLE_ASSET,
  READ_SCROLL_READING_FACTS,
  READ_ADMITTED_COVERAGE_MAPPING,
  LOCK_CURRENT_COVERAGE_AUTHORITIES,
  READ_REGION_ENCOUNTER_CANDIDATES,
  LOCK_REGION_ENCOUNTER_CANDIDATES,
  RENDER_SCROLL,
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
import { compileEditorialSource, parseEditorialSource } from './scroll-compiler.js';
import { findAssetForAction, findOpenableAsset, makeAdmissionStore, readScrollReadingFacts } from './postgres-store.js';
import { readAdmittedCoverageMapping, lockCurrentCoverageAuthorities } from './coverage-store.js';
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
    { provide: READ_ENCOUNTER_ATTRIBUTION, useValue: readEncounterAttribution },
    { provide: FIND_ASSET_FOR_ACTION, useValue: findAssetForAction },
    { provide: FIND_OPENABLE_ASSET, useValue: findOpenableAsset },
    { provide: READ_SCROLL_READING_FACTS, useValue: readScrollReadingFacts },
    { provide: READ_ADMITTED_COVERAGE_MAPPING, useValue: readAdmittedCoverageMapping },
    { provide: LOCK_CURRENT_COVERAGE_AUTHORITIES, useValue: lockCurrentCoverageAuthorities },
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
  lockCurrentCoverageAuthorities,
} from './coverage-store.js';
export { makeAdmitCoverage } from '../application/admit-coverage.js';

export { lockCurrentEncounters } from './current-encounters.js';
export {
  readRegionEncounterCandidates,
  lockRegionEncounterCandidates,
  contentRegionStores,
} from './region-candidates.js';

export { lockKeepPositionTarget } from './keep-position-target.js';

export { makeCommission } from '../production/commission.js';
export { postgresCommissionStore };
/** Optional public-business lock adapter, used only by explicit Cutroom B composition. */
export const lockCommissionBusiness: CutroomBusinessLock = async (scope, id) =>
  (await postgresCommissionStore.lock(scope, id)) !== undefined;

/** C1 optional/default-deny review assembly; no normal provider or trusted corpus/approval seed. */
export { makeCommissionReview } from '../production/commission-review.js';
export { postgresCommissionReview } from './postgres-commission-review.js';

/** Optional GET-only collector assembly; no normal resource/worker binding. */
export { makeCutroomChainCollector } from './cutroom/chain-reader.js';

/** Optional evidence-only chain durability assembly; no normal resource/worker binding. */
export { makeCutroomChainSnapshotCollector } from './cutroom/chain-reader.js';
export { makeCommissionChainSnapshots } from '../production/commission-chain-store.js';
export { postgresCommissionChainStore } from './postgres-commission-chain.js';

export { readSavedPageMetadata } from './discovery-store.js';

/** Connected commissioning: source gates stay off unless the operator supplies every real dependency. */
export { makeCommissioning } from '../production/commissioning.js';
export { makeCommissionedReelImporter } from './import-commissioned-reel.js';
export { makeCutroomSubmitClient } from './cutroom/submit-client.js';
export { makeReelCorpusImporter } from './reel-corpus-import.js';
export { contentCutroomStores, contentCutroomNonRowStores } from './cutroom-store-inventory.js';

export { financialReportOfSnapshot } from '../production/commission-publication.js';
export { makeCommissionMedia } from './cutroom/commission-media.js';

export { makeCommissionPreparation } from '../production/commission-review.js';
export { makeCommissionReceive } from '../production/commission-receive.js';
export { postgresCommissionReceive, postgresCommissionReceiveOrigin } from './postgres-commission-receive.js';
export { makeReceiveMedia } from './cutroom/receive-media.js';
