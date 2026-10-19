import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import {
  ModelRejectedError,
  makeExecuteModelStep,
  type AttemptLedger,
  type ModelRequest,
  type ModelResponse,
  type ModelStepResult,
} from '@knowscroll/backend/reasoning';
import { makeAttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, gate, type FixtureModel } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { fixtureModelQueue } from '../support/queues.js';

const silent: LogEvent = () => undefined;
const signal = () => new AbortController().signal;

describe('the reasoning attempt ledger (real database, real pg-boss, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('reasoning');
  });
  afterAll(async () => {
    await database.drop();
  });

  function executeModelStep(model: FixtureModel, options: { readonly crashBeforeSettling?: () => boolean } = {}) {
    const ledger = makeAttemptLedger(database.db);
    const crashing: AttemptLedger = {
      ...ledger,
      settle: (attempt, from, to, details) => {
        // Simulated process crash: the outcome of a dispatched call is never recorded.
        if (from === 'dispatched' && options.crashBeforeSettling?.() === true)
          throw new Error('simulated crash before recording the outcome');
        return ledger.settle(attempt, from, to, details);
      },
    };
    return makeExecuteModelStep({
      withPersonalScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      model,
      ledger: crashing,
      hashRequest: (request) => requestHash('fixture.model-step', { purpose: request.purpose, input: request.input }),
      newId: randomUUID,
    });
  }

  const step = (runId: string, request: ModelRequest = { purpose: 'fixture', input: 'fixture input' }) => ({
    runId,
    ownerModule: 'fixture',
    purpose: 'fixture-step',
    step: 'only-step',
    request,
  });
  const systemAuthority = (person: FixturePerson) =>
    ({
      universeId: person.universeId,
      privacyEpoch: 1,
      actor: { kind: 'system', purpose: 'fixture.model-step' },
    }) as const;

  async function attempts(universeId: string) {
    return database.db
      .selectFrom('reasoning.external_attempts')
      .select(['state', 'outcome_code', 'remote_id'])
      .where('universe_id', '=', universeId)
      .execute();
  }

  /** Runs one fixture-model job through a real pg-boss consumer until it completes. */
  async function runJob(person: FixturePerson, model: FixtureModel, crashOnFirstDelivery: boolean) {
    const results: ModelStepResult[] = [];
    let deliveries = 0;
    const execute = executeModelStep(model, { crashBeforeSettling: () => crashOnFirstDelivery && deliveries === 1 });
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    await startConsumers(
      worker,
      [
        jobConsumer(fixtureModelQueue, async (payload, delivery) => {
          deliveries += 1;
          results.push(
            await execute(
              {
                universeId: payload.universeId,
                privacyEpoch: payload.privacyEpoch,
                actor: { kind: 'system', purpose: 'fixture.model-step' },
              },
              step(payload.runId),
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
    await runJob(
      rejected,
      fixtureModel(() => Promise.reject(new ModelRejectedError('FIXTURE_REJECTED'))),
      false,
    );
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

  it('records the outcome even when authority changes during the call, and withholds the output', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<ModelResponse>();
    const model = fixtureModel(() => {
      inFlight.open();
      return release.promise;
    });
    const running = executeModelStep(model)(systemAuthority(person), step(randomUUID()), signal());
    await inFlight.promise;
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    release.open({ remoteId: 'fixture-late', output: 'stale output' });
    expect(await running).toEqual({ kind: 'ineligible', attemptId: expect.any(String) as unknown });
    expect(await attempts(person.universeId)).toEqual([
      { state: 'succeeded', outcome_code: null, remote_id: 'fixture-late' },
    ]);
  });

  it('marks an attempt not_sent when authority is gone before dispatch', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const runId = randomUUID();
    const execute = executeModelStep(model);
    // Reserve under the original epoch, then lose authority before the next delivery dispatches.
    const ledger = makeAttemptLedger(database.db);
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(systemAuthority(person), async (scope) => {
      await ledger.admitRun(scope, { id: runId, ownerModule: 'fixture', purpose: 'fixture-step' });
      await ledger.reserve(scope, {
        id: randomUUID(),
        runId,
        step: 'only-step',
        provider: 'fixture',
        model: 'fixture-model-v0',
        requestHash: requestHash('fixture.model-step', { purpose: 'fixture', input: 'fixture input' }),
      });
    });
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect(await execute(systemAuthority(person), step(runId), signal())).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    expect(model.calls).toHaveLength(0);
    expect(await attempts(person.universeId)).toEqual([
      { state: 'not_sent', outcome_code: 'AUTHORITY_REFUSED', remote_id: null },
    ]);
  });

  it('refuses a redelivery whose request differs from the recorded one', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel(() => Promise.reject(new Error('fixture transport error')));
    const runId = randomUUID();
    const execute = executeModelStep(model);
    await execute(systemAuthority(person), step(runId), signal());
    expect(
      await execute(systemAuthority(person), step(runId, { purpose: 'fixture', input: 'a different input' }), signal()),
    ).toEqual({ kind: 'refused', reason: 'request_mismatch' });
    expect(model.calls).toHaveLength(1);
  });

  it('sends a step once when two deliveries run at the same time', async () => {
    const person = await seedPerson(database.db);
    const release = gate<ModelResponse>();
    const model = fixtureModel(() => release.promise);
    const runId = randomUUID();
    const execute = executeModelStep(model);
    const both = Promise.all([
      execute(systemAuthority(person), step(runId), signal()),
      execute(systemAuthority(person), step(runId), signal()),
    ]);
    await expect.poll(() => model.calls.length, { timeout: 10_000 }).toBe(1);
    release.open({ remoteId: 'fixture-concurrent', output: 'once' });
    const results = (await both).map((result) => result.kind).sort();
    expect(model.calls).toHaveLength(1);
    // Either the second delivery lost the dispatch race, or it saw the first in flight, marked it
    // unknown, and the first recorded its late answer as reconciled.
    expect([JSON.stringify(['refused', 'succeeded']), JSON.stringify(['reconciled', 'unknown'])]).toContain(
      JSON.stringify(results),
    );
  });

  it('records a late conclusive answer as reconciled after a redelivery marked the attempt unknown', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<ModelResponse>();
    const model = fixtureModel(() => {
      inFlight.open();
      return release.promise;
    });
    const runId = randomUUID();
    const execute = executeModelStep(model);
    const first = execute(systemAuthority(person), step(runId), signal());
    await inFlight.promise;
    // pg-boss believed the first delivery lost (expiry) and redelivered: the attempt is dispatched.
    expect(await execute(systemAuthority(person), step(runId), signal())).toEqual({
      kind: 'unknown',
      attemptId: expect.any(String) as unknown,
    });
    release.open({ remoteId: 'fixture-late', output: 'late but conclusive' });
    expect(await first).toEqual({
      kind: 'reconciled',
      attemptId: expect.any(String) as unknown,
      output: 'late but conclusive',
    });
    expect(model.calls).toHaveLength(1);
    expect(await attempts(person.universeId)).toEqual([
      { state: 'reconciled', outcome_code: 'OUTCOME_NOT_RECORDED', remote_id: 'fixture-late' },
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
    expect(await executeModelStep(model)(systemAuthority(person), step(randomUUID()), signal())).toEqual({
      kind: 'refused',
      reason: 'scope_refused',
    });
    expect(model.calls).toHaveLength(0);
  });
});
