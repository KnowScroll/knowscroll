import { describe, expect, it } from 'vitest';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { sweepReleasePolicyQueue } from '@knowscroll/backend/modules/content';
import { releasePolicyConsumers } from './release-policy-jobs.js';

/** A worker configuration: only what the release step reads. */
const configWith = (enabled: boolean) =>
  ({
    contentAutoRelease: { enabled, dailyCap: 5 },
    reasoning: { productionEnabled: false },
  }) as unknown as WorkerConfig;

/** A database that fails the test on any use: a step that must read nothing is given nothing to read. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('CI: the release step must not touch the database while the policy is off');
    },
  },
) as never;

function consumers(enabled: boolean) {
  const logged: { readonly name: string; readonly fields: unknown }[] = [];
  const logEvent = ((name: string, fields: unknown) => void logged.push({ name, fields })) as unknown as LogEvent;
  return { built: releasePolicyConsumers({ config: configWith(enabled), db: untouchable, logEvent }), logged };
}

describe('the release step of the release policy (#674, D-418)', () => {
  it('is a declared release queue that runs every ten minutes with a payload of its version only', () => {
    const declared = releaseQueues.find((queue) => queue.name === sweepReleasePolicyQueue.name);
    expect(declared?.schedule).toEqual({ cron: '*/10 * * * *', payload: { v: 1 } });
    expect(sweepReleasePolicyQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    expect(sweepReleasePolicyQueue.payload.safeParse({ v: 1, assetId: 'x' }).success).toBe(false);
  });

  it('is consumed by every worker, with or without the production grant, because it calls no model', () => {
    expect(consumers(false).built.map((consumer) => consumer.queue.name)).toEqual(['content.sweep-release-policy']);
    expect(consumers(true).built.map((consumer) => consumer.queue.name)).toEqual(['content.sweep-release-policy']);
  });

  it('finishes having read nothing and logged nothing while the switch is off', async () => {
    const { built, logged } = consumers(false);
    await built[0]!.handle({ v: 1 }, { jobId: 'ci-job', retryCount: 0, signal: new AbortController().signal });
    expect(logged).toEqual([]);
  });
});
