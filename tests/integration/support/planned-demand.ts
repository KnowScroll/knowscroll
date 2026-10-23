import type { PgBoss } from 'pg-boss';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { RECORD_PLANNED_DEMAND, type RecordPlannedDemand } from '@knowscroll/backend/modules/supply';
import { SUPPLY_PORTS, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

/** Supply's real planned-demand entry over the test database, built from the worker's providers. */
export function realRecordPlannedDemand(database: TestDatabase<Database>, boss: PgBoss): RecordPlannedDemand {
  const SCOPE = Symbol('test.supply.scope'),
    ENQUEUE = Symbol('test.supply.enqueue');
  const providers = supplyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
  const values = new Map<symbol, unknown>([
    [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
    [ENQUEUE, makeEnqueueJob(boss)],
    ...identityScopeOwnerProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
    ...experienceEvidenceReadProviders().map((provider) => [provider.provide, provider.useValue] as const),
  ]);
  values.set(SUPPLY_PORTS, buildFromProviders(providers, SUPPLY_PORTS, values));
  return buildFromProviders(providers, RECORD_PLANNED_DEMAND, values) as RecordPlannedDemand;
}
