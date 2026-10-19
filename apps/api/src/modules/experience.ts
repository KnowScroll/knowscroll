import { APPLY_ACTION, LIST_SAVED, experienceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/** Experience wiring for the API composition root: which adapters implement experience's ports. */
export const experienceWiring = experienceProviders({
  database: DATABASE,
  withPersonalScope: WITH_PERSONAL_SCOPE,
  enqueueJob: ENQUEUE_JOB,
});

export { APPLY_ACTION, LIST_SAVED };
