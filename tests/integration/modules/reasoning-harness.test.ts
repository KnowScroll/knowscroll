import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { createEventLog } from '@knowscroll/backend/infrastructure/observability';
import {
  NestedTransactionError,
  insideTransaction,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import type { HarnessSettings, QuotaObservation, ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeMiniMaxModelPort,
  reasoningOperatorFor,
  type FixtureModelPort,
  type FixtureScenario,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  attemptsOf,
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  fixtureSettings,
  protectedRequestsOf,
  reasoningText,
  receiptsOf,
  signal,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

/**
 * The reasoning harness beyond single transitions: budgets and caps, the quota preflight, the
 * protected request store, the repair rule, the transaction guard, the diagnostics canary and run
 * closure. Evidence label: CI fixture + real database (the canary also drives the real MiniMax
 * adapter against a fake HTTP boundary).
 */
describe('the reasoning harness (real database, fixture model)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('harness');
  });
  afterAll(async () => {
    await database.drop();
  });

  const db = () => database.db;
  const withCaps = (caps: Partial<HarnessSettings['caps']>, extra: Partial<HarnessSettings> = {}): HarnessSettings => ({
    ...fixtureSettings,
    ...extra,
    caps: { ...fixtureSettings.caps, ...caps },
  });
  const propose = <T>(
    harness: ReturnType<typeof fixtureHarness>['harness'],
    person: FixturePerson,
    options: { readonly runId?: string; readonly role?: ReasoningRole<T>; readonly allowRepair?: boolean } = {},
  ) =>
    harness.propose(
      {
        run: fixtureRun(systemAuthority(person.universeId), options.runId ?? randomUUID()),
        role: (options.role ?? echoRole) as ReasoningRole<T>,
        context: fixtureContext,
        ...(options.allowRepair === undefined ? {} : { limits: { allowRepair: options.allowRepair } }),
      },
      signal(),
    );
  const steps = async (universeId: string) =>
    (await attemptsOf(db(), universeId)).map((row) => `${row.step}:${row.state}:${row.outcome_code ?? '-'}`);
  const available: QuotaObservation = { verdict: 'available', intervalRemainingPercent: 90, weeklyRemainingPercent: 80 };
  const insufficient: QuotaObservation = {
    verdict: 'insufficient',
    intervalRemainingPercent: 10,
    weeklyRemainingPercent: 90,
    reasonCode: 'QUOTA_BELOW_FLOOR',
  };

  describe('budgets and caps', () => {
    it('refuses a reservation beyond the per-scope request cap before anything is reserved or sent', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel();
      const { harness } = fixtureHarness(db(), {
        model,
        settings: withCaps({ scope: { requestsPerDay: 2, tokensPerDay: 100_000_000 } }),
      });
      expect((await propose(harness, person)).kind).toBe('proposed');
      expect((await propose(harness, person)).kind).toBe('proposed');
      expect(await propose(harness, person)).toEqual({ kind: 'budget_exhausted', dimension: 'scope', limit: 'requests' });
      expect(model.calls).toHaveLength(2);
      expect(await steps(person.universeId)).toHaveLength(2);
      // Another universe has its own scope budget.
      expect((await propose(harness, await seedPerson(db()))).kind).toBe('proposed');
    });

    it('enforces the global cap across universes and a role’s own cap across universes', async () => {
      const today = await sql<{ n: number }>`
        select count(*)::int as n from reasoning.usage_receipts
        where state <> 'released' and budget_window = (now() at time zone 'UTC')::date`.execute(db());
      const used = today.rows[0]?.n ?? 0;
      const globalModel = fixtureModel();
      const global = fixtureHarness(db(), {
        model: globalModel,
        settings: withCaps({ global: { requestsPerDay: used + 1, tokensPerDay: 100_000_000 } }),
      }).harness;
      expect((await propose(global, await seedPerson(db()))).kind).toBe('proposed');
      expect(await propose(global, await seedPerson(db()))).toEqual({
        kind: 'budget_exhausted',
        dimension: 'global',
        limit: 'requests',
      });
      expect(globalModel.calls).toHaveLength(1);

      const limited: ReasoningRole<z.infer<typeof echoRole.outputSchema>> = {
        ...echoRole,
        id: 'fixture.role-cap',
        budget: { requestsPerDay: 1, tokensPerDay: 100_000_000 },
      };
      const { harness } = fixtureHarness(db(), { model: fixtureModel() });
      expect((await propose(harness, await seedPerson(db()), { role: limited })).kind).toBe('proposed');
      expect(await propose(harness, await seedPerson(db()), { role: limited })).toEqual({
        kind: 'budget_exhausted',
        dimension: 'role',
        limit: 'requests',
      });
    });

    it('charges reported usage once known, keeps an unknown attempt charged at its reservation, and frees not_sent', async () => {
      // The same role and context give the same request bytes, so every attempt reserves the same R.
      const probe = await seedPerson(db());
      await propose(fixtureHarness(db(), { model: fixtureModel() }).harness, probe);
      const reserved = (await attemptsOf(db(), probe.universeId))[0]?.reserved_tokens ?? 0;
      expect(reserved).toBeGreaterThan(256);
      const settings = withCaps({ scope: { requestsPerDay: 100, tokensPerDay: reserved + 100 } });

      // Known usage (40 in + 12 out + 0 cached = 52) replaces the reservation after settlement.
      const known = await seedPerson(db());
      const knownHarness = fixtureHarness(db(), { model: fixtureModel(), settings }).harness;
      expect((await propose(knownHarness, known)).kind).toBe('proposed');
      expect((await propose(knownHarness, known)).kind).toBe('proposed');
      expect(await propose(knownHarness, known)).toEqual({ kind: 'budget_exhausted', dimension: 'scope', limit: 'tokens' });

      // An unknown outcome stays charged at its full reservation.
      const uncertain = await seedPerson(db());
      const uncertainHarness = fixtureHarness(db(), {
        model: fixtureModel(() => ({ kind: 'timeout_after_dispatch' })),
        settings,
      }).harness;
      expect((await propose(uncertainHarness, uncertain)).kind).toBe('unknown');
      expect(await propose(uncertainHarness, uncertain)).toEqual({
        kind: 'budget_exhausted',
        dimension: 'scope',
        limit: 'tokens',
      });

      // An attempt that was never sent charges nothing and does not count as a request.
      const released = await seedPerson(db());
      let quota = insufficient;
      const releasedHarness = fixtureHarness(db(), {
        model: fixtureModel(undefined, { quota: () => quota }),
        settings: withCaps({ scope: { requestsPerDay: 1, tokensPerDay: reserved + 100 } }),
      }).harness;
      expect((await propose(releasedHarness, released)).kind).toBe('quota_unavailable');
      quota = available;
      expect((await propose(releasedHarness, released)).kind).toBe('proposed');
    });
  });

  describe('the quota preflight', () => {
    it('records the observation on a not_sent attempt, releases it, and a later delivery reserves a new attempt', async () => {
      const person = await seedPerson(db());
      let quota = insufficient;
      const model = fixtureModel(undefined, { quota: () => quota });
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      const refused = await propose(harness, person, { runId });
      expect(refused).toEqual({ kind: 'quota_unavailable', attemptId: expect.any(String) as unknown });
      expect(model.calls).toHaveLength(0);
      const [first] = await attemptsOf(db(), person.universeId);
      expect(first).toMatchObject({
        step: 'primary',
        state: 'not_sent',
        outcome_code: 'QUOTA_UNAVAILABLE',
        quota_observation: {
          v: 1,
          verdict: 'insufficient',
          intervalRemainingPercent: 10,
          weeklyRemainingPercent: 90,
          reasonCode: 'QUOTA_BELOW_FLOOR',
        },
      });
      expect(await receiptsOf(db(), [first?.id ?? ''])).toEqual([expect.objectContaining({ state: 'released' })]);

      quota = available;
      expect((await propose(harness, person, { runId })).kind).toBe('proposed');
      expect(model.calls).toHaveLength(1);
      expect(await steps(person.universeId)).toEqual(['primary:not_sent:QUOTA_UNAVAILABLE', 'primary.2:succeeded:SUCCEEDED']);
      expect((await attemptsOf(db(), person.universeId))[1]?.quota_observation).toMatchObject({ verdict: 'available' });
    });

    it('stops reserving new attempts for a step after four that were never sent', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel(undefined, { quota: () => insufficient });
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      for (let delivery = 0; delivery < 5; delivery += 1)
        expect((await propose(harness, person, { runId })).kind).toBe('quota_unavailable');
      expect(await steps(person.universeId)).toEqual([
        'primary:not_sent:QUOTA_UNAVAILABLE',
        'primary.2:not_sent:QUOTA_UNAVAILABLE',
        'primary.3:not_sent:QUOTA_UNAVAILABLE',
        'primary.4:not_sent:QUOTA_UNAVAILABLE',
      ]);
      expect(model.quotaChecks()).toBe(4);
      expect(model.calls).toHaveLength(0);
    });
  });

  describe('the protected request store', () => {
    it('stores the exact request bytes and their hash before dispatch, and sends exactly those bytes once', async () => {
      const person = await seedPerson(db());
      const seenAtSend: unknown[] = [];
      const model: FixtureModelPort = fixtureModel(async () => {
        const [attempt] = await attemptsOf(db(), person.universeId);
        const rows = await protectedRequestsOf(db(), person.universeId);
        seenAtSend.push({
          state: attempt?.state,
          rows: rows.length,
          hashMatches: createHash('sha256').update(rows[0]?.body ?? '').digest('hex') === attempt?.request_hash,
          insideTransaction: insideTransaction(),
        });
        return { kind: 'success', text: '{"ok": true, "echo": "lantern"}' };
      });
      expect((await propose(fixtureHarness(db(), { model }).harness, person)).kind).toBe('proposed');
      expect(seenAtSend).toEqual([{ state: 'dispatched', rows: 1, hashMatches: true, insideTransaction: false }]);
      const [stored] = await protectedRequestsOf(db(), person.universeId);
      expect(new Uint8Array(stored?.body ?? new Uint8Array())).toEqual(model.calls[0]?.bytes);
      expect(stored?.erasure_class).toBe('personal_context');
    });

    it('refuses a request larger than the store’s limit before anything is written', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel();
      const { harness } = fixtureHarness(db(), { model, settings: withCaps({}, { maxRequestBytes: 200 }) });
      expect(await propose(harness, person)).toEqual({ kind: 'refused', reason: 'request_too_large' });
      expect(model.calls).toHaveLength(0);
      expect(await steps(person.universeId)).toEqual([]);
    });

    it('purges expired bytes (operator command and periodically), keeping the attempt and its hash', async () => {
      const person = await seedPerson(db());
      const { harness } = fixtureHarness(db(), { model: fixtureModel(), settings: withCaps({}, { purgeIntervalMs: 0 }) });
      expect((await propose(harness, person)).kind).toBe('proposed');
      const expire = () =>
        sql`update reasoning.protected_requests
            set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
            where universe_id = ${person.universeId}`.execute(db());
      await expire();
      expect(await reasoningOperatorFor(db(), () => undefined).purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await protectedRequestsOf(db(), person.universeId)).toEqual([]);
      expect(await steps(person.universeId)).toEqual(['primary:succeeded:SUCCEEDED']);

      // The next propose purges opportunistically (interval 0 here).
      const other = await seedPerson(db());
      expect((await propose(harness, other)).kind).toBe('proposed');
      await sql`update reasoning.protected_requests
                set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
                where universe_id = ${other.universeId}`.execute(db());
      expect((await propose(harness, person)).kind).toBe('proposed');
      expect(await protectedRequestsOf(db(), other.universeId)).toEqual([]);
    });

    it('is erased with the universe even for an open attempt, which stays as liability with its receipt', async () => {
      const person = await seedPerson(db());
      await propose(fixtureHarness(db(), { model: fixtureModel() }).harness, person);
      await propose(fixtureHarness(db(), { model: fixtureModel(() => ({ kind: 'timeout_after_dispatch' })) }).harness, person);
      const before = await attemptsOf(db(), person.universeId);
      expect(before.map((row) => row.state)).toEqual(['succeeded', 'unknown']);
      expect(await protectedRequestsOf(db(), person.universeId)).toHaveLength(2);
      const reports = await makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        eraseUniverse(scope, personalStores),
      );
      expect(reports.kind === 'entered' ? reports.value.find((report) => report.module === 'reasoning') : undefined).toMatchObject({
        status: 'pending',
      });
      expect(await protectedRequestsOf(db(), person.universeId)).toEqual([]);
      expect((await attemptsOf(db(), person.universeId)).map((row) => row.state)).toEqual(['unknown']);
      expect(await receiptsOf(db(), before.map((row) => row.id))).toHaveLength(2);
    });
  });

  describe('the repair rule', () => {
    const repairing = (...scenarios: FixtureScenario[]) => fixtureModel((sequence) => scenarios[sequence - 1] ?? { kind: 'malformed' });

    it('repairs an invalid answer once: a new attempt with its own reservation and causation, sending the validator’s findings', async () => {
      const person = await seedPerson(db());
      const model = repairing({ kind: 'malformed' }, { kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
      const outcome = await propose(fixtureHarness(db(), { model }).harness, person);
      expect(outcome).toMatchObject({ kind: 'proposed', output: { ok: true, echo: 'lantern' }, repaired: true });
      expect(model.calls).toHaveLength(2);
      const [primary, repair] = await attemptsOf(db(), person.universeId);
      expect(primary).toMatchObject({
        step: 'primary',
        state: 'succeeded',
        outcome_code: 'OUTPUT_NOT_ONE_JSON_OBJECT',
        output: null,
        output_issues: { v: 1, reason: 'OUTPUT_NOT_ONE_JSON_OBJECT', issues: [expect.objectContaining({ code: 'not_one_json_object' })] },
      });
      expect(repair).toMatchObject({ step: 'repair', state: 'succeeded', outcome_code: 'SUCCEEDED', causation_attempt_id: primary?.id });
      expect(await receiptsOf(db(), [primary?.id ?? '', repair?.id ?? ''])).toHaveLength(2);
      expect(model.calls[0]?.request.system).not.toContain('Validation:');
      expect(model.calls[1]?.request.system).toContain('- (root): not_one_json_object');
      // The rejected answer itself is never sent back.
      expect(model.calls[1]?.request.user).not.toContain('Here is what you asked for');
    });

    it('allows at most one repair, and a redelivery answers from the ledger', async () => {
      const person = await seedPerson(db());
      const model = repairing({ kind: 'success', text: '{"ok": true}' }, { kind: 'success', text: '{"ok": true}' });
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      const outcome = await propose(harness, person, { runId });
      expect(outcome).toEqual({ kind: 'invalid_output', attemptId: expect.any(String) as unknown, reason: 'OUTPUT_SCHEMA_MISMATCH' });
      expect(await propose(harness, person, { runId })).toEqual(outcome);
      expect(model.calls).toHaveLength(2);
      expect(model.calls[1]?.request.system).toContain('- echo: missing (required; expected string)');
      expect(await steps(person.universeId)).toEqual([
        'primary:succeeded:OUTPUT_SCHEMA_MISMATCH',
        'repair:succeeded:OUTPUT_SCHEMA_MISMATCH',
      ]);
    });

    it('treats a cut-off answer as invalid even when it parses, and repairs it', async () => {
      const person = await seedPerson(db());
      const model = repairing(
        { kind: 'success', text: '{"ok": true, "echo": "lantern"}', stop: 'max_tokens' },
        { kind: 'success', text: '{"ok": true, "echo": "lantern"}' },
      );
      expect(await propose(fixtureHarness(db(), { model }).harness, person)).toMatchObject({ kind: 'proposed', repaired: true });
      expect(await steps(person.universeId)).toEqual(['primary:succeeded:OUTPUT_TRUNCATED', 'repair:succeeded:SUCCEEDED']);
    });

    it('never repairs when the role disallows it, nor after an unknown or failed attempt', async () => {
      const cases: [FixtureScenario, string, boolean][] = [
        [{ kind: 'malformed' }, 'invalid_output', false],
        [{ kind: 'timeout_after_dispatch' }, 'unknown', true],
        [{ kind: 'rate_limited' }, 'failed', true],
      ];
      for (const [scenario, kind, allowRepair] of cases) {
        const person = await seedPerson(db());
        const model = repairing(scenario, { kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
        expect((await propose(fixtureHarness(db(), { model }).harness, person, { allowRepair })).kind).toBe(kind);
        expect(model.calls).toHaveLength(1);
        expect((await steps(person.universeId)).map((step) => step.split(':')[0])).toEqual(['primary']);
      }
    });

    it('resumes a repair reserved by a delivery that died, with the same bytes, without a second repair', async () => {
      const person = await seedPerson(db());
      const model = repairing({ kind: 'malformed' }, { kind: 'success', text: '{"ok": true, "echo": "lantern"}' });
      let checks = 0;
      const dying: FixtureModelPort = {
        ...model,
        observeQuota: (abort) => {
          checks += 1;
          // The repair's first preflight: the process dies after the repair was reserved.
          return checks === 2 ? Promise.reject(new Error('fixture: died before dispatching the repair')) : model.observeQuota(abort);
        },
      };
      const { harness } = fixtureHarness(db(), { model: dying });
      const runId = randomUUID();
      await expect(propose(harness, person, { runId })).rejects.toThrow('died before dispatching the repair');
      expect(await steps(person.universeId)).toEqual(['primary:succeeded:OUTPUT_NOT_ONE_JSON_OBJECT', 'repair:reserved:-']);
      expect(await propose(harness, person, { runId })).toMatchObject({ kind: 'proposed', repaired: true });
      expect(await steps(person.universeId)).toEqual(['primary:succeeded:OUTPUT_NOT_ONE_JSON_OBJECT', 'repair:succeeded:SUCCEEDED']);
      expect(model.calls).toHaveLength(2);
    });
  });

  describe('the transaction guard', () => {
    it('refuses to run inside a database transaction: nothing reserved, nothing sent', async () => {
      const person = await seedPerson(db());
      const model = fixtureModel();
      const { harness } = fixtureHarness(db(), { model });
      await expect(
        makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(person.authority, () => propose(harness, person)),
      ).rejects.toBeInstanceOf(NestedTransactionError);
      expect(model.calls).toHaveLength(0);
      expect(await steps(person.universeId)).toEqual([]);
    });
  });

  describe('admission refusals', () => {
    it('refuses without a provider, and refuses invalid roles, runs and contexts before writing anything', async () => {
      const person = await seedPerson(db());
      const none = fixtureHarness(db(), { model: undefined }).harness;
      expect(await propose(none, person)).toEqual({ kind: 'refused', reason: 'provider_unavailable' });
      const { harness } = fixtureHarness(db(), { model: fixtureModel() });
      expect(await propose(harness, person, { role: { ...echoRole, maxOutputTokens: 0 } })).toEqual({
        kind: 'refused',
        reason: 'role_invalid',
      });
      expect(
        await harness.propose(
          { run: { ...fixtureRun(person.authority), id: 'not-a-uuid' }, role: echoRole, context: fixtureContext },
          signal(),
        ),
      ).toEqual({ kind: 'refused', reason: 'run_invalid' });
      expect(
        await harness.propose(
          {
            run: fixtureRun(person.authority),
            role: echoRole,
            context: { bundleRef: 'fixture.bundle:1', items: [{ ref: 'x', kind: 'Not A Kind', text: 'x' }] },
          },
          signal(),
        ),
      ).toEqual({ kind: 'refused', reason: 'context_invalid' });
      expect(await propose(harness, person, { role: { ...echoRole, minContextItems: 2 } })).toEqual({
        kind: 'refused',
        reason: 'context_insufficient',
      });
      expect(await steps(person.universeId)).toEqual([]);
    });
  });

  describe('runs', () => {
    it('closes a run with its fence; a closed run starts no attempt; a changed descriptor is refused', async () => {
      const person = await seedPerson(db());
      let quota = insufficient;
      const model = fixtureModel(undefined, { quota: () => quota });
      const { harness } = fixtureHarness(db(), { model });
      const runId = randomUUID();
      expect((await propose(harness, person, { runId })).kind).toBe('quota_unavailable');
      // The same run with another policy version is not the same run.
      expect(
        await harness.propose(
          { run: { ...fixtureRun(systemAuthority(person.universeId), runId), policyVersion: 'fixture.v2' }, role: echoRole, context: fixtureContext },
          signal(),
        ),
      ).toEqual({ kind: 'refused', reason: 'run_mismatch' });
      const close = () =>
        makeWithPersonalScope(db(), { lockTimeoutMs: 5_000 })(systemAuthority(person.universeId), (scope) =>
          harness.closeRun(scope, { runId, state: 'cancelled' }),
        );
      expect(await close()).toEqual({ kind: 'entered', value: 'closed' });
      expect(await close()).toEqual({ kind: 'entered', value: 'not_open' });
      const run = await db()
        .selectFrom('reasoning.business_runs')
        .select(['state', 'fence', 'role_id', 'role_version', 'policy_version', 'context_refs'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run).toEqual({
        state: 'cancelled',
        fence: 2,
        role_id: 'fixture.echo',
        role_version: 'v1',
        policy_version: 'fixture.v1',
        context_refs: ['fixture:item-1'],
      });
      quota = available;
      expect(await propose(harness, person, { runId })).toEqual({ kind: 'refused', reason: 'run_closed' });
      expect(model.calls).toHaveLength(0);
    });
  });

  describe('the diagnostics canary', () => {
    it('keeps prompts, provider error bodies, provider URLs and keys out of logs and the ledger', async () => {
      // Fixtures only: a fake key, a fake presigned URL, fake prompt text, a fake error body.
      const canary = {
        key: 'sk-cp-CANARYcanaryCANARYcanary000000',
        signature: 'canary-presigned-signature-Qw3',
        prompt: 'CANARY PROMPT about my private life',
        errorBody: 'CANARY ERROR BODY from the provider',
      } as const;
      let logs = '';
      const logEvent = createEventLog({
        service: 'canary',
        environment: 'ci',
        revision: 'unknown',
        minimumSeverity: 'debug',
        destination: new Writable({
          write(chunk: Buffer, _encoding, callback) {
            logs += chunk.toString('utf8');
            callback();
          },
        }),
      });
      const presigned = `https://oss.example/subtitles.json?Expires=1700000000&Signature=${canary.signature}`;
      let messages = 0;
      const fakeFetch = ((input: string | URL | Request) => {
        if (String(input).includes('token_plan'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                base_resp: { status_code: 0 },
                model_remains: [
                  { model_name: 'general', current_interval_remaining_percent: 90, current_weekly_remaining_percent: 90 },
                ],
              }),
            ),
          );
        messages += 1;
        if (messages === 1)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'api_error', message: `${canary.errorBody} key=${canary.key} see ${presigned}` },
              }),
              { status: 500 },
            ),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_canary',
              type: 'message',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ ok: true, echo: 'lantern', link: presigned, note: `token ${canary.key}` }),
                },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 30, output_tokens: 20 },
            }),
          ),
        );
      }) as typeof fetch;
      const model = makeMiniMaxModelPort(
        {
          apiKey: canary.key,
          model: 'MiniMax-M3',
          requestTimeoutMs: 5_000,
          quotaTimeoutMs: 5_000,
          quotaFloorPercent: 25,
          maxReplyBytes: 65_536,
          maxRequestBytes: 262_144,
        },
        fakeFetch,
      );
      const linkRole = {
        id: 'fixture.link',
        version: 'v1',
        instructions: 'Return {"ok": true, "echo": "<word>", "link": "<url>", "note": "<text>"}.',
        outputSchema: z.object({ ok: z.literal(true), echo: z.string(), link: z.string(), note: z.string() }).strict(),
        maxOutputTokens: 256,
      };
      const person = await seedPerson(db());
      const { harness } = fixtureHarness(db(), { model, logEvent });
      const context = {
        bundleRef: 'fixture.bundle:canary',
        items: [{ ref: 'fixture:canary', kind: 'retrieved', text: canary.prompt }],
      };
      const failed = await harness.propose({ run: fixtureRun(person.authority), role: linkRole, context }, signal());
      expect(failed).toEqual({ kind: 'failed', attemptId: expect.any(String) as unknown, code: 'HTTP_500_API_ERROR' });
      const proposed = await harness.propose({ run: fixtureRun(person.authority), role: linkRole, context }, signal());
      expect(proposed).toMatchObject({
        kind: 'proposed',
        output: { ok: true, echo: 'lantern', link: 'https://oss.example/subtitles.json', note: 'token [redacted-key]' },
      });

      const ledger = await reasoningText(db());
      expect(logs.length).toBeGreaterThan(0);
      for (const [name, value] of Object.entries(canary)) {
        expect({ name, inLogs: logs.includes(value) }).toEqual({ name, inLogs: false });
        expect({ name, inLedger: ledger.includes(value) }).toEqual({ name, inLedger: false });
      }
      // The prompt is held only in the protected request store, which is never logged.
      const stored = await protectedRequestsOf(db(), person.universeId);
      expect(stored.some((row) => Buffer.from(row.body).toString('utf8').includes(canary.prompt))).toBe(true);
      expect(stored.some((row) => Buffer.from(row.body).toString('utf8').includes(canary.key))).toBe(false);
    });
  });
});
