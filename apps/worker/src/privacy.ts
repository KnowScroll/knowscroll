import { clearExplorationQueue } from '@knowscroll/backend/modules/identity';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';

/** Trusted maintenance consumer: the durable operation determines core versus accounting. */
export function clearExplorationConsumer(clear: {
  process(input: unknown): Promise<void>;
  fail(input: unknown, code: 'temporarily_unavailable' | 'completion_unverified'): Promise<void>;
}): JobConsumer<unknown> {
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
