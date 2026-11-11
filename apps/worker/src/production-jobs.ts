import type { Kysely } from 'kysely';
import { jobConsumer, type createBoss, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  checkLibrarySupportJob,
  checkLibrarySupportQueue,
  produceAnswerQueue,
  produceScrollQueue,
  sweepLibrarySupportQueue,
  type ProduceScrollJob,
} from '@knowscroll/backend/modules/content';
import {
  makeCheckLibrarySupport,
  makeEnqueueLibrarySupport,
  makeRunLibrarySupportCheck,
  makeRunScrollProduction,
  makeSweepLibrarySupport,
  produceScrollUseCase,
  recipeKeyOfAsset,
} from '@knowscroll/backend/modules/content/nest-providers';
import type { ProductionReasoningHarness, WithProductionScope } from '@knowscroll/backend/reasoning';

/**
 * Sends the support check of a revision a delivery has just held for review (D-415). Only a delivery that stored a held Scroll
 * carries `held`. It is a hint, not the only way: it sits outside the transaction that held the Scroll, a failure to send it is
 * logged and swallowed, and the sweep finds every held revision that has no check.
 */
export async function handOverHeldRevision(
  result: { readonly held?: true; readonly assetId?: string; readonly revision?: number },
  enqueue: (job: ReturnType<typeof checkLibrarySupportJob>) => Promise<'queued' | 'already_queued'>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  if (result.held !== true || result.assetId === undefined || result.revision === undefined) return;
  await enqueue(checkLibrarySupportJob(result.assetId, result.revision)).catch(onFailure);
}

/**
 * The `content.produce-scroll` and `content.produce-answer` consumers (D-037, D-267). They run the same delivery on two
 * queues, so that the answer to a question, whose take may send twelve requests, holds a longer claim than a library
 * recipe. They are registered only when the worker holds the production grant (`KS_REASONING_PRODUCTION_ENABLED`), so a
 * worker without it leaves the jobs queued for one that does, instead of failing and dead-lettering them. The delivery
 * runs the same use case as the operator's `content produce-scroll` and logs only the recipe key, the outcome code and
 * counts.
 *
 * It also runs the support check of a held library Scroll (D-415) on the same grant: `content.check-library-support` checks one
 * revision, `content.sweep-library-support` (a cron every ten minutes) hands over every held revision that has none, and the delivery
 * that held a revision sends its check at once. The check is background work that only informs the operator's read.
 */
export function scrollProductionConsumers(deps: {
  readonly config: WorkerConfig;
  readonly db: Kysely<Database>;
  readonly boss: ReturnType<typeof createBoss>;
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly logEvent: LogEvent;
}): readonly JobConsumer<unknown>[] {
  const { config, logEvent } = deps;
  if (!config.reasoning.productionEnabled) return [];
  const authority = { scopeId: 'scroll-supply', generation: config.scrollProductionGeneration } as const;
  const run = makeRunScrollProduction(
    produceScrollUseCase({
      db: deps.db,
      authority,
      withScope: deps.withScope,
      harness: deps.harness,
      model: config.reasoning.minimax?.model ?? 'none',
    }),
  );
  const enqueueSupportCheck = makeEnqueueLibrarySupport(deps.boss);
  const runSupportCheck = makeRunLibrarySupportCheck(
    makeCheckLibrarySupport({ db: deps.db, authority, withScope: deps.withScope, harness: deps.harness }),
  );
  const sweepSupportChecks = makeSweepLibrarySupport({ db: deps.db, enqueue: enqueueSupportCheck });
  const deliver = async (job: ProduceScrollJob, delivery: Parameters<typeof run>[1]): Promise<void> => {
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
    await handOverHeldRevision(result, enqueueSupportCheck, (error) =>
      logEvent('content.library_support_not_queued', { context: job.recipe, revision: result.revision ?? 0, error }),
    );
    logEvent('content.scroll_production_finished', {
      context: job.recipe,
      outcome: result.outcome,
      ...(result.codes?.[0] === undefined ? {} : { reasonCode: result.codes[0] }),
      count: result.attempts?.reduce((total, receipt) => total + (receipt.attempts?.length ?? 0), 0) ?? 0,
      durationMs,
    });
  };
  return [
    jobConsumer(produceScrollQueue, deliver),
    jobConsumer(produceAnswerQueue, deliver),
    jobConsumer(checkLibrarySupportQueue, async (job, delivery) => {
      const startedAt = performance.now();
      const outcome = await runSupportCheck(job, delivery);
      const durationMs = Math.round(performance.now() - startedAt);
      if (outcome.kind === 'skipped') {
        logEvent('content.library_support_checked', {
          context: recipeKeyOfAsset(job.assetId) ?? 'unknown_recipe',
          outcome: 'skipped',
          reasonCode: outcome.reason,
          revision: job.revision,
          durationMs,
        });
        return;
      }
      const { result } = outcome;
      const stored = result.kind === 'stored' || result.kind === 'reused' ? result.check : undefined;
      const reason =
        result.kind === 'not_found'
          ? result.reason
          : result.kind === 'paused'
            ? result.code
            : (stored?.code ?? undefined);
      logEvent('content.library_support_checked', {
        context: recipeKeyOfAsset(job.assetId) ?? 'unknown_recipe',
        outcome: result.kind,
        ...(reason === undefined ? {} : { reasonCode: reason }),
        revision: job.revision,
        count: result.kind === 'stored' ? result.requests : 0,
        durationMs,
      });
    }),
    jobConsumer(sweepLibrarySupportQueue, async () => {
      const { queued } = await sweepSupportChecks();
      if (queued > 0) logEvent('content.library_support_swept', { count: queued });
    }),
  ];
}
