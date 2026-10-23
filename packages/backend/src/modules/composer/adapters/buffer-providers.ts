import type { WorkerConfig } from '../../../infrastructure/config/index.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { REASONING_HARNESS, type ReasoningHarness } from '../../../reasoning/public.js';
import {
  READ_DISCOVERY_CANDIDATES,
  READ_EXACT_ENCOUNTER,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
} from '../../content/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import { READ_COMPOSER_CONTEXT } from '../../personal-context/public.js';
import { makeAssessShortlist } from '../application/jev.js';
import { makePrepareBuffer, type PrepareBuffer } from '../application/prepare-buffer.js';
import type {
  ComposeEncounter,
  PersistComposerDecision,
  ReadBufferSource,
  ReadHiddenAssets,
  ReadPreparedEvidenceInput,
  RequestBufferPreparation,
} from '../application/ports.js';
import { prepareBufferQueue } from '../events.js';
import {
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  PREPARE_COMPOSER_BUFFER,
  READ_BUFFER_SOURCE,
  READ_COMPOSER_BUFFER,
  READ_HIDDEN_ASSETS,
  RELEASE_COMPOSER_BUFFER,
  REQUEST_BUFFER_PREPARATION,
} from '../public.js';
import { composerBufferStore } from './buffer-store.js';

/** The API's side: serve and release a buffer, and ask for the next one in the activating transaction. */
export function composerBufferProviders(t: { readonly enqueueJob: symbol }) {
  return [
    { provide: READ_COMPOSER_BUFFER, useValue: composerBufferStore.read },
    { provide: RELEASE_COMPOSER_BUFFER, useValue: composerBufferStore.release },
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

/** The reasoning harness refuses with this fixed message when the run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

/** The worker's side: the `composer.prepare-buffer` use case. Jev is built only when `KS_JEV_ENABLED=1`. */
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
        REASONING_HARNESS,
        READ_BUFFER_SOURCE,
        READ_HIDDEN_ASSETS,
        READ_EXACT_ENCOUNTER,
        READ_DISCOVERY_CANDIDATES,
        READ_COMPOSER_CONTEXT,
        PERSIST_COMPOSER_DECISION,
        COMPOSE_ENCOUNTER,
      ],
      useFactory: (
        withPersonalScope: WithPersonalScope,
        config: WorkerConfig,
        harness: ReasoningHarness,
        readSource: ReadBufferSource,
        readHidden: ReadHiddenAssets,
        readExactEncounter: ReadExactEncounter,
        readDiscoveryCandidates: ReadDiscoveryCandidates,
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
                  model: config.reasoning.minimax?.model ?? 'none',
                  closeRun: async (scope, runId, state) => {
                    try {
                      await harness.closeRun(scope, { runId, state });
                    } catch (error) {
                      if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
                    }
                  },
                },
              }
            : {}),
        }),
    },
  ];
}
