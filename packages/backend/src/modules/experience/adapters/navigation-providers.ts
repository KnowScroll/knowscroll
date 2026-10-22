import {
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  READ_CONTINUATIONS,
  RESOLVE_CONTINUITY_LINK,
  READ_ENCOUNTER_ATTRIBUTION,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
  type ReadContinuations,
  type ResolveContinuityLink,
  type ReadEncounterAttribution,
  READ_REGION_ENCOUNTER_CANDIDATES,
  LOCK_REGION_ENCOUNTER_CANDIDATES,
  type ReadRegionEncounterCandidates,
  type LockRegionEncounterCandidates,
} from '../../content/public.js';
import { READ_OWN_REGION_CONSTRAINT, type ReadOwnRegionConstraint } from '../../geography/public.js';
import { REGION_ENCOUNTERS } from '../public.js';
import { makeRegionEncounters } from '../application/region-encounter.js';
import {
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  type ComposeEncounter,
  type PersistComposerDecision,
  type ReadPreparedEvidenceInput,
} from '../../composer/public.js';
import { projectEncounterActivityQueue } from '../../evidence/public.js';
import { READ_COMPOSER_CONTEXT } from '../../personal-context/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
} from '../../../infrastructure/receipts/index.js';
import type { NavigationPorts } from '../application/navigation-ports.js';
import { makeActivateOffer, makeNavigateEncounter, makeReadExposureContext } from '../application/navigation.js';
import {
  bindOffer,
  insertOffers,
  readContextBase,
  readHidden,
  readMember,
  readOffer,
  readOwnedOffers,
  readSession,
  recordActivation,
  writeSession,
} from './navigation-store.js';
import { insertExposure, markExposureActivated } from './postgres-store.js';
export const NAVIGATION_PORTS = Symbol('experience.navigationPorts');
export const NAVIGATE_ENCOUNTER = Symbol('experience.navigateEncounter');
export const ACTIVATE_OFFER = Symbol('experience.activateOffer');
export const READ_EXPOSURE_CONTEXT = Symbol('experience.readExposureContext');
export function navigationProviders(
  t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol },
  options: { readonly region?: boolean } = {},
) {
  return [
    {
      provide: NAVIGATION_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        READ_COMPOSER_CONTEXT,
        COMPOSE_ENCOUNTER,
        PERSIST_COMPOSER_DECISION,
        READ_DISCOVERY_CANDIDATES,
        READ_EXACT_ENCOUNTER,
        READ_CONTINUATIONS,
        RESOLVE_CONTINUITY_LINK,
        READ_ENCOUNTER_ATTRIBUTION,
        ...(options.region
          ? [READ_OWN_REGION_CONSTRAINT, READ_REGION_ENCOUNTER_CANDIDATES, LOCK_REGION_ENCOUNTER_CANDIDATES]
          : []),
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        enqueue: EnqueueJob,
        readPrepared: ReadPreparedEvidenceInput,
        compose: ComposeEncounter,
        persistDecision: PersistComposerDecision,
        readDiscoveryCandidates: ReadDiscoveryCandidates,
        readExactEncounter: ReadExactEncounter,
        readContinuations: ReadContinuations,
        resolveContinuityLink: ResolveContinuityLink,
        readAttribution: ReadEncounterAttribution,
        readRegionConstraint?: ReadOwnRegionConstraint,
        readRegionCandidates?: ReadRegionEncounterCandidates,
        lockRegionCandidates?: LockRegionEncounterCandidates,
      ): NavigationPorts => ({
        withPersonalScope,
        // Explicitly unmounted legacy composition cannot inherit/activate a regional offer.
        // The API opts in to all three actual owning ports together; there is no broad fallback.
        readRegionConstraint: readRegionConstraint ?? (() => Promise.resolve({ kind: 'refused' })),
        readRegionCandidates: readRegionCandidates ?? (() => Promise.resolve({ kind: 'unsupported' })),
        lockRegionCandidates: lockRegionCandidates ?? (() => Promise.resolve(false)),
        readSession,
        writeSession,
        readOffer,
        readOwnedOffers,
        readMember,
        insertOffers,
        bindOffer,
        readHidden,
        readContextBase,
        readPrepared,
        compose,
        persistDecision,
        readDiscoveryCandidates,
        readExactEncounter,
        readContinuations,
        resolveContinuityLink,
        readAttribution,
        insertExposure,
        markActivated: markExposureActivated,
        recordActivation,
        enqueueActivity: (s, id) =>
          enqueue(s, projectEncounterActivityQueue, {
            v: 1,
            universeId: s.authority.universeId,
            privacyEpoch: s.authority.privacyEpoch,
            exposureId: id,
          }),
        advanceRevision: advanceScopeRevision,
        notify: notifyScopeChanged,
        findReceipt: findPersonalReceipt,
        insertReceipt: insertPersonalReceipt,
        completeReceipt: completePersonalReceipt,
        hashRequest: requestHash,
        newId: () => uuidv7(),
        now: () => new Date(),
      }),
    },
    {
      provide: REGION_ENCOUNTERS,
      inject: [NAVIGATION_PORTS, NAVIGATE_ENCOUNTER],
      useFactory: (p: NavigationPorts, navigate: ReturnType<typeof makeNavigateEncounter>) =>
        makeRegionEncounters(p, navigate),
    },
    {
      provide: NAVIGATE_ENCOUNTER,
      inject: [NAVIGATION_PORTS],
      useFactory: (p: NavigationPorts) => makeNavigateEncounter(p),
    },
    { provide: ACTIVATE_OFFER, inject: [NAVIGATION_PORTS], useFactory: (p: NavigationPorts) => makeActivateOffer(p) },
    {
      provide: READ_EXPOSURE_CONTEXT,
      inject: [NAVIGATION_PORTS],
      useFactory: (p: NavigationPorts) => makeReadExposureContext(p),
    },
  ];
}
