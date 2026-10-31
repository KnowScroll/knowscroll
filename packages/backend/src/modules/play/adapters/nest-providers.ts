import {
  READ_ENCOUNTER_TOPICS,
  READ_SCROLL_PLAY_FACTS,
  type ReadEncounterTopics,
  type ReadScrollPlayFacts,
} from '../../content/public.js';
import { HAS_ACTIVATED_EXPOSURE, type HasActivatedExposure } from '../../experience/public.js';
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  type FenceOwnAccount,
  type FencePersonalRecording,
  type WithPersonalScope,
} from '../../identity/public.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import { makeLockCall } from '../application/lock-call.js';
import type { PlayPorts } from '../application/ports.js';
import { makeReadLandmarks } from '../application/read-landmarks.js';
import { makeReadOrbit } from '../application/read-orbit.js';
import { makeReadResults } from '../application/read-results.js';
import { PLAY_USE_CASES, type PlayUseCases } from '../public.js';
import { playStore } from './play-store.js';

/** What the play use cases need from the rest of the system, chosen by the composition root. */
export interface PlayDeps {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
  readonly hasActivatedExposure: HasActivatedExposure;
  readonly readFacts: ReadScrollPlayFacts;
  readonly readTopics: ReadEncounterTopics;
}

/** The play use cases over PostgreSQL: the receipt store, the neighbours' public reads and the two tables. */
export function playUseCases(deps: PlayDeps): PlayUseCases {
  const ports: PlayPorts = {
    withPersonalScope: deps.withScope,
    fenceOwn: deps.fenceOwn,
    fenceRecording: deps.fenceRecording,
    hash: (operation, request) => requestHash(operation, request as CanonicalJson),
    findReceipt: findPersonalReceipt,
    insertReceipt: insertPersonalReceipt,
    completeReceipt: (scope, commandId, outcome) =>
      completePersonalReceipt(scope, commandId, outcome as { readonly [key: string]: CanonicalJson }),
    hasActivatedExposure: deps.hasActivatedExposure,
    readFacts: deps.readFacts,
    readTopics: deps.readTopics,
    store: playStore,
  };
  return {
    lockCall: makeLockCall(ports),
    readResults: makeReadResults(ports),
    readLandmarks: makeReadLandmarks(ports),
    readOrbit: makeReadOrbit(ports),
  };
}

/** The API's play use cases. Needs content's and experience's read ports and identity's fences in the same composition root. */
export function playProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: PLAY_USE_CASES,
      inject: [
        tokens.withPersonalScope,
        FENCE_OWN_ACCOUNT,
        FENCE_PERSONAL_RECORDING,
        HAS_ACTIVATED_EXPOSURE,
        READ_SCROLL_PLAY_FACTS,
        READ_ENCOUNTER_TOPICS,
      ],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        fenceRecording: FencePersonalRecording,
        hasActivatedExposure: HasActivatedExposure,
        readFacts: ReadScrollPlayFacts,
        readTopics: ReadEncounterTopics,
      ): PlayUseCases =>
        playUseCases({ withScope, fenceOwn, fenceRecording, hasActivatedExposure, readFacts, readTopics }),
    },
  ];
}
