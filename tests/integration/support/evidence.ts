import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import type { ApplyActionEvidence } from '@knowscroll/backend/modules/evidence';
import { APPLY_ACTION_EVIDENCE, evidenceProviders } from '@knowscroll/backend/modules/evidence/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

const SCOPE = Symbol('test.withPersonalScope');

/** The evidence job's real use case, built from the providers the worker's composition root uses. */
export function evidenceUseCase(database: TestDatabase<Database>): ApplyActionEvidence {
  const identity = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 });
  const values = new Map<symbol, unknown>([
    [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
    [FENCE_OWN_ACCOUNT, identity.fenceOwnAccount],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    ...experienceEvidenceReadProviders().flatMap((provider) =>
      provider.useValue === undefined ? [] : [[provider.provide, provider.useValue] as const],
    ),
  ]);
  return buildFromProviders(
    evidenceProviders({ withPersonalScope: SCOPE }),
    APPLY_ACTION_EVIDENCE,
    values,
  ) as ApplyActionEvidence;
}
