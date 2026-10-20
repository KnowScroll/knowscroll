import type { Provider } from '@nestjs/common';
import {
  INGEST_OBSERVATIONS,
  READ_EVIDENCE_DIAGNOSTICS,
  evidenceIntakeProviders,
  activityProviders,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import { DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';
import { personalContextProviders } from '@knowscroll/backend/modules/personal-context/nest-providers';
import { ACTIVITY_CONTEXT_EFFECT } from '@knowscroll/backend/modules/personal-context';

/** Evidence wiring for the API composition root: the observation intake and the dev diagnostics read. */
export const evidenceWiring: Provider[] = [
  ...personalContextProviders(),
  ...activityProviders({
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
    derivedProjection: ACTIVITY_CONTEXT_EFFECT,
  }),
  ...evidenceIntakeProviders({
    database: DATABASE,
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
  }),
];

export { INGEST_OBSERVATIONS, READ_EVIDENCE_DIAGNOSTICS };
