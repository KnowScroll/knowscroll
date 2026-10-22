import type { Kysely } from 'kysely';
import type { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { eraseExploration } from '@knowscroll/backend/infrastructure/erasure';
import { explorationStores } from '@knowscroll/backend/erasure-registry';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { clearExplorationFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearExplorationQueue } from '@knowscroll/backend/modules/identity';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';

/** Trusted maintenance consumer: the durable operation determines core versus accounting. */
export function clearExplorationConsumer(
  db: Kysely<Database>,
  boss: ReturnType<typeof createBoss>,
  lockTimeoutMs: number,
): JobConsumer<unknown> {
  const clear = clearExplorationFor(db, boss, {
    reasoning: clearReasoning,
    eraseCore: async (scope) => {
      await eraseExploration(scope, explorationStores);
    },
    lockTimeoutMs,
  });
  return jobConsumer(clearExplorationQueue, async (payload, delivery) => {
    try {
      await clear.process(payload);
    } catch (error) {
      // Persist a coarse final failure before pg-boss exhausts this finite delivery policy.
      if (delivery.retryCount >= clearExplorationQueue.policy.retryLimit)
        await clear.fail(payload, 'completion_unverified');
      throw error;
    }
  });
}
