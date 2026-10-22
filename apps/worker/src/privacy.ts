import { clearExplorationQueue, recoverClearOperationsQueue } from '@knowscroll/backend/modules/identity';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';

/** Trusted maintenance consumer: the durable operation determines core versus accounting. */
export function clearExplorationConsumers(clear: {
  process(input: unknown): Promise<void>;
  fail(input: unknown, code: 'temporarily_unavailable' | 'completion_unverified'): Promise<void>;
  recover(input: unknown): Promise<unknown>;
}): readonly JobConsumer<unknown>[] {
  return [
    jobConsumer(clearExplorationQueue, async (payload, delivery) => {
      try {
        await clear.process(payload);
      } catch (error) {
        // Best-effort coarse failure. The durable scheduled recovery also covers a failure
        // here, or a final delivery lost before this catch can run.
        if (delivery.retryCount >= clearExplorationQueue.policy.retryLimit)
          await clear.fail(payload, 'completion_unverified');
        throw error;
      }
    }),
    jobConsumer(recoverClearOperationsQueue, async (payload) => {
      await clear.recover(payload);
    }),
  ];
}
