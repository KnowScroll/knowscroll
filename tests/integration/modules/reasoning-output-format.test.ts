import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeMiniMaxModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  type ModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureSettings,
  signal,
  systemAuthority,
} from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';

/** Real PostgreSQL + fake HTTP fixtures. No real provider or tool execution; suites run in Actions. */
describe.each(['personal', 'production'] as const)('output format through the %s harness', (scope) => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>(`output-format-${scope}`);
    await database.db
      .updateTable('reasoning.production_scopes')
      .set({ enabled: true })
      .where('id', '=', 'scroll-supply')
      .execute();
  });
  afterAll(async () => {
    await database.drop();
  });

  const setup = async (
    answers: readonly ('invalid' | 'valid' | 'credential' | 'unknown')[],
    supported: boolean | 'missing' = true,
    maxRequestBytes = fixtureSettings.maxRequestBytes,
  ) => {
    const calls: Uint8Array[] = [];
    const logs: unknown[] = [];
    let quotaChecks = 0;
    const port = makeMiniMaxModelPort(
      {
        apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
        model: supported === false ? 'MiniMax-M2.7' : 'MiniMax-M3',
        requestTimeoutMs: 200,
        quotaTimeoutMs: 200,
        quotaFloorPercent: 25,
        maxReplyBytes: 524_288,
        maxRequestBytes: 262_144,
      },
      (_url, init) => {
        calls.push(new Uint8Array(init?.body as Uint8Array));
        const answer = answers[calls.length - 1];
        if (answer === 'unknown') throw new TypeError('fixture disconnected', { cause: { code: 'ECONNRESET' } });
        if (answer === undefined) throw new Error('unexpected extra fixture transport call');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_format_fixture',
              type: 'message',
              stop_reason: 'tool_use',
              content: [
                { type: 'thinking', thinking: 'PRIVATE-THINKING-CANARY' },
                {
                  type: 'tool_use',
                  name: 'submit_output',
                  input:
                    answer === 'valid'
                      ? { ok: true, echo: 'lantern' }
                      : answer === 'credential'
                        ? { ok: true, echo: 'https://x.test/a?Signature=PRIVATE-CREDENTIAL' }
                        : { ok: false, echo: 'PRIVATE-REJECTED-INPUT' },
                },
              ],
              usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0 },
            }),
          ),
        );
      },
    );
    const model: ModelPort = {
      ...port,
      supportsSingleToolObject: supported === 'missing' ? undefined : port.supportsSingleToolObject,
      observeQuota: () => {
        quotaChecks += 1;
        return Promise.resolve({
          verdict: 'not_applicable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        });
      },
    };
    const person = await seedPerson(database.db);
    const id = randomUUID();
    const runFields = { id, ownerModule: 'fixture', purpose: 'output-format', policyVersion: 'fixture.v1' };
    const role: ReasoningRole<unknown> = {
      ...echoRole,
      id: `fixture.format-${scope}`,
      version: 'tool.v1',
      outputFormat: 'single-tool-object',
    };
    const logEvent: LogEvent = (event, fields) => {
      logs.push({ event, fields });
    };
    const settings = { ...fixtureSettings, maxRequestBytes };
    const personal = fixtureHarness(database.db, { model, logEvent, settings }).harness;
    const production = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        enabled: true,
        withProductionScope: makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5_000 }),
        model,
        logEvent,
        settings,
      }),
    );
    const propose = (selected = role) =>
      scope === 'personal'
        ? personal.propose(
            {
              run: { ...runFields, authority: systemAuthority(person.universeId) },
              role: selected,
              context: fixtureContext,
            },
            signal(),
          )
        : production.proposeProduction(
            {
              run: { ...runFields, authority: { scopeId: 'scroll-supply', generation: 1 } },
              role: selected,
              context: fixtureContext,
            },
            signal(),
          );
    const rows = () =>
      scope === 'personal'
        ? database.db
            .selectFrom('reasoning.external_attempts')
            .selectAll()
            .where('run_id', '=', id)
            .orderBy('reserved_at')
            .orderBy('id')
            .execute()
        : database.db
            .selectFrom('reasoning.production_attempts')
            .selectAll()
            .where('run_id', '=', id)
            .orderBy('reserved_at')
            .orderBy('id')
            .execute();
    const requests = () =>
      scope === 'personal'
        ? database.db
            .selectFrom('reasoning.protected_requests')
            .select(['attempt_id', 'body', 'body_sha256'])
            .where('universe_id', '=', person.universeId)
            .execute()
        : database.db
            .selectFrom('reasoning.production_requests')
            .innerJoin(
              'reasoning.production_attempts',
              'reasoning.production_attempts.id',
              'reasoning.production_requests.attempt_id',
            )
            .select([
              'reasoning.production_requests.attempt_id',
              'reasoning.production_requests.body',
              'reasoning.production_requests.body_sha256',
            ])
            .where('reasoning.production_attempts.run_id', '=', id)
            .execute();
    const runs = () =>
      scope === 'personal'
        ? database.db.selectFrom('reasoning.business_runs').select('id').where('id', '=', id).execute()
        : database.db.selectFrom('reasoning.production_runs').select('id').where('id', '=', id).execute();
    return { calls, logs, role, propose, rows, requests, runs, quotaChecks: () => quotaChecks };
  };

  it('propagates mode to primary and one repair, stores exact bytes and replays without another invocation', async () => {
    const h = await setup(['invalid', 'valid']);
    expect(await h.propose()).toMatchObject({
      kind: 'proposed',
      output: { ok: true, echo: 'lantern' },
      repaired: true,
    });
    expect(h.calls).toHaveLength(2);
    const rows = await h.rows();
    expect(rows.map((row) => [row.step, row.state, row.outcome_code, row.prompt_version])).toEqual([
      ['primary', 'succeeded', 'OUTPUT_SCHEMA_MISMATCH', 'hp3-tool-object'],
      ['repair', 'succeeded', 'SUCCEEDED', 'hp3-tool-object'],
    ]);
    expect(rows[1]?.causation_attempt_id).toBe(rows[0]?.id);
    const stored = await h.requests();
    for (const [index, bytes] of h.calls.entries()) {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as {
        tools: unknown[];
        tool_choice: unknown;
        system: string;
      };
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.system).toContain('including for a repair');
      if (index === 1) expect(body.system).toContain('Validation: your previous answer');
      expect(new Uint8Array(stored.find((item) => item.attempt_id === rows[index]?.id)?.body ?? [])).toEqual(bytes);
    }
    expect(JSON.stringify({ rows, logs: h.logs })).not.toContain('PRIVATE');
    expect(rows[0]?.output).toBeNull();
    expect(rows[0]?.input_tokens).toBe(20);
    expect(await h.propose()).toMatchObject({ kind: 'proposed', repaired: true });
    expect(h.calls).toHaveLength(2);
    // A changed mode on the same stable run cannot relabel or resend the historical attempt.
    const textRole = { ...h.role, outputFormat: undefined };
    expect(await h.propose(textRole)).toEqual({ kind: 'refused', reason: 'request_mismatch' });
    expect(h.calls).toHaveLength(2);
  });

  it('accounts a conclusive invalid repair and replays it without a third call', async () => {
    const h = await setup(['invalid', 'invalid']);
    expect(await h.propose()).toMatchObject({ kind: 'invalid_output', reason: 'OUTPUT_SCHEMA_MISMATCH' });
    expect(await h.propose()).toMatchObject({ kind: 'invalid_output', reason: 'OUTPUT_SCHEMA_MISMATCH' });
    expect(h.calls).toHaveLength(2);
    expect((await h.rows()).every((row) => row.output === null && row.input_tokens === 20)).toBe(true);
  });

  it('redacts native provider input before schema validation, recording or return', async () => {
    const h = await setup(['credential']);
    expect(await h.propose()).toMatchObject({ kind: 'proposed', output: { ok: true, echo: 'https://x.test/a' } });
    expect(JSON.stringify({ rows: await h.rows(), logs: h.logs })).not.toContain('PRIVATE');
    expect(h.calls).toHaveLength(1);
  });

  it('keeps an uncertain outcome unknown with one invocation and no repair or resend', async () => {
    const h = await setup(['unknown']);
    expect(await h.propose()).toMatchObject({ kind: 'unknown' });
    expect(await h.propose()).toMatchObject({ kind: 'unknown' });
    expect(h.calls).toHaveLength(1);
    expect((await h.rows()).map((row) => [row.step, row.state])).toEqual([['primary', 'unknown']]);
  });

  it('keeps the request byte ceiling before reservation for the opt-in format', async () => {
    const h = await setup([], true, 64);
    expect(await h.propose()).toEqual({ kind: 'refused', reason: 'request_too_large' });
    expect(await h.rows()).toEqual([]);
    expect(await h.runs()).toEqual([]);
    expect(h.quotaChecks()).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it.each([false, 'missing'] as const)(
    'refuses unsupported transport capability %s before reservation or quota',
    async (supported) => {
      const h = await setup([], supported);
      expect(await h.propose()).toEqual({ kind: 'refused', reason: 'output_format_unsupported' });
      expect(h.calls).toHaveLength(0);
      expect(await h.rows()).toEqual([]);
      expect(await h.requests()).toEqual([]);
      expect(await h.runs()).toEqual([]);
      expect(h.quotaChecks()).toBe(0);
    },
  );
});
