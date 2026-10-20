import {
  INGEST_OBSERVATIONS,
  READ_EVIDENCE_DIAGNOSTICS,
  evidenceIntakeProviders,
} from '@knowscroll/backend/modules/evidence/nest-providers';
import { DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/** Evidence wiring for the API composition root: the observation intake and the dev diagnostics read. */
export const evidenceWiring = evidenceIntakeProviders({
  database: DATABASE,
  withPersonalScope: WITH_PERSONAL_SCOPE,
  enqueueJob: ENQUEUE_JOB,
});

export { INGEST_OBSERVATIONS, READ_EVIDENCE_DIAGNOSTICS };
