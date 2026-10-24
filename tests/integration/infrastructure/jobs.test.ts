import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyQueueDeclarations,
  createBoss,
  deadLetterQueueName,
  defineQueue,
  drainConsumers,
  jobConsumer,
  removeUndeclaredSchedules,
  startConsumers,
} from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureQueue } from '../support/queues.js';

const silent: LogEvent = () => undefined;
const diagnostics = { onError: () => undefined, onWarning: () => undefined };
const secret = 'canary-job-secret-Xq19';

/** A failing fixture queue whose retry is far away, so the job is read while pg-boss holds it in `retry`. */
const failingQueue = (name: string, retryLimit: number) =>
  defineQueue({
    name,
    purpose: 'CI fixture: a handler that always fails, to read what pg-boss stores about the failure.',
    payload: z.object({ v: z.literal(1), taskId: z.string() }),
    policy: {
      expireInSeconds: 60,
      retryLimit,
      retryDelaySeconds: 3_600,
      retryBackoff: false,
      retentionSeconds: 7_200,
      deleteAfterSeconds: 3_600,
      deadLetter: false,
    },
    consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
  });

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

  it('registers a declared recurring schedule, and removes it when the declaration drops it', async () => {
    const scheduled = defineQueue({
      ...fixtureQueue,
      schedule: { cron: '*/15 * * * *', payload: { v: 1, taskId: 'scheduled', holdMs: 0 } },
    });
    const boss = createBoss(database.settings, 'install', diagnostics);
    await boss.start();
    const schedules = async () =>
      (
        await sql<{ name: string; cron: string; timezone: string }>`
          select name, cron, timezone from pgboss.schedule where name = ${fixtureQueue.name}`.execute(database.db)
      ).rows;
    try {
      await applyQueueDeclarations(boss, [scheduled]);
      await applyQueueDeclarations(boss, [scheduled]);
      expect(await schedules()).toEqual([{ name: fixtureQueue.name, cron: '*/15 * * * *', timezone: 'UTC' }]);
      await applyQueueDeclarations(boss, [fixtureQueue]);
      expect(await schedules()).toEqual([]);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('removes the schedule of a queue the registry no longer declares, and keeps the declared ones', async () => {
    const cron = { cron: '*/15 * * * *', payload: { v: 1, taskId: 'scheduled', holdMs: 0 } };
    const declared = defineQueue({ ...fixtureQueue, schedule: cron });
    const retired = defineQueue({ ...fixtureQueue, name: 'fixture.retired-task', schedule: cron });
    const scheduledNames = async () =>
      (await sql<{ name: string }>`select name from pgboss.schedule order by name`.execute(database.db)).rows.map(
        (row) => row.name,
      );
    // An older release declared both queues; the current one declares only the first.
    const install = createBoss(database.settings, 'install', diagnostics);
    await install.start();
    try {
      await applyQueueDeclarations(install, [declared, retired]);
    } finally {
      await install.stop({ graceful: false });
    }
    expect(await scheduledNames()).toEqual(['fixture.retired-task', fixtureQueue.name]);

    const events: { name: string; fields: unknown }[] = [];
    const logged: LogEvent = (name, fields) => void events.push({ name, fields });
    const worker = createBoss(database.settings, 'consumer', diagnostics);
    await worker.start();
    try {
      await expect(removeUndeclaredSchedules(worker, [declared], logged)).resolves.toEqual([
        { queue: 'fixture.retired-task', key: '' },
      ]);
      expect(await scheduledNames()).toEqual([fixtureQueue.name]);
      expect(events).toEqual([{ name: 'jobs.schedule_removed', fields: { queue: 'fixture.retired-task' } }]);
      // Running it again, as every restart does, finds nothing to remove.
      await expect(removeUndeclaredSchedules(worker, [declared], logged)).resolves.toEqual([]);
      expect(events).toHaveLength(1);
      // The retired queue and its jobs are left alone.
      expect(await worker.getQueue('fixture.retired-task')).not.toBeNull();
    } finally {
      await worker.stop({ graceful: false });
    }
    const cleanup = createBoss(database.settings, 'install', diagnostics);
    await cleanup.start();
    try {
      await applyQueueDeclarations(cleanup, [fixtureQueue]);
    } finally {
      await cleanup.stop({ graceful: false });
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

  it('stores only a code-only output for a failed job, in retry and when it fails for good', async () => {
    const retrying = failingQueue('fixture.failing-retry', 1);
    const terminal = failingQueue('fixture.failing-terminal', 0);
    const install = createBoss(database.settings, 'install', diagnostics);
    await install.start();
    try {
      await applyQueueDeclarations(install, [retrying, terminal]);
    } finally {
      await install.stop({ graceful: false });
    }
    // The handler's error carries secret-shaped text in its message, its detail and a cause.
    const failing = (): Promise<void> =>
      Promise.reject(
        Object.assign(new Error(`handler failed for postgres://u:${secret}@db`), {
          code: 'FIXTURE_CRASH',
          detail: secret,
          cause: new Error(secret),
        }),
      );
    const worker = createBoss(database.settings, 'consumer', diagnostics);
    await worker.start();
    await startConsumers(worker, [jobConsumer(retrying, failing), jobConsumer(terminal, failing)], silent);
    try {
      const stored = async (queue: string, id: string) =>
        (
          await sql<{ state: string; output: unknown }>`
            select state, output from pgboss.job where name = ${queue} and id = ${id}
          `.execute(database.db)
        ).rows[0];
      for (const [queue, state] of [
        [retrying.name, 'retry'],
        [terminal.name, 'failed'],
      ] as const) {
        const id = (await worker.send(queue, { v: 1, taskId: `${state}-1` })) ?? '';
        // Read at the moment pg-boss stores the failure: before any completion could clear it.
        await expect.poll(async () => (await stored(queue, id))?.state, { timeout: 20_000, interval: 200 }).toBe(state);
        const row = await stored(queue, id);
        expect(row?.output).toEqual({ failure: 'handler_failed', errorClass: 'Error', code: 'FIXTURE_CRASH' });
        const text = JSON.stringify(row);
        expect(text).not.toContain(secret);
        expect(text).not.toContain('postgres://');
        expect(text).not.toContain('stack');
        expect(text).not.toContain('message');
      }
    } finally {
      await drainConsumers(worker, 1, 5_000, silent);
    }
  });
});
