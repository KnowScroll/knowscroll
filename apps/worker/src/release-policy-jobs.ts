import type { Kysely } from 'kysely';
import { jobConsumer, type JobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { sweepReleasePolicyQueue } from '@knowscroll/backend/modules/content';
import { makeReleasePolicy } from '@knowscroll/backend/modules/content/nest-providers';

/**
 * The release step of the release policy (#674, D-418): `content.sweep-release-policy`, a cron every ten minutes that releases a held library
 * Scroll the policy allows. It is shared content only: no model, no personal root and no provider, so it needs no production grant and is
 * registered on every worker. With `KS_CONTENT_AUTO_RELEASE_ENABLED` off (the default in every world) it finishes having read nothing, so
 * the switch is the kill switch: setting it to `0` and restarting the worker stops every release.
 *
 * It logs counts and codes only: one `content.release_policy_released` line for each Scroll it released (the topic and the revision) and one
 * `content.release_policy_swept` line for the pass.
 */
export function releasePolicyConsumers(deps: {
  readonly config: WorkerConfig;
  readonly db: Kysely<Database>;
  readonly logEvent: LogEvent;
}): readonly JobConsumer<unknown>[] {
  const { config, logEvent } = deps;
  const policy = makeReleasePolicy(deps.db);
  return [
    jobConsumer(sweepReleasePolicyQueue, async () => {
      const result = await policy.sweep(config.contentAutoRelease);
      if (result.kind === 'off') return;
      for (const release of result.released)
        logEvent('content.release_policy_released', {
          context: release.topicId,
          outcome: 'released',
          revision: release.revision,
        });
      const outcome = result.capReached ? 'cap_reached' : result.released.length > 0 ? 'released' : 'none_released';
      const holds = Object.entries(result.held);
      logEvent('content.release_policy_swept', {
        outcome,
        count: result.released.length,
        // The most common reason a looked-at Scroll stayed held, so a pass that releases nothing says why.
        ...(holds.length === 0 ? {} : { reasonCode: holds.toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? 'held' }),
      });
    }),
  ];
}
