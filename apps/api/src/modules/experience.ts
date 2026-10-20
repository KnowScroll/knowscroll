import type { Provider } from '@nestjs/common';
import {
  ACTIVATE_EXPOSURE,
  APPLY_ACTION,
  LIST_SAVED,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
  experienceEvidenceReadProviders,
  experienceProviders,
  navigationProviders,
  NAVIGATE_ENCOUNTER,
  ACTIVATE_OFFER,
  READ_EXPOSURE_CONTEXT,
  APPLY_ENCOUNTER_ACTION,
} from '@knowscroll/backend/modules/experience/nest-providers';
import { composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Experience wiring for the API composition root: which adapters implement experience's ports, and
 * the read ports the evidence intake uses (an exposure's lineage).
 */
export const experienceWiring: Provider[] = [
  ...experienceProviders({
    database: DATABASE,
    withPersonalScope: WITH_PERSONAL_SCOPE,
    enqueueJob: ENQUEUE_JOB,
  }),
  ...experienceEvidenceReadProviders(),
  ...composerProviders({ isOperator: () => false }),
  ...navigationProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
];

export {
  ACTIVATE_EXPOSURE,
  APPLY_ACTION,
  LIST_SAVED,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
  NAVIGATE_ENCOUNTER,
  ACTIVATE_OFFER,
  READ_EXPOSURE_CONTEXT,
  APPLY_ENCOUNTER_ACTION,
};
