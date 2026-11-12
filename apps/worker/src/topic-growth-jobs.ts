import type { Kysely } from 'kysely';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  fetchResearchWithLinks,
  makeGrowTopics,
  makeProposeTopic,
  makeSeedTopicCandidates,
  topicGrowthLock,
} from '@knowscroll/backend/modules/content/nest-providers';
import { growTopicsQueue } from '@knowscroll/backend/modules/content';
import type { ProductionReasoningHarness, WithProductionScope } from '@knowscroll/backend/reasoning';

/**
 * Whether topic growth runs: the gap loop's switch (`KS_SUPPLY_GROWTH_ENABLED`) and its own (`KS_TOPIC_GROWTH_ENABLED`) are both on, and the
 * production grant is held (the proposal role is a production role). Any one off and a delivery does nothing: it reads no page, asks no
 * model and writes no row.
 */
export const topicGrowthRuns = (
  config: Pick<WorkerConfig, 'supplyGrowthEnabled' | 'topicGrowthEnabled'> & {
    readonly reasoning: Pick<WorkerConfig['reasoning'], 'productionEnabled'>;
  },
): boolean => config.supplyGrowthEnabled && config.topicGrowthEnabled && config.reasoning.productionEnabled;

/**
 * The topic growth consumer (#674, D-422, `content.grow-topics`, background class): twice an hour it looks for candidate pages by following
 * the links of research pages already accepted for recipes, and proposes a place for at most one candidate through the production harness;
 * code admits it as a topic that is not servable until the library has released supply for it. It is registered on every worker and does
 * nothing unless both `KS_SUPPLY_GROWTH_ENABLED` and `KS_TOPIC_GROWTH_ENABLED` are on and the production grant is held, so a world that
 * leaves them off keeps its cron job short and harmless. It logs counts and codes only.
 */
export function topicGrowthConsumers(deps: {
  readonly config: WorkerConfig;
  readonly db: Kysely<Database>;
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly logEvent: LogEvent;
}): readonly JobConsumer<unknown>[] {
  const { config, db, logEvent } = deps;
  const seed = makeSeedTopicCandidates({ db, read: (url) => fetchResearchWithLinks(url) });
  const propose = makeProposeTopic({
    db,
    authority: { scopeId: 'scroll-supply', generation: config.scrollProductionGeneration },
    withScope: deps.withScope,
    harness: deps.harness,
    maxTopicsPerSystem: config.topicGrowthMaxPerSystem,
  });
  const grow = makeGrowTopics({
    enabled: topicGrowthRuns(config),
    growthDailyCap: config.supplyGrowthDailyCap,
    maxTopicsPerSystem: config.topicGrowthMaxPerSystem,
    db,
    lock: topicGrowthLock(db),
    seed,
    propose,
    now: () => new Date(),
  });
  return [
    jobConsumer(growTopicsQueue, async (_payload, delivery) => {
      const result = await grow(delivery.signal);
      if (result.kind === 'busy') logEvent('content.topic_growth', { outcome: 'busy', count: 0 });
      else if (result.kind === 'done' && (result.proposals.length > 0 || (result.seeded?.sourcesRead ?? 0) > 0)) {
        const admitted = result.proposals.filter((kind) => kind === 'admitted').length;
        logEvent('content.topic_growth', {
          outcome: result.paused ? 'paused' : admitted > 0 ? 'admitted' : 'done',
          count: admitted,
        });
      }
    }),
  ];
}
