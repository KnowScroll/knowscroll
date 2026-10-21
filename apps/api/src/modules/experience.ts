import type { Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_OWN_ACCOUNT, type FenceOwnAccount } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  ACTIVATE_EXPOSURE,
  APPLY_ACTION,
  LIST_SAVED,
  OPEN_EXPOSURE,
  READ_EXPOSURE_DOCUMENT,
  experienceEvidenceReadProviders,
  experienceProviders,
  keepPlaceProviders,
  keepRemovalProviders,
  navigationProviders,
  NAVIGATE_ENCOUNTER,
  ACTIVATE_OFFER,
  READ_EXPOSURE_CONTEXT,
  APPLY_ENCOUNTER_ACTION,
} from '@knowscroll/backend/modules/experience/nest-providers';
import { KEEP_PLACE_USE_CASES, KEEP_REMOVAL_USE_CASE } from '@knowscroll/backend/modules/experience';
import { composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { API_CONFIG, DATABASE, ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

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
  // Keep needs Identity's actual root-held own-account UPDATE barrier, not plain context.
  // Bind only this port; no lifecycle invalidation or pair-access consumer is mounted.
  {
    provide: FENCE_OWN_ACCOUNT,
    inject: [DATABASE, API_CONFIG],
    useFactory: (db: Kysely<Database>, config: ApiConfig): FenceOwnAccount =>
      accountAccessUseCases({ db, lockTimeoutMs: config.scopeLockTimeoutMs }).fenceOwnAccount,
  },
  ...keepPlaceProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
  ...keepRemovalProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
  ...composerProviders({ isOperator: () => false }),
  ...navigationProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB }),
];

export {
  KEEP_PLACE_USE_CASES,
  KEEP_REMOVAL_USE_CASE,
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
