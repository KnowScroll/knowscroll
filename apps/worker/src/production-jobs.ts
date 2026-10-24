import type { Kysely } from 'kysely';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { produceScrollQueue } from '@knowscroll/backend/modules/content';
import { makeRunScrollProduction, produceScrollUseCase } from '@knowscroll/backend/modules/content/nest-providers';
import type { ProductionReasoningHarness, WithProductionScope } from '@knowscroll/backend/reasoning';

/**
 * The `content.produce-scroll` consumer (D-037). It is registered only when the worker holds the
 * production grant (`KS_REASONING_PRODUCTION_ENABLED`), so a worker without it leaves the jobs queued
 * for one that does, instead of failing and dead-lettering them. The delivery runs the same use case
 * as the operator's `content produce-scroll` and logs only the recipe key, the outcome code and counts.
 */
export function scrollProductionConsumers(deps: {
  readonly config: WorkerConfig;
  readonly db: Kysely<Database>;
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly logEvent: LogEvent;
}): readonly JobConsumer<unknown>[] {
  const { config, logEvent } = deps;
  if (!config.reasoning.productionEnabled) return [];
  const run = makeRunScrollProduction(
    produceScrollUseCase({
      db: deps.db,
      authority: { scopeId: 'scroll-supply', generation: config.scrollProductionGeneration },
      withScope: deps.withScope,
      harness: deps.harness,
      model: config.reasoning.minimax?.model ?? 'none',
    }),
  );
  return [
    jobConsumer(produceScrollQueue, async (job, delivery) => {
      const startedAt = performance.now();
      const outcome = await run(job, delivery);
      const durationMs = Math.round(performance.now() - startedAt);
      if (outcome.kind === 'skipped') {
        logEvent('content.scroll_production_finished', {
          context: job.recipe,
          outcome: 'skipped',
          reasonCode: outcome.reason,
          durationMs,
        });
        return;
      }
      const { result } = outcome;
      logEvent('content.scroll_production_finished', {
        context: job.recipe,
        outcome: result.outcome,
        ...(result.codes?.[0] === undefined ? {} : { reasonCode: result.codes[0] }),
        count: result.attempts?.reduce((total, receipt) => total + (receipt.attempts?.length ?? 0), 0) ?? 0,
        durationMs,
      });
    }),
  ];
}
