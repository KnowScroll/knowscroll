import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import {
  CHECK_COMPOSER_RECORDING_RUN,
  RECORDING_REASONING_HARNESS,
  type CheckPersonalRecordingRun,
  type RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import {
  READ_CONTINUATIONS,
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  type ReadContinuations,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
} from '../../content/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import { READ_COMPOSER_CONTEXT } from '../../personal-context/public.js';
import { makeCheckComposerRecordingRun } from '../application/check-recording-run.js';
import { makeAssessShortlist } from '../application/jev.js';
import { makePrepareBuffer, type PrepareBuffer } from '../application/prepare-buffer.js';
import type {
  CheckActivatedExposure,
  ComposeEncounter,
  PersistComposerDecision,
  ReadBufferSource,
  ReadHiddenAssets,
  ReadPreparedEvidenceInput,
  RequestBufferPreparation,
} from '../application/ports.js';
import { prepareBufferQueue } from '../events.js';
import {
  CHECK_ACTIVATED_EXPOSURE,
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  PREPARE_COMPOSER_BUFFER,
  READ_BUFFER_SOURCE,
  READ_COMPOSER_BUFFER,
  PURGE_EXPIRED_COMPOSER_BUFFER,
  READ_HIDDEN_ASSETS,
  RELEASE_COMPOSER_BUFFER,
  REQUEST_BUFFER_PREPARATION,
} from '../public.js';
import { composerBufferStore } from './buffer-store.js';
import { jevPoolStore } from './jev-pool-store.js';

/** The API's side: serve and release a buffer, and ask for the next one in the activating transaction. */
export function composerBufferProviders(t: { readonly enqueueJob: symbol }) {
  return [
    { provide: READ_COMPOSER_BUFFER, useValue: composerBufferStore.read },
    { provide: RELEASE_COMPOSER_BUFFER, useValue: composerBufferStore.release },
    { provide: PURGE_EXPIRED_COMPOSER_BUFFER, useValue: composerBufferStore.purgeExpired },
    {
      provide: REQUEST_BUFFER_PREPARATION,
      inject: [t.enqueueJob],
      useFactory:
        (enqueue: EnqueueJob): RequestBufferPreparation =>
        (scope, key) =>
          enqueue(scope, prepareBufferQueue, {
            v: 1,
            universeId: scope.authority.universeId,
            privacyEpoch: scope.authority.privacyEpoch,
            sessionId: key.sessionId,
            intentRevision: key.intentRevision,
            sourceOfferId: key.source.offerId,
            sourceExposureId: key.source.exposureId,
          }),
    },
  ];
}

/**
 * The owner check the recording-aware harness runs for Jev's personal runs (D-268): the exposure a buffer job was made for must
 * still be an activated one. Installed wherever the recording harness is (the worker), because the harness cannot be built without
 * it; it needs Experience's `CHECK_ACTIVATED_EXPOSURE`.
 */
export function composerRecordingOwnerProviders() {
  return [
    {
      provide: CHECK_COMPOSER_RECORDING_RUN,
      inject: [CHECK_ACTIVATED_EXPOSURE],
      useFactory: (exposureActivated: CheckActivatedExposure): CheckPersonalRecordingRun =>
        makeCheckComposerRecordingRun({ exposureActivated }),
    },
  ];
}

/**
 * The worker's side: the `composer.prepare-buffer` use case. Jev is built only when `KS_JEV_ENABLED=1`, and runs on the
 * recording-aware harness (D-268).
 */
export function composerBufferWorkerProviders(t: {
  readonly withPersonalScope: symbol;
  readonly workerConfig: symbol;
}) {
  return [
    {
      provide: PREPARE_COMPOSER_BUFFER,
      inject: [
        t.withPersonalScope,
        t.workerConfig,
        RECORDING_REASONING_HARNESS,
        READ_BUFFER_SOURCE,
        READ_HIDDEN_ASSETS,
        READ_EXACT_ENCOUNTER,
        READ_DISCOVERY_CANDIDATES,
        READ_CONTINUATIONS,
        READ_COMPOSER_CONTEXT,
        PERSIST_COMPOSER_DECISION,
        COMPOSE_ENCOUNTER,
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        config: WorkerConfig,
        harness: RecordingReasoningHarness,
        readSource: ReadBufferSource,
        readHidden: ReadHiddenAssets,
        readExactEncounter: ReadExactEncounter,
        readDiscoveryCandidates: ReadDiscoveryCandidates,
        readContinuations: ReadContinuations,
        readPrepared: ReadPreparedEvidenceInput,
        persistDecision: PersistComposerDecision,
        compose: ComposeEncounter,
      ): PrepareBuffer =>
        makePrepareBuffer({
          withPersonalScope,
          readSource,
          readHidden,
          readExactEncounter,
          readDiscoveryCandidates,
          readContinuations,
          readPrepared,
          readBuffer: composerBufferStore.read,
          storeBuffer: composerBufferStore.store,
          persistDecision,
          compose,
          hashCatalogWatermarks: (watermarks) => requestHash('content-candidate-watermarks', [...watermarks]),
          newId: () => uuidv7(),
          now: () => new Date(),
          ...(config.jevEnabled
            ? {
                jev: {
                  assess: makeAssessShortlist(harness),
                  harness,
                  model: config.reasoning.minimax?.model ?? 'none',
                  readPool: jevPoolStore.read,
                  storePool: jevPoolStore.store,
                },
              }
            : {}),
        }),
    },
  ];
}
