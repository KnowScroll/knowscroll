import type { PgBoss } from 'pg-boss';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
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
import { READ_EXPLORATION_SNAPSHOT, type ReadExplorationSnapshot } from '@knowscroll/backend/modules/personal-context';
import { SUPPLY_PORTS, supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

/**
 * Supply's planned-demand entry and the person-facing status read and cancel, built from the worker's
 * providers. `createDailyCap` is what Create may start per day for people (default 0: Create is off, like
 * dev's default) and `plannerCreateDailyCap` what the Planner's demand may start (default: the same).
 * `readExploration` is the person's actual exploration snapshot, from which supply re-derives what they met.
 */
export function realSupply(
  database: TestDatabase<Database>,
  boss: PgBoss,
  options: { createDailyCap?: number; plannerCreateDailyCap?: number; readExploration: ReadExplorationSnapshot },
) {
  const SCOPE = Symbol('test.supply.scope'),
    ENQUEUE = Symbol('test.supply.enqueue'),
    CONFIG = Symbol('test.supply.config');
  const providers = supplyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE, config: CONFIG });
  const values = new Map<symbol, unknown>([
    [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
    [ENQUEUE, makeEnqueueJob(boss)],
    [
      CONFIG,
      {
        supplyCreateDailyCap: options.createDailyCap ?? 0,
        supplyPlannerCreateDailyCap: options.plannerCreateDailyCap ?? options.createDailyCap ?? 0,
        supplyAskDailyCap: 0,
        supplyAskPersonDailyCap: 5,
      },
    ],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [READ_EXPLORATION_SNAPSHOT, options.readExploration],
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

export const realRecordPlannedDemand = (
  database: TestDatabase<Database>,
  boss: PgBoss,
  options: Parameters<typeof realSupply>[2],
): RecordPlannedDemand => realSupply(database, boss, options).record;
