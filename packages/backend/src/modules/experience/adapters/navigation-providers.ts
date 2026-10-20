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
} from '../../content/public.js';
import {
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  type ComposeEncounter,
  type PersistComposerDecision,
  type ReadPreparedEvidenceInput,
} from '../../composer/public.js';
import { READ_PREPARED_ACTIVITY, projectEncounterActivityQueue } from '../../evidence/public.js';
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
  readSession,
  recordActivation,
  writeSession,
} from './navigation-store.js';
import { insertExposure, markExposureActivated } from './postgres-store.js';
export const NAVIGATION_PORTS = Symbol('experience.navigationPorts');
export const NAVIGATE_ENCOUNTER = Symbol('experience.navigateEncounter');
export const ACTIVATE_OFFER = Symbol('experience.activateOffer');
export const READ_EXPOSURE_CONTEXT = Symbol('experience.readExposureContext');
export function navigationProviders(t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol }) {
  return [
    {
      provide: NAVIGATION_PORTS,
      inject: [
        t.withPersonalScope,
        t.enqueueJob,
        READ_PREPARED_ACTIVITY,
        COMPOSE_ENCOUNTER,
        PERSIST_COMPOSER_DECISION,
        READ_DISCOVERY_CANDIDATES,
        READ_EXACT_ENCOUNTER,
        READ_CONTINUATIONS,
        RESOLVE_CONTINUITY_LINK,
        READ_ENCOUNTER_ATTRIBUTION,
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
      ): NavigationPorts => ({
        withPersonalScope,
        readSession,
        writeSession,
        readOffer,
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
