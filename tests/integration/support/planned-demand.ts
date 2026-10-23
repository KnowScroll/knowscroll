import type { PgBoss } from 'pg-boss';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceEvidenceReadProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import {
  CANCEL_CONTENT_REQUEST,
  READ_CONTENT_REQUEST,
  RECORD_PLANNED_DEMAND,
  type CancelRequest,
  type ReadRequest,
  type RecordPlannedDemand,
} from '@knowscroll/backend/modules/supply';
import { SUPPLY_PORTS, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

/** Supply's planned-demand entry and the person-facing status read and cancel, built from the worker's providers. */
export function realSupply(database: TestDatabase<Database>, boss: PgBoss) {
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
  const build = <T>(token: symbol) => buildFromProviders(providers, token, values) as T;
  return {
    record: build<RecordPlannedDemand>(RECORD_PLANNED_DEMAND),
    read: build<ReadRequest>(READ_CONTENT_REQUEST),
    cancel: build<CancelRequest>(CANCEL_CONTENT_REQUEST),
  };
}

export const realRecordPlannedDemand = (database: TestDatabase<Database>, boss: PgBoss): RecordPlannedDemand =>
  realSupply(database, boss).record;
