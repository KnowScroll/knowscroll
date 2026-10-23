import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeRunScrollProduction, produceScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import type { TestDatabase } from './database.js';
import { fixtureModel, fixtureSettings, silent } from './fixture-model.js';
import type { FixtureScenario } from './fixture-model-port.js';
import { fixtureResearchFor } from './generated-scroll.js';

/**
 * The production job's consumer over a labelled fixture model (CI fixture, never provider output). The
 * transport carries a MiniMax stand-in identity so a publication passes the same identity checks as a
 * real run. `producer` builds the use case over another harness, to simulate a crash.
 */
export function fixtureProductionWorker(
  database: TestDatabase<Database>,
  script: () => FixtureScenario,
  options: { readonly quota?: Parameters<typeof fixtureModel>[1]['quota'] } = {},
) {
  const fixture = fixtureModel(script, {
    label: 'production-worker-CI-fixture',
    ...(options.quota ? { quota: options.quota } : {}),
  });
  const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
  const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
  const harness = makeProductionReasoningHarness(
    postgresProductionHarnessPorts({
      db: database.db,
      withProductionScope: withScope,
      enabled: true,
      model,
      logEvent: silent,
      settings: fixtureSettings,
    }),
  );
  const producer = (overrides: { readonly harness?: ProductionReasoningHarness } = {}) =>
    produceScrollUseCase({
      db: database.db,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope,
      harness: overrides.harness ?? harness,
      model: model.model,
      research: (url) => Promise.resolve(fixtureResearchFor(url)),
    });
  return { fixture, harness, producer, run: makeRunScrollProduction(producer()) };
}
