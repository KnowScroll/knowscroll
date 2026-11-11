import type { Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DryRunOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  fencePersonalRecording,
  makeWithDryRunPersonalScope,
  readPersonalRecordingNow,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { LOCK_CURRENT_COVERAGE_AUTHORITIES, READ_DISCOVERY_CANDIDATES } from '@knowscroll/backend/modules/content';
import { readCurrentCoverageAuthorities } from '@knowscroll/backend/modules/content/nest-providers';
import {
  GEOGRAPHY_PORTS,
  makeGeographyDryRun,
  type GeographyDryRun,
  type GeographyPorts,
} from '@knowscroll/backend/modules/geography/nest-providers';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { READ_EXPLORATION_SNAPSHOT, READ_RECENT_CONTEXT_TOPICS } from '@knowscroll/backend/modules/personal-context';
import { plannerDryRunFor, type PlannerDryRun } from '@knowscroll/backend/modules/planner/nest-providers';
import { jobWiring } from './jobs.js';
import { DATABASE, ENQUEUE_JOB, LOG_EVENT, WITH_PERSONAL_SCOPE } from './tokens.js';

/**
 * Builds one value from a provider list the way Nest would, without starting Nest: a token that is seeded is used
 * as it is, a value provider gives its value, a factory provider is called with its own dependencies built first.
 * A token with no provider, or a cycle, throws. Only the providers a dry run reaches are ever built.
 */
export function makeResolver(
  providers: readonly Provider[],
  seeded: ReadonlyMap<unknown, unknown>,
): (token: unknown) => unknown {
  const built = new Map(seeded);
  const building = new Set<unknown>();
  const resolve = (token: unknown): unknown => {
    if (built.has(token)) return built.get(token);
    if (building.has(token)) throw new Error('DRY_RUN_PROVIDER_CYCLE');
    const provider = providers.find((candidate) => 'provide' in candidate && candidate.provide === token);
    if (provider === undefined) throw new Error('DRY_RUN_PROVIDER_MISSING');
    building.add(token);
    try {
      let value: unknown;
      if ('useValue' in provider) value = provider.useValue;
      else if ('useFactory' in provider)
        value = (provider.useFactory as (...dependencies: unknown[]) => unknown)(
          ...((provider.inject ?? []) as unknown[]).map(resolve),
        );
      else throw new Error('DRY_RUN_PROVIDER_UNSUPPORTED');
      built.set(token, value);
      return value;
    } finally {
      building.delete(token);
    }
  };
  return resolve;
}

/** Why a dry run may not send work: it enqueues nothing, and its scope could not commit it anyway. */
const refuseEnqueue = () => Promise.reject(new Error('DRY_RUN_NO_ENQUEUE'));

/**
 * The dry runs' ports, built from the worker's own providers (`jobWiring`) so they read exactly what a real run reads.
 * Three things differ, each on purpose: the personal scope is the read-only, always-rolled-back one; enqueueing is
 * refused; and the content authority recheck is the lock-free one, because a READ ONLY transaction cannot take row
 * locks and a dry run applies nothing they would protect.
 */
export function dryRunsFor(
  db: Kysely<Database>,
  config: DryRunOperatorConfig,
  logEvent: LogEvent,
): { readonly geography: GeographyDryRun; readonly planner: PlannerDryRun } {
  const dryScope = makeWithDryRunPersonalScope(db, { lockTimeoutMs: config.scopeLockTimeoutMs });
  const resolve = makeResolver(
    jobWiring,
    new Map<unknown, unknown>([
      [DATABASE, db],
      [LOG_EVENT, logEvent],
      [ENQUEUE_JOB, refuseEnqueue],
      [WITH_PERSONAL_SCOPE, dryScope],
      [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db, lockTimeoutMs: config.scopeLockTimeoutMs }).fenceOwnAccount],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [LOCK_CURRENT_COVERAGE_AUTHORITIES, readCurrentCoverageAuthorities],
    ]),
  );
  const geographyPorts = resolve(GEOGRAPHY_PORTS) as GeographyPorts;
  return {
    geography: makeGeographyDryRun({
      ...geographyPorts,
      withScope: dryScope,
      readRecordingNow: readPersonalRecordingNow,
      enabled: () => config.cartographerEnabled,
    }),
    planner: plannerDryRunFor({
      withPersonalScope: dryScope,
      fenceRecording: geographyPorts.fenceRecording,
      readRecordingNow: readPersonalRecordingNow,
      readSnapshot: resolve(READ_EXPLORATION_SNAPSHOT) as Parameters<typeof plannerDryRunFor>[0]['readSnapshot'],
      readRecentTopics: resolve(READ_RECENT_CONTEXT_TOPICS) as Parameters<
        typeof plannerDryRunFor
      >[0]['readRecentTopics'],
      readInventory: resolve(READ_DISCOVERY_CANDIDATES) as Parameters<typeof plannerDryRunFor>[0]['readInventory'],
      enabled: () => config.plannerEnabled,
    }),
  };
}
