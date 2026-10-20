import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import { makeAuthorityHolds, makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { AuthorityHolds } from '@knowscroll/backend/modules/identity';
import type { ProposeOutcome } from '@knowscroll/backend/reasoning';
import {
  makeAttemptLedger,
  reasoningOperatorFor,
  type AttemptLedger,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  advanceEpoch,
  attemptsOf,
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  gate,
  receiptsOf,
  signal,
  silent,
  systemAuthority,
} from '../support/fixture-model.js';
import { type FixtureModelPort, type FixtureScenario } from '../support/fixture-model-port.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { fixtureModelQueue } from '../support/queues.js';

/** Who ran the write-offs in these tests (the operator command records `cli:<name>`). */
const ci = 'cli:ci-fixture';

/**
 * Every attempt-ledger transition through the harness (blueprint §15 state machine), against a real
 * database and a real pg-boss consumer, with the labelled fixture model. Evidence label: CI fixture
 * + real database.
 */
describe('the reasoning attempt ledger (real database, real pg-boss, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('reasoning');
  });
  afterAll(async () => {
    await database.drop();
  });

  const echo = (output: ProposeOutcome<unknown>) => (output.kind === 'proposed' ? output.output : undefined);

  function harness(
    model: FixtureModelPort,
    options: { readonly crashBeforeSettling?: () => boolean; readonly authorityHolds?: AuthorityHolds } = {},
  ) {
    const ledger = makeAttemptLedger(database.db);
    const crashing: AttemptLedger = {
      ...ledger,
      settle: (attempt, from, to, details) => {
        // Simulated process crash: the outcome of a dispatched call is never recorded.
        if (from === 'dispatched' && options.crashBeforeSettling?.() === true)
          return Promise.reject(new Error('simulated crash before recording the outcome'));
        return ledger.settle(attempt, from, to, details);
      },
    };
    return fixtureHarness(database.db, {
      model,
      overrides: {
        ledger: crashing,
        ...(options.authorityHolds === undefined ? {} : { authorityHolds: options.authorityHolds }),
      },
    }).harness;
  }

  const propose = (h: ReturnType<typeof harness>, person: FixturePerson, runId: string, context = fixtureContext) =>
    h.propose({ run: fixtureRun(systemAuthority(person.universeId), runId), role: echoRole, context }, signal());

  /** Runs one fixture-model job through a real pg-boss consumer until it completes. */
  async function runJob(person: FixturePerson, model: FixtureModelPort, crashOnFirstDelivery: boolean) {
    const results: ProposeOutcome<unknown>[] = [];
    let deliveries = 0;
    const h = harness(model, { crashBeforeSettling: () => crashOnFirstDelivery && deliveries === 1 });
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    await startConsumers(
      worker,
      [
        jobConsumer(fixtureModelQueue, async (payload, delivery) => {
          deliveries += 1;
          results.push(
            await h.propose(
              {
                run: fixtureRun(systemAuthority(payload.universeId, payload.privacyEpoch), payload.runId),
                role: echoRole,
                context: fixtureContext,
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
    return { results, deliveries, runId };
  }

  const states = async (universeId: string) =>
    (await attemptsOf(database.db, universeId)).map((row) => ({
      step: row.step,
      state: row.state,
      outcome: row.outcome_code,
      remote: row.remote_id,
      settled: row.settled_at !== null,
    }));

  it('reserves, commits dispatch intent, sends once outside any transaction and records success with usage', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const { results, deliveries } = await runJob(person, model, false);
    expect(deliveries).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(results.map(echo)).toEqual([{ ok: true, echo: 'lantern' }]);
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'succeeded', outcome: 'SUCCEEDED', remote: 'fixture-remote-1', settled: true },
    ]);
    const [attempt] = await attemptsOf(database.db, person.universeId);
    expect(attempt).toMatchObject({
      output: { v: 1, text: '{"ok":true,"echo":"lantern"}' },
      input_tokens: 40,
      output_tokens: 12,
    });
    expect(await receiptsOf(database.db, [attempt?.id ?? ''])).toEqual([
      expect.objectContaining({ state: 'settled', input_tokens: 40, output_tokens: 12, late_usage: false }),
    ]);
  });

  it('leaves unknown after a crash following dispatch, and the redelivery never sends again', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    const { results, deliveries } = await runJob(person, model, true);
    expect(deliveries).toBe(2);
    expect(model.calls).toHaveLength(1);
    expect(results).toEqual([expect.objectContaining({ kind: 'unknown' })]);
    // `unknown` is open liability, not a settlement.
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'unknown', outcome: 'OUTCOME_NOT_RECORDED', remote: null, settled: false },
    ]);
    const [attempt] = await attemptsOf(database.db, person.universeId);
    expect(await receiptsOf(database.db, [attempt?.id ?? ''])).toEqual([expect.objectContaining({ state: 'unknown' })]);
  });

  it.each<[string, FixtureScenario, string, string]>([
    ['a rate limit (429)', { kind: 'rate_limited' }, 'failed', 'HTTP_429_RATE_LIMIT_ERROR'],
    ['a server error (500)', { kind: 'server_error' }, 'failed', 'HTTP_500'],
    ['a gateway timeout (504)', { kind: 'gateway_timeout' }, 'unknown', 'HTTP_504'],
    ['a timeout after dispatch', { kind: 'timeout_after_dispatch' }, 'unknown', 'TIMEOUT_AFTER_DISPATCH'],
  ])('records %s as %s, and a redelivery never resends it', async (_label, scenario, state, code) => {
    const person = await seedPerson(database.db);
    const model = fixtureModel(() => scenario);
    const h = harness(model);
    const runId = randomUUID();
    const first = await propose(h, person, runId);
    const again = await propose(h, person, runId);
    expect(first).toEqual(
      state === 'failed'
        ? { kind: 'failed', attemptId: expect.any(String) as unknown, code }
        : { kind: 'unknown', attemptId: expect.any(String) as unknown },
    );
    expect(again).toEqual(first);
    expect(model.calls).toHaveLength(1);
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state, outcome: code, remote: null, settled: state === 'failed' },
    ]);
  });

  it('records the outcome even when authority changes during the call, and withholds the output', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => {
      inFlight.open();
      return { kind: 'hold', until: release.promise };
    });
    const running = propose(harness(model), person, randomUUID());
    await inFlight.promise;
    await advanceEpoch(database.db, person.universeId);
    release.open({ kind: 'success', text: '{"ok": true, "echo": "stale"}', remoteId: 'fixture-late' });
    expect(await running).toEqual({
      kind: 'refused',
      reason: 'output_ineligible',
      attemptId: expect.any(String) as unknown,
    });
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'succeeded', outcome: 'SUCCEEDED', remote: 'fixture-late', settled: true },
    ]);
  });

  it('checks eligibility without the personal lock, so a busy universe cannot cost a paid answer', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => {
      inFlight.open();
      return { kind: 'hold', until: release.promise };
    });
    const running = propose(harness(model), person, randomUUID());
    await inFlight.promise;
    // Another transaction holds the personal root from now until the step has returned.
    const holding = gate();
    const locked = gate();
    const holder = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(
      systemAuthority(person.universeId),
      async () => {
        locked.open();
        await holding.promise;
      },
    );
    await locked.promise;
    release.open({ kind: 'success', text: '{"ok": true, "echo": "busy"}', remoteId: 'fixture-busy' });
    expect(echo(await running)).toEqual({ ok: true, echo: 'busy' });
    holding.open();
    await holder;
  });

  it('keeps a paid answer when the eligibility check fails, and the redelivery applies it without a second call', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel(() => ({
      kind: 'success',
      text: '{"ok": true, "echo": "kept"}',
      remoteId: 'fixture-kept',
    }));
    const holds = makeAuthorityHolds(database.db);
    let failures = 1;
    const flaky: AuthorityHolds = (authority) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('fixture: eligibility read failed'));
      }
      return holds(authority);
    };
    const h = harness(model, { authorityHolds: flaky });
    const runId = randomUUID();
    await expect(propose(h, person, runId)).rejects.toThrow('eligibility read failed');
    expect(echo(await propose(h, person, runId))).toEqual({ ok: true, echo: 'kept' });
    expect(model.calls).toHaveLength(1);
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'succeeded', outcome: 'SUCCEEDED', remote: 'fixture-kept', settled: true },
    ]);
  });

  it('marks a reserved attempt not_sent when authority is gone before dispatch, and sends nothing', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    let crashes = 1;
    // A delivery that dies after reserving (here: during the quota preflight) leaves a reserved attempt.
    const h = harness({
      ...model,
      observeQuota: (abort) => {
        if (crashes > 0) {
          crashes -= 1;
          return Promise.reject(new Error('fixture: process died after reserving'));
        }
        return model.observeQuota(abort);
      },
    });
    const runId = randomUUID();
    await expect(propose(h, person, runId)).rejects.toThrow('process died after reserving');
    expect((await states(person.universeId)).map((row) => row.state)).toEqual(['reserved']);
    await advanceEpoch(database.db, person.universeId);
    expect(await propose(h, person, runId)).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(model.calls).toHaveLength(0);
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'not_sent', outcome: 'AUTHORITY_REFUSED', remote: null, settled: true },
    ]);
  });

  it('dispatches a reserved attempt left by an earlier delivery with its stored bytes, once', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel();
    let crashes = 1;
    const h = harness({
      ...model,
      observeQuota: (abort) => {
        if (crashes > 0) {
          crashes -= 1;
          return Promise.reject(new Error('fixture: process died after reserving'));
        }
        return model.observeQuota(abort);
      },
    });
    const runId = randomUUID();
    await expect(propose(h, person, runId)).rejects.toThrow('process died after reserving');
    expect(echo(await propose(h, person, runId))).toEqual({ ok: true, echo: 'lantern' });
    expect(model.calls).toHaveLength(1);
    expect((await states(person.universeId)).map((row) => `${row.step}:${row.state}`)).toEqual(['primary:succeeded']);
  });

  it('refuses a redelivery whose request differs from the recorded one', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel(() => ({ kind: 'timeout_after_dispatch' }));
    const h = harness(model);
    const runId = randomUUID();
    await propose(h, person, runId);
    const changed = {
      ...fixtureContext,
      items: [{ ref: 'fixture:item-1', kind: 'evidence', text: 'The word is: candle' }],
    };
    expect(await propose(h, person, runId, changed)).toEqual({ kind: 'refused', reason: 'request_mismatch' });
    expect(model.calls).toHaveLength(1);
  });

  it('sends a step once when two deliveries run at the same time', async () => {
    const person = await seedPerson(database.db);
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => ({ kind: 'hold', until: release.promise }));
    const h = harness(model);
    const runId = randomUUID();
    const both = Promise.all([propose(h, person, runId), propose(h, person, runId)]);
    await expect.poll(() => model.calls.length, { timeout: 10_000 }).toBe(1);
    release.open({ kind: 'success', text: '{"ok": true, "echo": "once"}', remoteId: 'fixture-concurrent' });
    const results = (await both).map((result) =>
      result.kind === 'proposed' ? `proposed${result.reconciled ? ':reconciled' : ''}` : result.kind,
    );
    expect(model.calls).toHaveLength(1);
    // Either the second delivery lost the dispatch race, or it saw the first in flight, marked it
    // unknown, and the first recorded its late answer as reconciled.
    expect([JSON.stringify(['proposed', 'refused']), JSON.stringify(['proposed:reconciled', 'unknown'])]).toContain(
      JSON.stringify(results.sort()),
    );
  });

  it('records a late conclusive answer as reconciled after a redelivery marked the attempt unknown', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => {
      inFlight.open();
      return { kind: 'hold', until: release.promise };
    });
    const h = harness(model);
    const runId = randomUUID();
    const first = propose(h, person, runId);
    await inFlight.promise;
    // pg-boss believed the first delivery lost (expiry) and redelivered: the attempt is dispatched.
    expect(await propose(h, person, runId)).toEqual({ kind: 'unknown', attemptId: expect.any(String) as unknown });
    release.open({ kind: 'success', text: '{"ok": true, "echo": "late"}', remoteId: 'fixture-late' });
    expect(await first).toMatchObject({ kind: 'proposed', output: { ok: true, echo: 'late' }, reconciled: true });
    expect(model.calls).toHaveLength(1);
    // The reconciled row records the late answer's real result, and keeps its output.
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'reconciled', outcome: 'SUCCEEDED', remote: 'fixture-late', settled: true },
    ]);
    // A later delivery answers from the ledger with the stored output, without calling again.
    expect(await propose(h, person, runId)).toMatchObject({
      kind: 'proposed',
      output: { ok: true, echo: 'late' },
      reconciled: true,
    });
    expect(model.calls).toHaveLength(1);
  });

  it('does not run a step for a universe whose epoch moved on', async () => {
    const person = await seedPerson(database.db);
    await advanceEpoch(database.db, person.universeId);
    const model = fixtureModel();
    expect(await propose(harness(model), person, randomUUID())).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(model.calls).toHaveLength(0);
    expect(await states(person.universeId)).toEqual([]);
  });

  it('writes off an unknown attempt with its reason (operator), and never resends it', async () => {
    const person = await seedPerson(database.db);
    const model = fixtureModel(() => ({ kind: 'timeout_after_dispatch' }));
    const h = harness(model);
    const runId = randomUUID();
    const unknown = await propose(h, person, runId);
    if (unknown.kind !== 'unknown') throw new Error(`expected unknown, got ${unknown.kind}`);
    const operator = reasoningOperatorFor(database.db, silent);
    expect(await operator.listUnknown(500)).toEqual(
      expect.arrayContaining([expect.objectContaining({ attemptId: unknown.attemptId, roleId: 'fixture.echo' })]),
    );
    expect(
      await operator.writeOff(unknown.attemptId, 'CI fixture: no provider lookup; accepted as unresolved', ci),
    ).toEqual({
      kind: 'written_off',
      attemptId: unknown.attemptId,
    });
    const [attempt] = await attemptsOf(database.db, person.universeId);
    expect(attempt).toMatchObject({
      state: 'written_off',
      outcome_code: 'TIMEOUT_AFTER_DISPATCH',
      written_off_reason: 'CI fixture: no provider lookup; accepted as unresolved',
      written_off_by: ci,
    });
    expect(await receiptsOf(database.db, [unknown.attemptId])).toEqual([
      expect.objectContaining({ state: 'written_off' }),
    ]);
    expect(await propose(h, person, runId)).toEqual({
      kind: 'refused',
      reason: 'attempt_written_off',
      attemptId: unknown.attemptId,
    });
    expect(model.calls).toHaveLength(1);
    // Repeating the write-off changes nothing; bad requests are refused before the ledger.
    expect(await operator.writeOff(unknown.attemptId, 'again', ci)).toEqual({
      kind: 'not_unknown',
      attemptId: unknown.attemptId,
      state: 'written_off',
    });
    expect(await operator.writeOff(randomUUID(), 'no such attempt', ci)).toEqual({ kind: 'missing' });
    expect(await operator.writeOff('not-a-uuid', 'x', ci)).toMatchObject({ kind: 'invalid_request' });
    expect(await operator.writeOff(unknown.attemptId, 'x', 'someone')).toMatchObject({
      kind: 'invalid_request',
      problem: 'source_not_a_cli_name',
    });
    expect(await operator.writeOff(unknown.attemptId, '   ', ci)).toMatchObject({ kind: 'invalid_request' });
  });

  it('refuses to write off an attempt that is not unknown', async () => {
    const person = await seedPerson(database.db);
    const result = await propose(harness(fixtureModel()), person, randomUUID());
    if (result.kind !== 'proposed') throw new Error(`expected proposed, got ${result.kind}`);
    expect(await reasoningOperatorFor(database.db, silent).writeOff(result.attemptId, 'should not apply', ci)).toEqual({
      kind: 'not_unknown',
      attemptId: result.attemptId,
      state: 'succeeded',
    });
  });

  it('records late usage on the receipt when a written-off attempt’s answer arrives, and never applies it', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => {
      inFlight.open();
      return { kind: 'hold', until: release.promise };
    });
    const h = harness(model);
    const runId = randomUUID();
    const first = propose(h, person, runId);
    await inFlight.promise;
    const marked = await propose(h, person, runId);
    if (marked.kind !== 'unknown') throw new Error(`expected unknown, got ${marked.kind}`);
    await reasoningOperatorFor(database.db, silent).writeOff(
      marked.attemptId,
      'CI fixture: written off while in flight',
      ci,
    );
    release.open({
      kind: 'success',
      text: '{"ok": true, "echo": "too late"}',
      usage: { inputTokens: 77, outputTokens: 9 },
    });
    expect(await first).toEqual({ kind: 'refused', reason: 'attempt_written_off', attemptId: marked.attemptId });
    expect(await receiptsOf(database.db, [marked.attemptId])).toEqual([
      expect.objectContaining({ state: 'written_off', input_tokens: 77, output_tokens: 9, late_usage: true }),
    ]);
    expect((await attemptsOf(database.db, person.universeId))[0]).toMatchObject({ state: 'written_off', output: null });
  });
});
