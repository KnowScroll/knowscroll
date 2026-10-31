import {
  CHECK_ASSET_AUDIENCE,
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  READ_CONTINUATIONS,
  READ_SERIES_TOTAL,
  RESOLVE_CONTINUITY_LINK,
  READ_ENCOUNTER_ATTRIBUTION,
  type CheckAssetAudience,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
  type ReadContinuations,
  type ReadSeriesTotal,
  type ResolveContinuityLink,
  type ReadEncounterAttribution,
  READ_REGION_ENCOUNTER_CANDIDATES,
  LOCK_REGION_ENCOUNTER_CANDIDATES,
  type ReadRegionEncounterCandidates,
  type LockRegionEncounterCandidates,
} from '../../content/public.js';
import { READ_OWN_REGION_CONSTRAINT, type ReadOwnRegionConstraint } from '../../geography/public.js';
import { REGION_ENCOUNTERS, type ExperienceRecordingEffects } from '../public.js';
import {
  withExperienceScope,
  recordingCommandHooks,
  legacyRecording,
  requireRecordingEffects,
} from './recording-store.js';
import { makeRegionEncounters } from '../application/region-encounter.js';
import { gateExactEncounter } from './audience-gate.js';
import {
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  PURGE_EXPIRED_COMPOSER_BUFFER,
  READ_COMPOSER_BUFFER,
  RELEASE_COMPOSER_BUFFER,
  REQUEST_BUFFER_PREPARATION,
  type ComposeEncounter,
  type PersistComposerDecision,
  type PurgeExpiredComposerBuffer,
  type ReadComposerBuffer,
  type ReadPreparedEvidenceInput,
  type ReleaseComposerBuffer,
  type RequestBufferPreparation,
} from '../../composer/public.js';
import { projectEncounterActivityQueue } from '../../evidence/public.js';
import { READ_COMPOSER_CONTEXT } from '../../personal-context/public.js';
import {
  FENCE_OWN_ACCOUNT,
  READ_RECORDING_LIFECYCLE,
  type ReadRecordingLifecycle,
  type FenceOwnAccount,
  type WithPersonalScope,
} from '../../identity/public.js';
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
import { readNotInterested } from './not-interested-store.js';
import { readRecentExposures } from './resume-store.js';
import { readVisitedAssets } from './visited-assets.js';
import { makeReadResume } from '../application/read-resume.js';
import { insertExposure, markExposureActivated } from './postgres-store.js';
export const NAVIGATION_PORTS = Symbol('experience.navigationPorts');
export const NAVIGATE_ENCOUNTER = Symbol('experience.navigateEncounter');
export const ACTIVATE_OFFER = Symbol('experience.activateOffer');
export const READ_EXPOSURE_CONTEXT = Symbol('experience.readExposureContext');
export const READ_RESUME = Symbol('experience.readResume');
export function navigationProviders(
  t: { readonly withPersonalScope: symbol; readonly enqueueJob: symbol },
  options: {
    readonly region?: boolean;
    readonly recordingEffects?: symbol;
    /** Serve worker-prepared buffers and request the next one on activation (needs `composerBufferProviders`). */
    readonly buffers?: boolean;
  } = {},
) {
  return [
    {
      provide: NAVIGATION_PORTS,
      inject: [
        t.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        READ_RECORDING_LIFECYCLE,
        t.enqueueJob,
        READ_COMPOSER_CONTEXT,
        COMPOSE_ENCOUNTER,
        PERSIST_COMPOSER_DECISION,
        READ_DISCOVERY_CANDIDATES,
        READ_EXACT_ENCOUNTER,
        CHECK_ASSET_AUDIENCE,
        READ_CONTINUATIONS,
        READ_SERIES_TOTAL,
        RESOLVE_CONTINUITY_LINK,
        READ_ENCOUNTER_ATTRIBUTION,
        ...(options.region
          ? [READ_OWN_REGION_CONSTRAINT, READ_REGION_ENCOUNTER_CANDIDATES, LOCK_REGION_ENCOUNTER_CANDIDATES]
          : []),
        ...(options.recordingEffects ? [options.recordingEffects] : []),
        ...(options.buffers
          ? [READ_COMPOSER_BUFFER, RELEASE_COMPOSER_BUFFER, PURGE_EXPIRED_COMPOSER_BUFFER, REQUEST_BUFFER_PREPARATION]
          : []),
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        lifecycle: ReadRecordingLifecycle,
        enqueue: EnqueueJob,
        readPrepared: ReadPreparedEvidenceInput,
        compose: ComposeEncounter,
        persistDecision: PersistComposerDecision,
        readDiscoveryCandidates: ReadDiscoveryCandidates,
        readExactEncounter: ReadExactEncounter,
        audience: CheckAssetAudience,
        readContinuations: ReadContinuations,
        readSeriesTotal: ReadSeriesTotal,
        resolveContinuityLink: ResolveContinuityLink,
        readAttribution: ReadEncounterAttribution,
        ...optional: readonly unknown[]
      ): NavigationPorts => {
        const readRegionConstraint = options.region ? (optional[0] as ReadOwnRegionConstraint) : undefined;
        const readRegionCandidates = options.region ? (optional[1] as ReadRegionEncounterCandidates) : undefined;
        const lockRegionCandidates = options.region ? (optional[2] as LockRegionEncounterCandidates) : undefined;
        const effects = options.recordingEffects
          ? requireRecordingEffects(optional[options.region ? 3 : 0] as ExperienceRecordingEffects | undefined)
          : undefined;
        const bufferOffset = (options.region ? 3 : 0) + (options.recordingEffects ? 1 : 0);
        const buffers = options.buffers
          ? {
              read: optional[bufferOffset] as ReadComposerBuffer,
              release: optional[bufferOffset + 1] as ReleaseComposerBuffer,
              purgeExpired: optional[bufferOffset + 2] as PurgeExpiredComposerBuffer,
              requestPreparation: optional[bufferOffset + 3] as RequestBufferPreparation,
            }
          : undefined;
        return {
          withPersonalScope: withExperienceScope(withPersonalScope, fenceOwn),
          recording: recordingCommandHooks(readAttribution, lifecycle, effects),
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
          readNotInterested,
          readContextBase,
          readPrepared,
          compose,
          persistDecision,
          ...(buffers ? { buffers } : {}),
          readDiscoveryCandidates,
          readExactEncounter: gateExactEncounter(readExactEncounter, audience),
          readContinuations,
          readSeriesTotal,
          resolveContinuityLink,
          readAttribution,
          insertExposure,
          markActivated: markExposureActivated,
          recordActivation: async (scope, id, metadata, offer, originalGeneration) => {
            if (!effects) await recordActivation(scope, id, metadata, lifecycle, offer, originalGeneration);
          },
          enqueueActivity: async (s, id, originalGeneration) => {
            if (options.recordingEffects || !(await legacyRecording(s, originalGeneration, lifecycle))) return;
            await enqueue(s, projectEncounterActivityQueue, {
              v: 1,
              universeId: s.authority.universeId,
              privacyEpoch: s.authority.privacyEpoch,
              exposureId: id,
            });
          },
          advanceRevision: advanceScopeRevision,
          notify: notifyScopeChanged,
          findReceipt: findPersonalReceipt,
          insertReceipt: insertPersonalReceipt,
          completeReceipt: completePersonalReceipt,
          hashRequest: requestHash,
          newId: () => uuidv7(),
          now: () => new Date(),
        };
      },
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
    {
      provide: READ_RESUME,
      inject: [NAVIGATION_PORTS],
      useFactory: (p: NavigationPorts) => makeReadResume({ ...p, readRecentExposures, readVisitedAssets }),
    },
  ];
}
