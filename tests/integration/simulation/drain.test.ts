import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoss, jobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureQueue } from '../support/queues.js';
import { unsettledJobs } from './collect.js';
import { drain } from './drain.js';

/**
 * The lab's job checks on real pg-boss, with the fixture queue (retry limit 1, dead letter on). They show the checks can
 * see what they exist to see: a handler that throws and then succeeds on retry, a job that never succeeds, and a job whose
 * payload names no universe.
 */
describe('the lab drain and its job checks (real pg-boss)', () => {
  let database: TestDatabase<Database>;
  let boss: ReturnType<typeof createBoss>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('sim_drain');
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterEach(async () => {
    await boss.stop({ graceful: false });
    await database.drop();
  });

  it('counts a handler failure that a retry later recovers, and leaves nothing unsettled', async () => {
    await boss.send(fixtureQueue.name, { v: 1, taskId: 'fails-once', holdMs: 0 });
    const consumer = jobConsumer(fixtureQueue, (_payload, delivery) =>
      delivery.retryCount === 0 ? Promise.reject(new Error('SIM_TEST_FAILS_ONCE')) : Promise.resolve(),
    );
    const report = await drain(boss, database.db, [consumer]);
    expect(report.failures).toEqual({ [fixtureQueue.name]: 1 });
    expect(report.errors[fixtureQueue.name]).toEqual(['SIM_TEST_FAILS_ONCE']);
    expect(report.handled[fixtureQueue.name]).toBe(2);
    expect(report.exhausted).toBe(false);
    expect(await unsettledJobs(database.db)).toEqual([]);
  });

  it('finds a failed and a dead-lettered job whatever its payload names', async () => {
    await boss.send(fixtureQueue.name, { v: 1, taskId: 'always-fails', holdMs: 0 });
    const consumer = jobConsumer(fixtureQueue, () => Promise.reject(new Error('SIM_TEST_ALWAYS_FAILS')));
    const report = await drain(boss, database.db, [consumer]);
    // The first delivery and its one retry.
    expect(report.failures[fixtureQueue.name]).toBe(2);
    const unsettled = await unsettledJobs(database.db);
    expect(unsettled.map((job) => [job.queue, job.state, job.n])).toEqual([
      [fixtureQueue.name, 'failed', 1],
      [`${fixtureQueue.name}.dead`, 'created', 1],
    ]);
  });
});
