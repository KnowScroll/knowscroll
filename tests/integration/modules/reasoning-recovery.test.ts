import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeMiniMaxModelPort,
  reasoningOperatorFor,
  type AttemptLedger,
  type HarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { type FixtureScenario } from '../support/fixture-model-port.js';
import {
  advanceEpoch,
  attemptsOf,
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  fixtureSettings,
  gate,
  protectedRequestsOf,
  receiptsOf,
  signal,
  silent,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

/**
 * Review fixes for the reasoning harness (PR #259): crash recovery (the sweep), what a conclusive
 * failure costs, runs admitted at one privacy epoch or already closed, what the database itself
 * refuses, what the purge keeps, and the stored-output bound. Evidence label: CI fixture + real
 * database.
 */
describe('reasoning recovery, charging and run rules (real database, fixture model)', () => {
  // Unresolved liabilities and failure receipts intentionally survive within a case, not across unrelated cases.
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recovery');
  });
  afterEach(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const operator = () => reasoningOperatorFor(db(), silent);
  const withScope = () => makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 });
  const withCaps = (caps: Partial<HarnessSettings['caps']>): HarnessSettings => ({
    ...fixtureSettings,
    caps: { ...fixtureSettings.caps, ...caps },
  });
  const propose = <T = z.infer<typeof echoRole.outputSchema>>(
    harness: ReturnType<typeof fixtureHarness>['harness'],
    person: FixturePerson,
    options: { readonly runId?: string; readonly role?: ReasoningRole<T>; readonly epoch?: number } = {},
  ) =>
    harness.propose(
      {
        run: fixtureRun(systemAuthority(person.universeId, options.epoch ?? 1), options.runId ?? randomUUID()),
        role: (options.role ?? echoRole) as ReasoningRole<T>,
        context: fixtureContext,
      },
      signal(),
    );
  const erase = async (person: FixturePerson) => {
    const reports = await withScope()(person.authority, (scope) => eraseUniverse(scope, personalStores));
    return reports.kind === 'entered' ? reports.value.find((report) => report.module === 'reasoning') : undefined;
  };
  /** A harness whose process "dies" when it would record the outcome of a dispatched call. */
  const crashingAfterDispatch = (model: ReturnType<typeof fixtureModel>) => {
    const base = fixtureHarness(db(), { model });
    const crashing: AttemptLedger = {
      ...base.ports.ledger,
      settle: (attempt, from, to, details) =>
        from === 'dispatched'
          ? Promise.reject(new Error('simulated crash after dispatch'))
          : base.ports.ledger.settle(attempt, from, to, details),
    };
    return fixtureHarness(db(), { model, overrides: { ledger: crashing } }).harness;
  };
  const reservationOf = async () => {
    const probe = await seedPerson(db());
    await propose(fixtureHarness(db(), { model: fixtureModel() }).harness, probe);
    return (await attemptsOf(db(), probe.universeId))[0]?.reserved_tokens ?? 0;
  };

  describe('a crash after dispatch (review M1)', () => {
    it('is moved to unknown by the sweep with no redelivery: listed, written off, and the universe’s erasure completes', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel();
      await expect(propose(crashingAfterDispatch(model), person)).rejects.toThrow('simulated crash after dispatch');
      const [dispatched] = await attemptsOf(db(), person.universeId);
      const attemptId = dispatched?.id ?? '';
      expect(dispatched).toMatchObject({ state: 'dispatched', settled_at: null });
      expect(await receiptsOf(db(), [attemptId])).toEqual([expect.objectContaining({ state: 'held' })]);

      // Before the sweep nothing can see or resolve it, and erasure waits on it.
      expect((await operator().listUnknown(500)).map((attempt) => attempt.attemptId)).not.toContain(attemptId);
      expect(await operator().writeOff(attemptId, 'too early', 'cli:ci-fixture')).toEqual({
        kind: 'not_unknown',
        attemptId,
        state: 'dispatched',
      });
      expect(await erase(person)).toMatchObject({ status: 'pending' });

      // A recent dispatch is left alone (its handler may still be running)…
      await operator().sweepStaleDispatched(3_600);
      expect((await attemptsOf(db(), person.universeId))[0]?.state).toBe('dispatched');
      // …an old one becomes unknown: never resent, charged at its reservation, visible to the operator.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await operator().sweepStaleDispatched(0)).toBeGreaterThanOrEqual(1);
      expect((await attemptsOf(db(), person.universeId))[0]).toMatchObject({
        state: 'unknown',
        outcome_code: 'OUTCOME_NOT_RECORDED',
        settled_at: null,
      });
      expect(await receiptsOf(db(), [attemptId])).toEqual([expect.objectContaining({ state: 'unknown' })]);
      expect((await operator().listUnknown(500)).map((attempt) => attempt.attemptId)).toContain(attemptId);
      expect(model.calls).toHaveLength(1);

      // The operator resolves it, and erasure finishes.
      expect(
        await operator().writeOff(attemptId, 'CI fixture: crash, provider outcome unknown', 'cli:ci-fixture'),
      ).toEqual({
        kind: 'written_off',
        attemptId,
      });
      expect(await erase(person)).toMatchObject({ status: 'completed' });
      expect(await attemptsOf(db(), person.universeId)).toEqual([]);
    });

    it('leaves a live handler alone: its late answer still reconciles an attempt the sweep moved to unknown', async () => {
      const person = await seedPerson(db());
      const inFlight = gate();
      const release = gate<FixtureScenario>();
      const model = fixtureModel(() => {
        inFlight.open();
        return { kind: 'hold', until: release.promise };
      });
      const { harness } = fixtureHarness(db(), { model });
      const running = propose(harness, person);
      await inFlight.promise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await operator().sweepStaleDispatched(0)).toBeGreaterThanOrEqual(1);
      release.open({ kind: 'success', text: '{"ok": true, "echo": "lantern"}', remoteId: 'fixture-late' });
      expect(await running).toMatchObject({ kind: 'proposed', reconciled: true });
      expect((await attemptsOf(db(), person.universeId))[0]).toMatchObject({ state: 'reconciled' });
      expect(model.calls).toHaveLength(1);
    });
  });

  describe('a conclusive failure releases its reservation (review M2)', () => {
    const failures: [string, FixtureScenario, string][] = [
      ['a 429 before any work', { kind: 'rate_limited' }, 'HTTP_429_RATE_LIMIT_ERROR'],
      ['a 5xx before any work', { kind: 'server_error', status: 503 }, 'HTTP_503'],
      ['a refused connection (nothing was sent)', { kind: 'not_connected' }, 'NOT_CONNECTED_ECONNREFUSED'],
    ];

    it.each(failures)(
      '%s charges nothing and counts as no request; the run ends failed, a new run is the caller’s call',
      async (_label, failure, code) => {
        const reserved = await reservationOf();
        const person = await seedPerson(db());
        // One request and one reservation fit in the scope's day: only a released failure leaves room.
        const model = fixtureModel((sequence) =>
          sequence === 1 ? failure : { kind: 'success', text: '{"ok": true, "echo": "lantern"}' },
        );
        const { harness } = fixtureHarness(db(), {
          model,
          settings: withCaps({ scope: { requestsPerDay: 1, tokensPerDay: reserved + 50 } }),
        });
        const runId = randomUUID();
        const first = await propose(harness, person, { runId });
        expect(first).toEqual({ kind: 'failed', attemptId: expect.any(String) as unknown, code });
        const [attempt] = await attemptsOf(db(), person.universeId);
        expect(attempt).toMatchObject({ state: 'failed', outcome_code: code });
        expect(await receiptsOf(db(), [attempt?.id ?? ''])).toEqual([expect.objectContaining({ state: 'released' })]);

        // No hidden retry: the same run answers from the ledger and sends nothing.
        expect(await propose(harness, person, { runId })).toEqual(first);
        expect(model.calls).toHaveLength(1);
        // A new run is admitted: the failed attempt took no request and no tokens from the caps.
        expect((await propose(harness, person)).kind).toBe('proposed');
        expect(model.calls).toHaveLength(2);
      },
    );

    it('charges exactly the usage a failure reported', async () => {
      const reserved = await reservationOf();
      const person = await seedPerson(db());
      const model = fixtureModel((sequence) =>
        sequence === 1
          ? { kind: 'server_error', usage: { inputTokens: 30, outputTokens: 0, cachedTokens: 0 } }
          : { kind: 'success', text: '{"ok": true, "echo": "lantern"}' },
      );
      const { harness } = fixtureHarness(db(), {
        model,
        // 30 reported tokens do not fit beside a second reservation; a released failure would.
        settings: withCaps({ scope: { requestsPerDay: 100, tokensPerDay: reserved + 20 } }),
      });
      expect((await propose(harness, person)).kind).toBe('failed');
      expect(await receiptsOf(db(), [(await attemptsOf(db(), person.universeId))[0]?.id ?? ''])).toEqual([
        expect.objectContaining({ state: 'settled', input_tokens: 30, output_tokens: 0 }),
      ]);
      expect(await propose(harness, person)).toEqual({ kind: 'budget_exhausted', dimension: 'scope', limit: 'tokens' });
    });

    it('an abort between dispatch intent and send is a failure that sends nothing and charges nothing (review m7)', async () => {
      const reserved = await reservationOf();
      const person = await seedPerson(db());
      const abort = new AbortController();
      let messageRequests = 0;
      const fetchImpl = ((input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('token_plan')) {
          // The graceful stop arrives right after the quota preflight, before the request leaves.
          abort.abort();
          return Promise.resolve(
            new Response(
              JSON.stringify({
                base_resp: { status_code: 0 },
                model_remains: [
                  {
                    model_name: 'general',
                    current_interval_remaining_percent: 90,
                    current_weekly_remaining_percent: 90,
                  },
                ],
              }),
            ),
          );
        }
        messageRequests += 1;
        return Promise.resolve(new Response('{}', { status: 500 }));
      }) as typeof fetch;
      const model = makeMiniMaxModelPort(
        {
          apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
          model: 'MiniMax-M3',
          requestTimeoutMs: 5_000,
          quotaTimeoutMs: 5_000,
          quotaFloorPercent: 25,
          maxReplyBytes: 65_536,
          maxRequestBytes: 262_144,
        },
        fetchImpl,
      );
      const { harness } = fixtureHarness(db(), { model });
      const outcome = await harness.propose(
        { run: fixtureRun(systemAuthority(person.universeId)), role: echoRole, context: fixtureContext },
        abort.signal,
      );
      expect(outcome).toMatchObject({ kind: 'failed', code: 'ABORTED_BEFORE_DISPATCH' });
      expect(messageRequests).toBe(0);
      const [attempt] = await attemptsOf(db(), person.universeId);
      expect(attempt).toMatchObject({ state: 'failed', outcome_code: 'ABORTED_BEFORE_DISPATCH' });
      expect(await receiptsOf(db(), [attempt?.id ?? ''])).toEqual([expect.objectContaining({ state: 'released' })]);
      // The reservation is free again: the scope's single request is still available.
      const again = fixtureHarness(db(), {
        model: fixtureModel(),
        settings: withCaps({ scope: { requestsPerDay: 1, tokensPerDay: reserved + 50 } }),
      }).harness;
      expect((await propose(again, person)).kind).toBe('proposed');
    });
  });

  describe('runs (review m1, m2)', () => {
    const insufficient = {
      verdict: 'insufficient',
      intervalRemainingPercent: 1,
      weeklyRemainingPercent: 1,
      reasonCode: 'QUOTA_BELOW_FLOOR',
    } as const;
    const available = { verdict: 'available', intervalRemainingPercent: 90, weeklyRemainingPercent: 90 } as const;

    it('a run admitted at privacy epoch 1 is refused under epoch 2 and sends nothing (probe p5)', async () => {
      const person = await seedPerson(db());
      let quota: typeof insufficient | typeof available = insufficient;
      const model = fixtureModel(undefined, { quota: () => quota });
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      expect((await propose(harness, person, { runId })).kind).toBe('quota_unavailable');
      await advanceEpoch(db(), person.universeId, 2);
      quota = available;
      expect(await propose(harness, person, { runId, epoch: 2 })).toEqual({ kind: 'refused', reason: 'run_mismatch' });
      expect(model.calls).toHaveLength(0);
    });

    it('a reset during a call never hands the answer to the same run under the new epoch (probe p5b)', async () => {
      const person = await seedPerson(db());
      const inFlight = gate();
      const release = gate<FixtureScenario>();
      const model = fixtureModel(() => {
        inFlight.open();
        return { kind: 'hold', until: release.promise };
      });
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      const running = propose(harness, person, { runId });
      await inFlight.promise;
      // The privacy reset: the epoch moves and the universe is erased under the new authority.
      await advanceEpoch(db(), person.universeId, 2);
      await withScope()(systemAuthority(person.universeId, 2), (scope) => eraseUniverse(scope, personalStores));
      release.open({ kind: 'success', text: '{"ok": true, "echo": "epoch1-private"}' });
      expect(await running).toMatchObject({ kind: 'refused', reason: 'output_ineligible' });
      // Late accounting survives, but private payload must not return after the erase.
      expect((await attemptsOf(db(), person.universeId))[0]).toMatchObject({
        state: 'succeeded',
        output: null,
        output_issues: null,
        quota_observation: null,
      });
      expect((await receiptsOf(db(), [(await attemptsOf(db(), person.universeId))[0]!.id]))[0]).toMatchObject({
        state: 'settled',
      });
      // The same run under epoch 2 still cannot get the answer or send again.
      expect(await propose(harness, person, { runId, epoch: 2 })).toEqual({ kind: 'refused', reason: 'run_mismatch' });
      expect(model.calls).toHaveLength(1);
    });

    it('a closed run answers run_closed, even though its answer is still kept; closing is idempotent', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel();
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      expect((await propose(harness, person, { runId })).kind).toBe('proposed');
      const close = () =>
        withScope()(systemAuthority(person.universeId), (scope) =>
          harness.closeRun(scope, { runId, state: 'completed' }),
        );
      expect(await close()).toEqual({ kind: 'entered', value: 'closed' });
      expect(await propose(harness, person, { runId })).toEqual({ kind: 'refused', reason: 'run_closed' });
      expect(await close()).toEqual({ kind: 'entered', value: 'not_open' });
      expect(model.calls).toHaveLength(1);
    });
  });

  describe('the database refuses what the state machine forbids (review m3)', () => {
    it('refuses a written-off attempt without a reason or actor, a dispatched state without a dispatch identity, and bytes under another hash', async () => {
      const person = await seedPerson(db());
      const { harness } = fixtureHarness(db(), { model: fixtureModel(() => ({ kind: 'timeout_after_dispatch' })) });
      expect((await propose(harness, person)).kind).toBe('unknown');
      const attemptId = (await attemptsOf(db(), person.universeId))[0]?.id ?? '';
      await expect(
        sql`update reasoning.external_attempts set state = 'written_off' where id = ${attemptId}`.execute(db()),
      ).rejects.toThrow(/external_attempts_written_off_check/);
      await expect(
        sql`update reasoning.external_attempts set state = 'written_off', written_off_reason = 'r', written_off_at = now() where id = ${attemptId}`.execute(
          db(),
        ),
      ).rejects.toThrow(/external_attempts_written_off_check/);
      await expect(
        sql`update reasoning.external_attempts set dispatch_id = null where id = ${attemptId}`.execute(db()),
      ).rejects.toThrow(/external_attempts_dispatch_check/);
      await expect(
        sql`update reasoning.external_attempts set dispatched_at = null where id = ${attemptId}`.execute(db()),
      ).rejects.toThrow(/external_attempts_dispatch_check/);
      await expect(
        sql`update reasoning.protected_requests set body_sha256 = repeat('b', 64) where attempt_id = ${attemptId}`.execute(
          db(),
        ),
      ).rejects.toThrow(/protected_requests_body_hash_check/);
      await expect(
        sql`update reasoning.protected_requests set body = 'other bytes'::bytea where attempt_id = ${attemptId}`.execute(
          db(),
        ),
      ).rejects.toThrow(/protected_requests_body_hash_check/);
      // The legitimate write-off still works, and the stored bytes still hash to their recorded hash.
      expect(await operator().writeOff(attemptId, 'CI fixture: constraint check', 'cli:ci-fixture')).toEqual({
        kind: 'written_off',
        attemptId,
      });
      const [stored] = await protectedRequestsOf(db(), person.universeId);
      expect(
        createHash('sha256')
          .update(stored?.body ?? Buffer.alloc(0))
          .digest('hex'),
      ).toBe(stored?.body_sha256);
    });
  });

  describe('the purge keeps what is still needed (review m8)', () => {
    const expireBytes = (attemptId: string) =>
      sql`update reasoning.protected_requests
          set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          where attempt_id = ${attemptId}`.execute(db());

    it('never deletes the bytes of a dispatched attempt, settles an expired reserved attempt not_sent, and deletes finished attempts’ bytes', async () => {
      // a) dispatched: a crash left it.
      const crashed = await seedPerson(db());
      await expect(propose(crashingAfterDispatch(fixtureModel()), crashed)).rejects.toThrow('simulated crash');
      const dispatchedId = (await attemptsOf(db(), crashed.universeId))[0]?.id ?? '';
      // b) reserved: the process died before dispatch intent.
      const waiting = await seedPerson(db());
      const waitingRunId = randomUUID();
      const base = fixtureHarness(db(), { model: fixtureModel() });
      const dyingBeforeDispatch: AttemptLedger = {
        ...base.ports.ledger,
        commitDispatch: () => Promise.reject(new Error('simulated crash before dispatch intent')),
      };
      await expect(
        propose(
          fixtureHarness(db(), { model: fixtureModel(), overrides: { ledger: dyingBeforeDispatch } }).harness,
          waiting,
          {
            runId: waitingRunId,
          },
        ),
      ).rejects.toThrow('simulated crash before dispatch intent');
      const reservedId = (await attemptsOf(db(), waiting.universeId))[0]?.id ?? '';
      expect((await attemptsOf(db(), waiting.universeId))[0]?.state).toBe('reserved');
      // c) finished.
      const finished = await seedPerson(db());
      expect((await propose(fixtureHarness(db(), { model: fixtureModel() }).harness, finished)).kind).toBe('proposed');
      const finishedId = (await attemptsOf(db(), finished.universeId))[0]?.id ?? '';

      for (const id of [dispatchedId, reservedId, finishedId]) await expireBytes(id);
      expect(await operator().purgeExpired()).toBeGreaterThanOrEqual(2);

      const left = async (universeId: string) => (await protectedRequestsOf(db(), universeId)).length;
      expect(await left(crashed.universeId)).toBe(1);
      expect((await attemptsOf(db(), crashed.universeId))[0]?.state).toBe('dispatched');
      expect(await left(waiting.universeId)).toBe(0);
      expect((await attemptsOf(db(), waiting.universeId))[0]).toMatchObject({
        state: 'not_sent',
        outcome_code: 'REQUEST_EXPIRED',
      });
      expect(await receiptsOf(db(), [reservedId])).toEqual([expect.objectContaining({ state: 'released' })]);
      expect(await left(finished.universeId)).toBe(0);
      expect((await attemptsOf(db(), finished.universeId))[0]?.state).toBe('succeeded');

      // The waiting run is not stuck: a redelivery reserves a fresh attempt with fresh bytes and sends it.
      const model = fixtureModel();
      expect((await propose(fixtureHarness(db(), { model }).harness, waiting, { runId: waitingRunId })).kind).toBe(
        'proposed',
      );
      expect((await attemptsOf(db(), waiting.universeId)).map((row) => `${row.step}:${row.state}`)).toEqual([
        'primary:not_sent',
        'primary.2:succeeded',
      ]);
      expect(model.calls).toHaveLength(1);
    });
  });

  describe('the stored-output bound (review m6)', () => {
    const looseRole: ReasoningRole<{ ok: true; echo: string; note: string }> = {
      ...echoRole,
      id: 'fixture.loose',
      outputSchema: z.object({ ok: z.literal(true), echo: z.string(), note: z.string() }),
    };
    const answer = (length: number): FixtureScenario => ({
      kind: 'success',
      text: JSON.stringify({ ok: true, echo: 'lantern', note: 'x'.repeat(length) }),
    });

    it('keeps an answer just under the bound', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel(() => answer(60_000));
      expect((await propose(fixtureHarness(db(), { model }).harness, person, { role: looseRole })).kind).toBe(
        'proposed',
      );
    });

    it('records an answer too large to keep as OUTPUT_TOO_LARGE, repairs once, and never stores or applies it', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel(() => answer(70_000));
      expect(await propose(fixtureHarness(db(), { model }).harness, person, { role: looseRole })).toMatchObject({
        kind: 'invalid_output',
        reason: 'OUTPUT_TOO_LARGE',
      });
      expect(model.calls).toHaveLength(2);
      const rows = await attemptsOf(db(), person.universeId);
      expect(rows.map((row) => `${row.step}:${row.state}:${row.outcome_code}`)).toEqual([
        'primary:succeeded:OUTPUT_TOO_LARGE',
        'repair:succeeded:OUTPUT_TOO_LARGE',
      ]);
      expect(rows.every((row) => row.output === null)).toBe(true);
    });
  });
});
