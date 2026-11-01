import type { Kysely } from 'kysely';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_OWN_ACCOUNT } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { supplyRecordingOwnerProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import type { CheckPersonalRecordingRun } from '@knowscroll/backend/reasoning';
import {
  personalRecordingReasoningHarnessFor,
  type HarnessSettings,
  type ModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import { fixtureSettings, silent } from './fixture-model.js';

/** The Planner and Cartographer owners are not under test here: they refuse everything, as a missing owner would. */
const deny: CheckPersonalRecordingRun = () => Promise.resolve('unavailable');

/**
 * The recording-aware personal harness over the test database, with Supply's real owner check and a labelled fixture model
 * (D-264). `fenceOwn` is what a worker's providers take from the Identity module. `beforeApply` runs just before a worker enters
 * its transaction to store a result, so a test can pause recording or clear in the gap after the last model step.
 */
export function fixtureRecordingHarness(
  db: Kysely<Database>,
  options: {
    readonly model: ModelPort | undefined;
    readonly settings?: HarnessSettings;
    readonly beforeApply?: () => Promise<void>;
  },
) {
  const accounts = accountAccessUseCases({ db, lockTimeoutMs: 5000 });
  const [owner] = supplyRecordingOwnerProviders();
  const real = personalRecordingReasoningHarnessFor({
    db,
    fenceOwn: accounts.fenceOwnAccount,
    withPersonalScope: makeWithPersonalScope(db, { lockTimeoutMs: 5000 }),
    model: options.model,
    logEvent: silent,
    settings: options.settings ?? fixtureSettings,
    checkPlanner: deny,
    checkGeography: deny,
    checkSupply: owner!.useFactory(),
  });
  const harness: typeof real = {
    ...real,
    withPersonalApply: async (authority, purpose, work) => {
      await options.beforeApply?.();
      return real.withPersonalApply(authority, purpose, work);
    },
  };
  return { fenceOwn: accounts.fenceOwnAccount, harness };
}

/**
 * The two entries a worker's Supply composition needs beside the compatibility harness: the recording-aware harness under `token`
 * and the account gate it reads the person's account with.
 */
export function recordingEntries(
  db: Kysely<Database>,
  model: ModelPort | undefined,
  token: symbol,
  beforeApply?: () => Promise<void>,
): readonly (readonly [symbol, unknown])[] {
  const { harness, fenceOwn } = fixtureRecordingHarness(db, {
    model,
    ...(beforeApply === undefined ? {} : { beforeApply }),
  });
  return [
    [token, harness],
    [FENCE_OWN_ACCOUNT, fenceOwn],
  ];
}
