import { describe, expect, it } from 'vitest';
import type { WorkerConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { checkLibrarySupportJob, produceScrollJob } from '@knowscroll/backend/modules/content';
import { handOverHeldRevision, scrollProductionConsumers } from './production-jobs.js';

/** A worker configuration with the production grant on or off: the only part of it these consumers read before they are asked to work. */
const configWith = (productionEnabled: boolean, madeToOrderEnabled: boolean) =>
  ({ reasoning: { productionEnabled }, scrollProductionGeneration: 1, madeToOrderEnabled }) as unknown as WorkerConfig;

function consumers(productionEnabled: boolean, madeToOrderEnabled = true) {
  const logged: { readonly name: string; readonly fields: unknown }[] = [];
  const logEvent = ((name: string, fields: unknown) => void logged.push({ name, fields })) as unknown as LogEvent;
  const built = scrollProductionConsumers({
    config: configWith(productionEnabled, madeToOrderEnabled),
    db: {} as never,
    boss: {} as never,
    harness: {} as never,
    withScope: {} as never,
    logEvent,
  });
  return { built, logged };
}

describe('the Scroll production consumers of the worker', () => {
  it('are registered only where the worker holds the production grant, so a worker without it leaves the jobs queued for one that does', () => {
    expect(consumers(false).built).toEqual([]);
  });

  it('with the grant: the two production queues and the two of the library support check (D-415)', () => {
    expect(consumers(true).built.map((consumer) => consumer.queue.name)).toEqual([
      'content.produce-scroll',
      'content.produce-answer',
      'content.check-library-support',
      'content.sweep-library-support',
    ]);
  });

  it('drop a check job for another checker version, logging a code and the revision only, and touching nothing', async () => {
    const { built, logged } = consumers(true);
    const check = built.find((consumer) => consumer.queue.name === 'content.check-library-support')!;
    const job = {
      ...checkLibrarySupportJob('8a7d48fe-0397-4e00-91a8-b4700630880f', 4),
      checkerVersion: 'library-support-check.v0',
    };
    await check.handle(job, { jobId: 'ci-job', retryCount: 0, signal: new AbortController().signal });
    expect(logged).toEqual([
      {
        name: 'content.library_support_checked',
        fields: expect.objectContaining({ outcome: 'skipped', reasonCode: 'checker_version', revision: 4 }) as unknown,
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain('8a7d48fe');
  });
});

describe('the production consumers and the made-to-order switch (D-436)', () => {
  const delivery = { jobId: 'ci-job', retryCount: 0, signal: new AbortController().signal };
  const orderKey = `order-${'a'.repeat(32)}`;

  it('end every job of the answer queue, and every order of the library queue, as skipped without producing anything', async () => {
    const { built, logged } = consumers(true, false);
    const answer = built.find((consumer) => consumer.queue.name === 'content.produce-answer')!;
    const library = built.find((consumer) => consumer.queue.name === 'content.produce-scroll')!;
    // The database is unreachable in this fixture: a delivery that went on to produce would throw here instead of ending.
    await answer.handle(produceScrollJob(orderKey), delivery);
    await answer.handle(produceScrollJob('exoplanet-kinds'), delivery);
    await library.handle(produceScrollJob(orderKey), delivery);
    expect(logged.map((entry) => [entry.name, entry.fields])).toEqual(
      [orderKey, 'exoplanet-kinds', orderKey].map((context) => [
        'content.scroll_production_finished',
        expect.objectContaining({ context, outcome: 'skipped', reasonCode: 'made_to_order_off' }) as unknown,
      ]),
    );
  });

  it('still lets a library recipe on the library queue go on to produce while the switch is off', async () => {
    const { built, logged } = consumers(true, false);
    const library = built.find((consumer) => consumer.queue.name === 'content.produce-scroll')!;
    await expect(library.handle(produceScrollJob('exoplanet-kinds'), delivery)).rejects.toThrow();
    expect(logged).toEqual([]);
  });
});

describe('handing the check of a held revision to its queue', () => {
  const ASSET = '8a7d48fe-0397-4e00-91a8-b4700630880f';

  it('sends one job for the revision a delivery held, and none for a delivery that held nothing', async () => {
    const sent: unknown[] = [];
    const enqueue = (job: unknown) => {
      sent.push(job);
      return Promise.resolve('queued' as const);
    };
    await handOverHeldRevision({ held: true, assetId: ASSET, revision: 2 }, enqueue, () => undefined);
    expect(sent).toEqual([checkLibrarySupportJob(ASSET, 2)]);
    expect(checkLibrarySupportJob(ASSET, 2).checkerVersion).toMatch(/^library-support-check\.[0-9a-f]{8}$/u);
    await handOverHeldRevision({ assetId: ASSET, revision: 2 }, enqueue, () => undefined);
    await handOverHeldRevision({ held: true }, enqueue, () => undefined);
    expect(sent).toHaveLength(1);
  });

  it('never fails the delivery when the send fails: the failure is reported and the sweep finds the revision', async () => {
    const failures: unknown[] = [];
    await handOverHeldRevision(
      { held: true, assetId: ASSET, revision: 2 },
      () => Promise.reject(new Error('CI: the queue is unavailable')),
      (error) => void failures.push(error),
    );
    expect(failures).toHaveLength(1);
  });
});
