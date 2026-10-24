import {
  buildDataExportQueue,
  clearExplorationQueue,
  deleteAccountQueue,
  recoverAccountDeletionsQueue,
  recoverClearOperationsQueue,
} from '@knowscroll/backend/modules/identity';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';

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

/**
 * Account deletion and export (#246, D-043). The final failed delivery shows the receipt as
 * needing a retry; the recovery cron hands due deletions back to the queue either way, so the
 * best-effort mark is not the only way out of a failure.
 */
export function accountPrivacyConsumers(
  use: {
    readonly deletion: {
      process(input: unknown): Promise<'completed' | 'waiting_for_accounting' | 'gone'>;
      fail(input: unknown): Promise<void>;
      recover(): Promise<{ readonly requeued: number }>;
    };
    readonly exports: {
      build(input: unknown): Promise<'built' | 'skipped' | 'too_large'>;
      fail(input: unknown): Promise<void>;
    };
  },
  logEvent: LogEvent,
): readonly JobConsumer<unknown>[] {
  return [
    jobConsumer(deleteAccountQueue, async (payload, delivery) => {
      const startedAt = performance.now();
      try {
        const outcome = await use.deletion.process(payload);
        logEvent('identity.account_deletion_processed', {
          outcome,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        if (delivery.retryCount >= deleteAccountQueue.policy.retryLimit) await use.deletion.fail(payload);
        throw error;
      }
    }),
    jobConsumer(recoverAccountDeletionsQueue, async () => {
      const { requeued } = await use.deletion.recover();
      if (requeued > 0) logEvent('identity.account_deletions_recovered', { count: requeued });
    }),
    jobConsumer(buildDataExportQueue, async (payload, delivery) => {
      const startedAt = performance.now();
      try {
        const outcome = await use.exports.build(payload);
        logEvent('identity.data_export_built', { outcome, durationMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        if (delivery.retryCount >= buildDataExportQueue.policy.retryLimit) await use.exports.fail(payload);
        throw error;
      }
    }),
  ];
}
