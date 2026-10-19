import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyQueueDeclarations,
  createBoss,
  deadLetterQueueName,
  defineQueue,
  drainConsumers,
  jobConsumer,
  startConsumers,
} from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureQueue } from '../support/queues.js';

const silent: LogEvent = () => undefined;
const diagnostics = { onError: () => undefined, onWarning: () => undefined };

describe('pg-boss queue declarations and consumers (real database)', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('jobs');
  });
  afterAll(async () => {
    await database.drop();
  });

  it('creates each declared queue and its dead-letter queue with the declared policy', async () => {
    const boss = createBoss(database.settings, 'producer', diagnostics);
    await boss.start();
    try {
      const queue = await boss.getQueue(fixtureQueue.name);
      expect(queue).toMatchObject({
        retryLimit: 1,
        expireInSeconds: 60,
        deadLetter: deadLetterQueueName(fixtureQueue.name),
      });
      expect(await boss.getQueue(deadLetterQueueName(fixtureQueue.name))).not.toBeNull();
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('applies a changed policy to an existing queue', async () => {
    const changed = defineQueue({
      ...fixtureQueue,
      policy: { ...fixtureQueue.policy, retryLimit: 4, expireInSeconds: 120 },
    });
    const boss = createBoss(database.settings, 'install', diagnostics);
    await boss.start();
    try {
      await applyQueueDeclarations(boss, [changed]);
      expect(await boss.getQueue(fixtureQueue.name)).toMatchObject({ retryLimit: 4, expireInSeconds: 120 });
      await applyQueueDeclarations(boss, [fixtureQueue]);
      expect(await boss.getQueue(fixtureQueue.name)).toMatchObject({ retryLimit: 1, expireInSeconds: 60 });
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('lets a running handler finish when consumers drain', async () => {
    const finished: string[] = [];
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const consumer = jobConsumer(fixtureQueue, async (payload) => {
      started();
      await new Promise((resolve) => setTimeout(resolve, payload.holdMs));
      finished.push(payload.taskId);
    });
    const worker = createBoss(database.settings, 'consumer', diagnostics);
    await worker.start();
    await startConsumers(worker, [consumer], silent);
    await worker.send(fixtureQueue.name, { v: 1, taskId: 'drain-1', holdMs: 1_500 });
    await handlerStarted;
    await drainConsumers(worker, 1, 10_000, silent);
    expect(finished).toEqual(['drain-1']);
  });
});
