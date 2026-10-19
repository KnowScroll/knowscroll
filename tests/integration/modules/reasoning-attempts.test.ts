import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import {
  ModelRejectedError,
  admitRun,
  findAttempt,
  makeExecuteModelStep,
  reserveAttempt,
  transitionAttempt,
  type ModelRequest,
  type ModelResponse,
  type ModelStepResult,
} from '@knowscroll/backend/reasoning';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, type FixtureModel } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { fixtureModelQueue } from '../support/queues.js';

const silent: LogEvent = () => undefined;

describe('the reasoning attempt ledger driven by a worker job (real database, real pg-boss, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('reasoning');
  });
  afterAll(async () => {
    await database.drop();
  });

  function executeModelStep(model: FixtureModel, options: { readonly crashBeforeRecording?: () => boolean } = {}) {
    return makeExecuteModelStep({
      withPersonalScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      model,
      hashRequest: (request) => requestHash('fixture.model-step', { purpose: request.purpose, input: request.input }),
      admitRun: (scope, run) => admitRun(scope, run),
      findAttempt,
      reserveAttempt,
      transitionAttempt: (scope, attemptId, from, to, details) => {
        // Simulated process crash: the outcome is never recorded after a dispatched call.
        if (from === 'dispatched' && options.crashBeforeRecording?.() === true)
          throw new Error('simulated crash before recording the outcome');
        return transitionAttempt(scope, attemptId, from, to, details);
      },
      newId: randomUUID,
    });
  }

  async function attempts(universeId: string) {
    return database.db
      .selectFrom('reasoning.external_attempts')
      .select(['state', 'outcome_code', 'remote_id'])
      .where('universe_id', '=', universeId)
      .execute();
  }

  /** Runs one fixture-model job through a real pg-boss consumer until it completes or fails for good. */
  async function runJob(
    person: Awaited<ReturnType<typeof seedPerson>>,
    model: FixtureModel,
    crashOnFirstDelivery: boolean,
  ) {
    const results: ModelStepResult[] = [];
    let deliveries = 0;
    const execute = executeModelStep(model, { crashBeforeRecording: () => crashOnFirstDelivery && deliveries === 1 });
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    await startConsumers(
      worker,
      [
        jobConsumer(fixtureModelQueue, async (payload, delivery) => {
          deliveries += 1;
          const authority = {
            universeId: payload.universeId,
            privacyEpoch: payload.privacyEpoch,
            actor: { kind: 'system', purpose: 'fixture.model-step' },
          } as const;
          results.push(
            await execute(
              authority,
              {
                runId: payload.runId,
                ownerModule: 'fixture',
                purpose: 'fixture-step',
                step: 'only-step',
                request: { purpose: 'fixture', input: 'fixture input' },
              },
              delivery.signal,
            ),
          );
        }),
      ],
      silent,
    );
    const runId = randomUUID();
    await worker.send(fixtureModelQueue.name, { v: 1, universeId: person.universeId, privacyEpoch: 1, runId });
    try {
      await expect
        .poll(async () => (await worker.findJobs(fixtureModelQueue.name, { data: { runId } }))[0]?.state, {
          timeout: 30_000,
          interval: 250,
        })
        .toBe('completed');
    } finally {
      await drainConsumers(worker, 1, 5_000, silent);
    }
    return { results, deliveries };
  }

  it('reserves, commits dispatch intent, calls the model outside any transaction and records success', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const { results, deliveries } = await runJob(person, model, false);
    expect(deliveries).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(results).toEqual([expect.objectContaining({ kind: 'succeeded', output: 'fixture:fixture' })]);
    expect(await attempts(person.universeId)).toEqual([
      { state: 'succeeded', outcome_code: null, remote_id: 'fixture-remote-1' },
    ]);
  });

  it('leaves unknown after a crash following dispatch, and the redelivery never sends again', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const { results, deliveries } = await runJob(person, model, true);
    expect(deliveries).toBe(2);
    expect(model.calls).toHaveLength(1);
    expect(results).toEqual([expect.objectContaining({ kind: 'unknown' })]);
    expect(await attempts(person.universeId)).toEqual([
      { state: 'unknown', outcome_code: 'OUTCOME_NOT_RECORDED', remote_id: null },
    ]);
  });

  it('records a conclusive rejection as failed and a transport error as unknown', async () => {
    const rejected = await seedPerson(database.db);
    const rejecting = fixtureModel(() => Promise.reject(new ModelRejectedError('FIXTURE_REJECTED')));
    await runJob(rejected, rejecting, false);
    expect(await attempts(rejected.universeId)).toEqual([
      { state: 'failed', outcome_code: 'FIXTURE_REJECTED', remote_id: null },
    ]);

    const timedOut = await seedPerson(database.db);
    const timingOut = fixtureModel((): Promise<ModelResponse> => Promise.reject(new Error('fixture socket timeout')));
    await runJob(timedOut, timingOut, false);
    expect(timingOut.calls).toHaveLength(1);
    expect(await attempts(timedOut.universeId)).toEqual([
      { state: 'unknown', outcome_code: 'TRANSPORT_OUTCOME_UNKNOWN', remote_id: null },
    ]);
  });

  it('does not run a step for a universe whose epoch moved on', async () => {
    const person = await seedPerson(database.db);
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    const model = fixtureModel();
    const request: ModelRequest = { purpose: 'fixture', input: 'x' };
    const result = await executeModelStep(model)(
      { universeId: person.universeId, privacyEpoch: 1, actor: { kind: 'system', purpose: 'fixture' } },
      { runId: randomUUID(), ownerModule: 'fixture', purpose: 'fixture', step: 'only-step', request },
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(model.calls).toHaveLength(0);
  });
});
