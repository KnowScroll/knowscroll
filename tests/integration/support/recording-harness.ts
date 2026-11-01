import type { Kysely } from 'kysely';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { composerRecordingOwnerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { experienceBufferSourceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { FENCE_OWN_ACCOUNT } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { roomsRecordingOwnerProviders } from '@knowscroll/backend/modules/rooms/nest-providers';
import { scenariosRecordingOwnerProviders } from '@knowscroll/backend/modules/scenarios/nest-providers';
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

/** Jev's real owner check, over Experience's real answer to whether an exposure was activated. */
function realComposerCheck(): CheckPersonalRecordingRun {
  const activated = experienceBufferSourceProviders().find(
    (provider) => provider.provide.description === 'composer.checkRecordedActivation',
  );
  const owner = composerRecordingOwnerProviders()[0]!;
  return owner.useFactory(activated!.useValue as Parameters<typeof owner.useFactory>[0]);
}

/**
 * The recording-aware personal harness over the test database, with the real owner checks of Supply, Scenarios, Rooms and the
 * Composer and a labelled fixture model (D-264, D-270). `fenceOwn` is what a worker's providers take from the Identity module.
 * `beforeApply` runs just before a worker enters its transaction to store a result, so a test can pause recording or clear in
 * the gap after the last model step.
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
  const [supply] = supplyRecordingOwnerProviders();
  const [scenarios] = scenariosRecordingOwnerProviders();
  const [rooms] = roomsRecordingOwnerProviders();
  const real = personalRecordingReasoningHarnessFor({
    db,
    fenceOwn: accounts.fenceOwnAccount,
    withPersonalScope: makeWithPersonalScope(db, { lockTimeoutMs: 5000 }),
    model: options.model,
    logEvent: silent,
    settings: options.settings ?? fixtureSettings,
    checkPlanner: deny,
    checkGeography: deny,
    checkSupply: supply!.useFactory(),
    checkScenarios: scenarios!.useFactory(),
    checkRooms: rooms!.useFactory(),
    checkComposer: realComposerCheck(),
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
 * The two entries a worker's composition needs beside the compatibility harness: the recording-aware harness under `token`
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
