import type { Kysely } from 'kysely';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import { uuidv7 } from '@knowscroll/backend/infrastructure/ids';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  chooseScrollRecipeIn,
  makeEnqueueScrollProduction,
  makeProposeRecipes,
  readGapRecipes,
  readRecipeStates,
  readReleasedCoverage,
} from '@knowscroll/backend/modules/content/nest-providers';
import { briefGapQueue, scanGapsQueue } from '@knowscroll/backend/modules/supply';
import {
  gapBriefStore,
  gapScanStore,
  growthStore,
  makeBriefGaps,
  makeScanGaps,
  proposalOf,
} from '@knowscroll/backend/modules/supply/nest-providers';
import type { ProductionReasoningHarness, WithProductionScope } from '@knowscroll/backend/reasoning';

/**
 * The gap loop's two scheduled consumers (#674, D-414): `supply.scan-gaps` (SQL only) and `supply.brief-gap` (background class: it asks
 * the brief role through the production harness and commissions production of what code accepts, held for review). Both are registered
 * on every worker and both do nothing while `KS_SUPPLY_GROWTH_ENABLED` is off, so a world that leaves it off keeps its cron
 * jobs short and harmless; the brief job also needs the production grant (`KS_REASONING_PRODUCTION_ENABLED`). They log counts only.
 */
export function gapLoopConsumers(deps: {
  readonly config: WorkerConfig;
  readonly db: Kysely<Database>;
  readonly boss: Parameters<typeof makeEnqueueScrollProduction>[0];
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly logEvent: LogEvent;
}): readonly JobConsumer<unknown>[] {
  const { config, db, logEvent } = deps;
  const scan = makeScanGaps({
    enabled: config.supplyGrowthEnabled,
    depthTarget: config.supplyGapDepthTarget,
    store: gapScanStore(db),
    readCoverage: () => readReleasedCoverage(db),
    readRecipeStates: (keys) => readRecipeStates(db, keys),
    now: () => new Date(),
    newId: uuidv7,
  });
  const propose = makeProposeRecipes({
    db,
    authority: { scopeId: 'scroll-supply', generation: config.scrollProductionGeneration },
    withScope: deps.withScope,
    harness: deps.harness,
  });
  const enqueueProduction = makeEnqueueScrollProduction(deps.boss);
  const brief = makeBriefGaps({
    enabled: config.supplyGrowthEnabled && config.reasoning.productionEnabled,
    growthDailyCap: config.supplyGrowthDailyCap,
    store: gapBriefStore(db),
    // Create's decision reads the library on the transaction that holds the commissioning lock; the planning reads use the pool.
    growth: growthStore(db, { readRecipes: readGapRecipes, chooseRecipe: chooseScrollRecipeIn }),
    readGapRecipes: (target) => readGapRecipes(db, target),
    propose: async (request, signal) => proposalOf(await propose({ ...request, dryRun: false }, signal)),
    enqueueProduction: async (recipe, take) => {
      await enqueueProduction(recipe, take);
    },
    now: () => new Date(),
    newId: uuidv7,
  });
  return [
    jobConsumer(scanGapsQueue, async () => {
      const result = await scan();
      if (result.kind === 'scanned' && result.opened + result.closed + result.reopened + result.counted > 0)
        logEvent('supply.gaps_scanned', { outcome: 'scanned', count: result.opened });
    }),
    jobConsumer(briefGapQueue, async (_payload, delivery) => {
      const result = await brief(delivery.signal);
      if (result.kind === 'done' && result.proposed + result.commissioned + result.waiting > 0)
        logEvent('supply.gaps_briefed', { outcome: result.paused ? 'paused' : 'done', count: result.proposed });
    }),
  ];
}
