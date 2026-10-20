import {
  ACTIVATE_EXPOSURE,
  APPLY_ACTION,
  LIST_SAVED,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
  experienceEvidenceReadProviders,
  experienceProviders,
} from '@knowscroll/backend/modules/experience/nest-providers';
import { DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Experience wiring for the API composition root: which adapters implement experience's ports, and
 * the read ports the evidence intake uses (an exposure's lineage).
 */
export const experienceWiring = [
  ...experienceProviders({
    database: DATABASE,
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
  }),
  ...experienceEvidenceReadProviders(),
];

export { ACTIVATE_EXPOSURE, APPLY_ACTION, LIST_SAVED, OPEN_EXPOSURE, READ_EXPOSURE_DOCUMENT };
