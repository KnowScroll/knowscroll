import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { accountAccessUseCases, recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { fencePersonalRecording } from '@knowscroll/backend/infrastructure/postgres';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { REQUEST_PLANNER, type RequestPlanner } from '@knowscroll/backend/modules/planner';
import {
  plannerRequestProviders,
  plannerStore,
  plannerContextItems,
  makeCheckPlannerRecordingRun,
  type FrozenContext,
  type PlannerPorts,
} from '@knowscroll/backend/modules/planner/nest-providers';
import { geographyStore, makeCheckGeographyRecordingRun } from '@knowscroll/backend/modules/geography/nest-providers';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import type { PersonalRecordingPurpose } from '@knowscroll/backend/reasoning';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases } from '../support/scroll.js';
import { recordingPerson } from '../support/recording-person.js';
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
  // Unresolved liabilities and failure receipts intentionally survive within a case, not across unrelated cases.
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('reasoning');
  });
  afterEach(async () => {
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
    });
    expect(await states(person.universeId)).toEqual([
      { step: 'primary', state: 'succeeded', outcome: 'SUCCEEDED', remote: 'fixture-late', settled: true },
    ]);
    const [attempt] = await attemptsOf(database.db, person.universeId);
    expect(await receiptsOf(database.db, [attempt!.id])).toEqual([
      expect.objectContaining({ state: 'settled', input_tokens: 40, output_tokens: 12 }),
    ]);
    expect(model.calls).toHaveLength(1);
  });

  it('settles the paid answer while busy, withholds its protected read, then replays once after releasing the root', async () => {
    const person = await seedPerson(database.db);
    const inFlight = gate();
    const release = gate<FixtureScenario>();
    const model = fixtureModel(() => {
      inFlight.open();
      return { kind: 'hold', until: release.promise };
    });
    const h = harness(model),
      runId = randomUUID();
    const running = propose(h, person, runId);
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
    try {
      await expect(running).rejects.toMatchObject({ name: 'ScopeBusyError' });
      const [attempt] = await attemptsOf(database.db, person.universeId);
      expect(attempt).toMatchObject({ state: 'succeeded', outcome_code: 'SUCCEEDED', remote_id: 'fixture-busy' });
      expect(attempt!.settled_at).not.toBeNull();
      expect(await receiptsOf(database.db, [attempt!.id])).toEqual([
        expect.objectContaining({ state: 'settled', input_tokens: 40, output_tokens: 12 }),
      ]);
    } finally {
      holding.open();
      await holder;
    }
    expect(echo(await propose(h, person, runId))).toEqual({ ok: true, echo: 'busy' });
    expect(model.calls).toHaveLength(1);
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
    const [stopped] = await attemptsOf(database.db, person.universeId);
    expect(await receiptsOf(database.db, [stopped!.id])).toEqual([expect.objectContaining({ state: 'released' })]);
  });

  async function cancellationFixture(missingCapability = false) {
    const person = await seedPerson(database.db),
      model = fixtureModel(),
      runId = randomUUID();
    const ledger = makeAttemptLedger(database.db),
      selected = { ...ledger };
    if (missingCapability) delete selected.releaseUndispatchedPersonal;
    const h = fixtureHarness(database.db, {
      model: { ...model, observeQuota: () => Promise.reject(new Error('CI_RESERVED_BEFORE_QUOTA')) },
      overrides: { ledger: selected },
    }).harness;
    await expect(propose(h, person, runId)).rejects.toThrow('CI_RESERVED_BEFORE_QUOTA');
    const [attempt] = await attemptsOf(database.db, person.universeId);
    if (!attempt) throw new Error('CI_RESERVED_ATTEMPT_MISSING');
    const input = {
      scopeId: person.universeId,
      privacyEpoch: 1,
      step: 'primary' as const,
      requestHash: attempt.request_hash,
      run: {
        id: runId,
        ownerModule: 'fixture',
        purpose: 'fixture-echo',
        policyVersion: 'fixture.v1',
        roleId: echoRole.id,
        roleVersion: echoRole.version,
        provider: model.provider,
        model: model.model,
        contextBundleRef: fixtureContext.bundleRef,
        contextRefs: fixtureContext.items.map((item) => item.ref),
      },
    };
    return { person, model, runId, ledger, h, attempt, input };
  }
  it('keeps the reservation held when the explicitly personal cancellation capability is unavailable', async () => {
    const f = await cancellationFixture(true);
    await advanceEpoch(database.db, f.person.universeId);
    expect(await propose(f.h, f.person, f.runId)).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(await states(f.person.universeId)).toEqual([
      { step: 'primary', state: 'reserved', outcome: null, remote: null, settled: false },
    ]);
    expect(await receiptsOf(database.db, [f.attempt.id])).toEqual([expect.objectContaining({ state: 'held' })]);
    expect(f.model.calls).toHaveLength(0);
  });
  it.each([
    'run',
    'descriptor',
    'epoch',
    'request',
    'receipt_missing',
    'receipt_mismatch',
    'proof',
    'receipt_not_held',
    'receipt_usage',
    'erased_attempt',
    'attempt_settled',
    'dispatch_id',
    'dispatched',
    'unknown',
    'overflow',
  ] as const)('refuses necessary cancellation for %s without changing retained accounting', async (mode) => {
    const f = await cancellationFixture();
    let input = f.input;
    if (mode === 'run') input = { ...input, run: { ...input.run, id: randomUUID() } };
    if (mode === 'descriptor') input = { ...input, run: { ...input.run, purpose: 'other-purpose' } };
    if (mode === 'epoch') input = { ...input, privacyEpoch: 2 };
    if (mode === 'request') input = { ...input, requestHash: '0'.repeat(64) };
    if (mode === 'receipt_missing')
      await database.db.deleteFrom('reasoning.usage_receipts').where('attempt_id', '=', f.attempt.id).execute();
    if (mode === 'receipt_mismatch')
      await database.db
        .updateTable('reasoning.usage_receipts')
        .set({ model: 'different-model' })
        .where('attempt_id', '=', f.attempt.id)
        .execute();
    if (mode === 'receipt_not_held')
      await database.db
        .updateTable('reasoning.usage_receipts')
        .set({ state: 'unknown' })
        .where('attempt_id', '=', f.attempt.id)
        .execute();
    if (mode === 'receipt_usage')
      await database.db
        .updateTable('reasoning.usage_receipts')
        .set({ input_tokens: 1 })
        .where('attempt_id', '=', f.attempt.id)
        .execute();
    if (mode === 'erased_attempt')
      await database.db
        .updateTable('reasoning.external_attempts')
        .set({ privacy_erased_at: new Date() })
        .where('id', '=', f.attempt.id)
        .execute();
    if (mode === 'attempt_settled')
      await database.db
        .updateTable('reasoning.external_attempts')
        .set({ settled_at: new Date() })
        .where('id', '=', f.attempt.id)
        .execute();
    if (mode === 'dispatch_id')
      await database.db
        .updateTable('reasoning.external_attempts')
        .set({ dispatch_id: randomUUID() })
        .where('id', '=', f.attempt.id)
        .execute();
    if (mode === 'dispatched' || mode === 'unknown') {
      const entered = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(f.person.authority, (scope) =>
        f.ledger.commitDispatch(scope, f.attempt.id, {
          dispatchId: randomUUID(),
          dispatchedBy: 'ci-cancel-negative',
          quota: {
            verdict: 'not_applicable',
            intervalRemainingPercent: null,
            weeklyRemainingPercent: null,
          },
        }),
      );
      expect(entered).toEqual({ kind: 'entered', value: true });
      if (mode === 'unknown')
        expect(
          await f.ledger.settle({ scopeId: f.person.universeId, attemptId: f.attempt.id }, 'dispatched', 'unknown'),
        ).toBe(true);
    }
    if (mode === 'overflow') {
      const existing = await database.db
        .selectFrom('reasoning.external_attempts')
        .selectAll()
        .where('id', '=', f.attempt.id)
        .executeTakeFirstOrThrow();
      // Explicit malformed retained-history fixture, never a new production admission.
      for (let n = 2; n <= 9; n++)
        await database.db
          .insertInto('reasoning.external_attempts')
          .values({ ...existing, id: randomUUID(), step: `primary.${n}` })
          .execute();
    }
    const before = await attemptsOf(database.db, f.person.universeId),
      receipts = await receiptsOf(
        database.db,
        before.map((a) => a.id),
      );
    expect(
      await f.ledger.releaseUndispatchedPersonal!(
        mode === 'proof'
          ? {
              ...input,
              run: {
                ...input.run,
                recording: {
                  accountId: f.person.accountId,
                  generation: 1,
                  contextSha256: '0'.repeat(64),
                  modelContextSha256: '0'.repeat(64),
                },
              },
            }
          : input,
      ),
    ).toBe('unavailable');
    expect(await attemptsOf(database.db, f.person.universeId)).toEqual(before);
    expect(
      await receiptsOf(
        database.db,
        before.map((a) => a.id),
      ),
    ).toEqual(receipts);
    expect(f.model.calls).toHaveLength(0);
  });
  it('serializes cancellation with actual dispatch CAS: exactly one wins and no uncertain charge is refunded', async () => {
    const f = await cancellationFixture();
    const [cancelled, dispatched] = await Promise.all([
      f.ledger.releaseUndispatchedPersonal!(f.input),
      makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(f.person.authority, (scope) =>
        f.ledger.commitDispatch(scope, f.attempt.id, {
          dispatchId: randomUUID(),
          dispatchedBy: 'ci-cancel-race',
          quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
        }),
      ),
    ]);
    expect(dispatched.kind).toBe('entered');
    if (dispatched.kind !== 'entered') throw new Error('CI_DISPATCH_RACE_SCOPE');
    const [row] = await attemptsOf(database.db, f.person.universeId);
    if (cancelled === 'released') {
      expect(dispatched.value).toBe(false);
      expect(row).toMatchObject({ state: 'not_sent', outcome_code: 'AUTHORITY_REFUSED', dispatch_id: null });
      expect(await receiptsOf(database.db, [f.attempt.id])).toEqual([expect.objectContaining({ state: 'released' })]);
    } else {
      expect(dispatched.value).toBe(true);
      expect(row).toMatchObject({ state: 'dispatched', settled_at: null });
      expect(await receiptsOf(database.db, [f.attempt.id])).toEqual([expect.objectContaining({ state: 'held' })]);
    }
    expect(f.model.calls).toHaveLength(0);
  });

  it.each(['paused', 'resumed'] as const)(
    'releases only proved undispatched old initial1 work after actual %s generation revocation',
    async (mode) => {
      const f = await cancellationFixture();
      const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
      expect(
        await policy.set(f.person.authority, {
          version: 'recording-policy.v1',
          commandId: randomUUID(),
          expectedPrivacyEpoch: 1,
          expectedRecordingGeneration: 1,
          on: false,
        }),
      ).toMatchObject({ kind: 'ok' });
      if (mode === 'resumed')
        expect(
          await policy.set(f.person.authority, {
            version: 'recording-policy.v1',
            commandId: randomUUID(),
            expectedPrivacyEpoch: 1,
            expectedRecordingGeneration: 2,
            on: true,
          }),
        ).toMatchObject({ kind: 'ok' });
      expect(await propose(f.h, f.person, f.runId)).toEqual({ kind: 'refused', reason: 'scope_refused' });
      expect(await states(f.person.universeId)).toEqual([
        { step: 'primary', state: 'not_sent', outcome: 'AUTHORITY_REFUSED', remote: null, settled: true },
      ]);
      expect(await receiptsOf(database.db, [f.attempt.id])).toEqual([expect.objectContaining({ state: 'released' })]);
      expect(f.model.calls).toHaveLength(0);
    },
  );
  it.each(['wrong_account', 'wrong_account_old_epoch', 'unproved_owner_old_epoch'] as const)(
    'keeps reserved accounting held for %s without an actual own-account revocation proof',
    async (mode) => {
      const f = await cancellationFixture(),
        other = await seedPerson(database.db);
      if (mode !== 'wrong_account') await advanceEpoch(database.db, f.person.universeId);
      const authority = {
        ...f.person.authority,
        actor: {
          kind: 'account' as const,
          accountId: mode === 'unproved_owner_old_epoch' ? f.person.accountId : other.accountId,
        },
      };
      expect(
        await f.h.propose({ run: fixtureRun(authority, f.runId), role: echoRole, context: fixtureContext }, signal()),
      ).toEqual({ kind: 'refused', reason: 'scope_refused' });
      expect(await states(f.person.universeId)).toEqual([
        { step: 'primary', state: 'reserved', outcome: null, remote: null, settled: false },
      ]);
      expect(await receiptsOf(database.db, [f.attempt.id])).toEqual([expect.objectContaining({ state: 'held' })]);
      expect(f.model.calls).toHaveLength(0);
    },
  );
  it.each(['lookup', 'dispatch'] as const)('a stale owner claim cannot cancel current claim C at %s', async (phase) => {
    const person = await recordingPerson(database),
      c = await scrollUseCases(database, { recording: true });
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const identity = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 });
    const SCOPE = Symbol('CI.recording.scope'),
      ENQUEUE = Symbol('CI.recording.enqueue');
    const providers = plannerRequestProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
    const values = new Map<symbol, unknown>([
      [SCOPE, withScope],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [FENCE_OWN_ACCOUNT, identity.fenceOwnAccount],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    ]);
    for (const provider of providers)
      values.set(provider.provide, buildFromProviders(providers, provider.provide, values));
    const request = values.get(REQUEST_PLANNER) as RequestPlanner;
    const queue = values.get(providers[0]!.provide) as Pick<PlannerPorts, 'enqueue'>;
    try {
      const commandId = randomUUID(),
        accepted = await request(person.authority, { commandId, recordingGeneration: 1 });
      if (accepted.kind !== 'accepted') throw new Error('CI_ACTUAL_OWNER_REQUEST');
      const runId = accepted.runId,
        claimA = randomUUID(),
        claimC = randomUUID();
      const prepared = await withScope(person.authority, async (scope) => {
        expect((await identity.fenceOwnAccount(scope)).kind).toBe('active');
        const cap = await fencePersonalRecording(scope, 1);
        if (cap.kind !== 'recording') throw new Error('CI_ACTUAL_OWNER_RECORDING');
        const header = await plannerStore.header(scope, runId);
        if (!header?.normalWakeId) throw new Error('CI_ACTUAL_OWNER_HEADER');
        const evaluatedAt = new Date().toISOString(),
          snapshot = await c.readExploration(scope, {
            evaluatedAt,
            topicIds: [],
            candidates: [],
            provisionalLimit: 0,
          });
        expect(snapshot.proofAvailability).toBe('available');
        // Financial protocol fixture: valid empty current PC snapshot, not a positive Planner proposal.
        const context: FrozenContext = {
          version: 'planner-context.v0',
          evaluatedAt,
          desiredRevision: 1,
          contextRevision: snapshot.revision,
          scopeRevision: scope.revisionAtEntry,
          intent: { availability: 'unavailable', language: 'en', topicIds: [] },
          selection: {
            policy: 'plan_inventory_recent_union.v0',
            recentHasMore: false,
            topicsTruncated: false,
            inventoryBound: 100,
            completeness: 'not_asserted',
          },
          snapshot,
          facts: {
            evaluatedAt,
            topics: [],
            evidence: [],
            inventory: [],
            hiddenAssetIds: snapshot.routing.hiddenAssetIds,
          },
          currentPlan: [],
          memory: [],
        };
        const modelContext = { bundleRef: `planner:${runId}`, items: plannerContextItems(context) };
        const contextSha256 = canonicalSha256(context),
          modelContextSha256 = canonicalSha256(modelContext),
          until = new Date(Date.now() + 60000);
        expect(await plannerStore.consumeNormalWake(scope, runId, header.normalWakeId)).toBe(true);
        await plannerStore.writeRun(scope, {
          ...header,
          status: 'prepared',
          context,
          contextSha256,
          modelContextSha256,
          normalWakeId: undefined,
          claimId: claimA,
          claimUntil: until.toISOString(),
        });
        await queue.enqueue(cap.scope, runId, { startAfter: until, expectedClaimId: claimA });
        return { modelContext, contextSha256, modelContextSha256 };
      });
      if (prepared.kind !== 'entered') throw new Error('CI_ACTUAL_OWNER_PREPARE');
      async function renew() {
        const changed = await withScope(person.authority, async (scope) => {
          expect((await identity.fenceOwnAccount(scope)).kind).toBe('active');
          const cap = await fencePersonalRecording(scope, 1),
            header = await plannerStore.header(scope, runId);
          if (cap.kind !== 'recording' || !header) throw new Error('CI_ACTUAL_OWNER_RENEW');
          const until = new Date(Date.now() + 60000);
          await plannerStore.writeRun(scope, {
            ...header,
            claimId: claimC,
            claimWakeClaimId: undefined,
            claimUntil: until.toISOString(),
          });
          await queue.enqueue(cap.scope, runId, { startAfter: until, expectedClaimId: claimC });
        });
        expect(changed.kind).toBe('entered');
      }
      const model = fixtureModel(),
        ledger = makeAttemptLedger(database.db);
      let cancellations = 0;
      const guarded = {
        ...ledger,
        releaseUndispatchedPersonal: async (
          ...args: Parameters<NonNullable<AttemptLedger['releaseUndispatchedPersonal']>>
        ) => {
          cancellations++;
          return ledger.releaseUndispatchedPersonal!(...args);
        },
      };
      const harness = personalRecordingReasoningHarnessFor({
        db: database.db,
        withPersonalScope: withScope,
        fenceOwn: identity.fenceOwnAccount,
        model: {
          ...model,
          observeQuota: async (abort) => {
            if (phase === 'lookup') throw new Error('CI_OWNER_RESERVED');
            await renew();
            return model.observeQuota(abort);
          },
        },
        settings: fixtureHarness(database.db, { model }).ports.settings,
        logEvent: silent,
        overrides: { ledger: guarded },
        checkPlanner: makeCheckPlannerRecordingRun({ store: plannerStore, now: () => new Date() }),
        checkGeography: makeCheckGeographyRecordingRun({ store: geographyStore, now: () => new Date() }),
      });
      const purpose: PersonalRecordingPurpose = {
        version: 'personal-role-purpose.v1',
        accountId: person.accountId,
        universeId: person.universeId,
        privacyEpoch: 1,
        ownerModule: 'planner',
        purpose: 'personal-planner',
        businessRunId: runId,
        recordingGeneration: 1,
        claimId: claimA,
        contextSha256: prepared.value.contextSha256,
        modelContextSha256: prepared.value.modelContextSha256,
      };
      const input = {
        run: {
          ...fixtureRun(systemAuthority(person.universeId), runId),
          ownerModule: 'planner',
          purpose: 'personal-planner',
        },
        role: echoRole,
        context: prepared.value.modelContext,
        recordingPurpose: purpose,
      };
      if (phase === 'lookup') {
        await expect(harness.proposePersonal(input, signal())).rejects.toThrow('CI_OWNER_RESERVED');
        await renew();
      }
      const before = await attemptsOf(database.db, person.universeId);
      const result = await harness.proposePersonal(input, signal());
      expect(result).toEqual({ kind: 'refused', reason: 'scope_refused' });
      expect(cancellations).toBe(0);
      const after = await attemptsOf(database.db, person.universeId);
      if (phase === 'lookup') expect(after).toEqual(before);
      expect(after).toEqual([
        expect.objectContaining({ state: 'reserved', outcome_code: null, settled_at: null, dispatch_id: null }),
      ]);
      expect(
        await receiptsOf(
          database.db,
          after.map((a) => a.id),
        ),
      ).toEqual([expect.objectContaining({ state: 'held' })]);
      expect(
        await database.db
          .selectFrom('planner.runs')
          .select(['claim_id', 'claim_wake_claim_id'])
          .where('universe_id', '=', person.universeId)
          .where('id', '=', runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ claim_id: claimC, claim_wake_claim_id: claimC });
      expect(model.calls).toHaveLength(0);
    } finally {
      await c.close();
    }
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
