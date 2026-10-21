import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import {
  makeWithPersonalScope,
  makeWithProductionScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import type { ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeMiniMaxModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { reservedTokensFor } from '../../../packages/backend/src/reasoning/domain/budgets.js';
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
import { DraftBlock, ScrollDraft } from '@knowscroll/scroll-model/producer';
import { writerDraftProfile } from '../../../packages/backend/src/modules/content/production/writer-profile.js';
import { writerDraftExampleJson } from '../../../packages/backend/src/modules/content/production/writer-example.js';
import {
  deriveNativeInputSchema,
  isNativeInputSchema,
} from '../../../packages/backend/src/reasoning/domain/native-schema.js';
import { buildPrompt } from '../../../packages/backend/src/reasoning/domain/prompt.js';
import { JSON_STRING_TOOL } from '../../../packages/backend/src/reasoning/adapters/minimax/output-format.js';
// Real PostgreSQL + actual adapter + fake HTTP. No provider/live operation or Content role activation.
const settings = {
  apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
  model: 'MiniMax-M3' as const,
  requestTimeoutMs: 200,
  quotaTimeoutMs: 200,
  quotaFloorPercent: 25,
  maxReplyBytes: 524288,
  maxRequestBytes: 100000,
};
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
it.each([false, true])(
  'carries the unchanged actual canonical writer profile as deterministic inner grammar, interactive=%s',
  (interactive) => {
    const profile = writerDraftProfile(interactive),
      schema = deriveNativeInputSchema(profile);
    expect(isNativeInputSchema(schema)).toBe(true);
    expect(schema?.['required']).toEqual(['draftVersion', 'title', 'dek', 'sections', 'bindings']);
    expect(profile.shape.sections.element.shape.blocks.element.options.map((o) => o.shape.type.value)).toEqual([
      'paragraph',
      interactive ? 'diagram' : 'comparison',
      'callout',
    ]);
    expect(profile.shape.bindings.element.options.map((o) => o.shape.kind.value)).toEqual([
      'passage',
      'header',
      'heading',
      'block',
    ]);
    expect(DraftBlock.options).toHaveLength(16);
    const example = JSON.parse(writerDraftExampleJson(interactive)) as unknown;
    expect(profile.safeParse(example).success).toBe(true);
    expect(ScrollDraft.safeParse(example).success).toBe(true);
    const requests = [undefined, [{ path: 'sections', code: 'invalid_type', detail: 'expected array' }]].map(
      (feedback) => {
        const prompt = buildPrompt({
          roleId: 'fixture.writer',
          roleVersion: 'json-carrier.v1',
          instructions: 'Authored syntax fixture only. Use the complete inner object grammar.',
          bundleRef: 'fixture:grammar',
          items: [],
          outputFormat: 'single-tool-json-string.v1',
          nativeOutputSchema: 'zod-structural-json-string.v1',
          innerJsonSchema: schema,
          ...(feedback ? { feedback } : {}),
        });
        expect(prompt.system).toContain(JSON.stringify(schema));
        expect(prompt).toEqual(
          buildPrompt({
            roleId: 'fixture.writer',
            roleVersion: 'json-carrier.v1',
            instructions: 'Authored syntax fixture only. Use the complete inner object grammar.',
            bundleRef: 'fixture:grammar',
            items: [],
            outputFormat: 'single-tool-json-string.v1',
            nativeOutputSchema: 'zod-structural-json-string.v1',
            innerJsonSchema: deriveNativeInputSchema(profile),
            ...(feedback ? { feedback } : {}),
          }),
        );
        const body = makeMiniMaxModelPort(settings).encode({
          ...prompt,
          maxOutputTokens: 12000,
          outputFormat: 'single-tool-json-string.v1',
        });
        expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({ tools: [JSON_STRING_TOOL] });
        expect(body.length).toBeLessThanOrEqual(100000);
        return body;
      },
    );
    expect(digest(requests[0]!)).not.toBe(digest(requests[1]!));
    process.stdout.write(
      JSON.stringify({
        event: 'json-carrier-fixture-metadata',
        interactive,
        grammarBytes: Buffer.byteLength(JSON.stringify(schema)),
        exampleBytes: Buffer.byteLength(writerDraftExampleJson(interactive)),
        primaryBytes: requests[0]!.length,
        repairBytes: requests[1]!.length,
        requestCap: 100000,
      }) + '\n',
    );
  },
);

describe.each(['personal', 'production'] as const)('versioned JSON-string carrier through the %s harness', (scope) => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>(`json-carrier-${scope}`);
    await database.db
      .updateTable('reasoning.production_scopes')
      .set({ enabled: true })
      .where('id', '=', 'scroll-supply')
      .execute();
  });
  afterEach(async () => {
    await database.drop();
  });

  async function setup(
    answers: readonly unknown[],
    options: {
      supported?: boolean;
      formatSupported?: boolean;
      maxRequestBytes?: number;
      quota?: number;
      stopReason?: string;
    } = {},
  ) {
    const calls: Uint8Array[] = [];
    const logs: unknown[] = [];
    let quotas = 0;
    const port = makeMiniMaxModelPort(settings, (url, init) => {
      const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (address.endsWith('/remains')) {
        quotas++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              base_resp: { status_code: 0 },
              model_remains: [
                {
                  model_name: 'general',
                  current_interval_remaining_percent: options.quota ?? 80,
                  current_weekly_remaining_percent: 80,
                },
              ],
            }),
          ),
        );
      }
      const input = answers[calls.length];
      if (input === undefined) throw new Error('Unexpected additional fixture invocation');
      calls.push(new Uint8Array(init?.body as Uint8Array));
      if (input === 'CI-UNKNOWN-TRANSPORT') return Promise.reject(new Error('CI connection interrupted'));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'message',
            id: 'msg_native_schema_fixture',
            stop_reason: options.stopReason ?? 'tool_use',
            content: [
              { type: 'thinking', thinking: 'PRIVATE-THINKING' },
              {
                type: 'tool_use',
                name: 'submit_json_output_v1',
                input: { json: typeof input === 'string' ? input : JSON.stringify(input) },
              },
            ],
            usage: { input_tokens: 25, output_tokens: 10 },
          }),
        ),
      );
    });
    const model = {
      ...port,
      supportsSingleToolJsonString: options.formatSupported ?? true,
      supportsNativeOutputSchema: options.supported ?? true,
    };
    const logEvent = (event: string, fields: unknown) => {
      logs.push({ event, fields });
    };
    const harnessSettings = { ...fixtureSettings, maxRequestBytes: options.maxRequestBytes ?? 100000 };
    const personal = fixtureHarness(database.db, { model, logEvent, settings: harnessSettings });
    const productionPorts = postgresProductionHarnessPorts({
      db: database.db,
      enabled: true,
      withProductionScope: makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 }),
      model,
      logEvent,
      settings: harnessSettings,
    });
    const production = makeProductionReasoningHarness(productionPorts);
    const ledger = scope === 'personal' ? personal.ports.ledger : productionPorts.ledger;
    const purge = vi.spyOn(ledger, 'purgeExpiredRequests');
    const person = await seedPerson(database.db);
    const id = randomUUID();
    const role: ReasoningRole<unknown> = {
      ...echoRole,
      version: 'json-carrier-fixture.v1',
      outputFormat: 'single-tool-json-string.v1',
      nativeOutputSchema: 'zod-structural-json-string.v1',
    };
    const fields = { id, ownerModule: 'fixture', purpose: 'json-carrier', policyVersion: 'json-carrier-fixture.v1' };
    const propose = (selected = role) =>
      scope === 'personal'
        ? personal.harness.propose(
            {
              run: { ...fields, authority: systemAuthority(person.universeId) },
              role: selected,
              context: fixtureContext,
            },
            signal(),
          )
        : production.proposeProduction(
            {
              run: { ...fields, authority: { scopeId: 'scroll-supply', generation: 1 } },
              role: selected,
              context: fixtureContext,
            },
            signal(),
          );
    const rows = () =>
      database.db
        .selectFrom(scope === 'personal' ? 'reasoning.external_attempts' : 'reasoning.production_attempts')
        .selectAll()
        .where('run_id', '=', id)
        .orderBy('reserved_at')
        .orderBy('id')
        .execute();
    const runs = () =>
      database.db
        .selectFrom(scope === 'personal' ? 'reasoning.business_runs' : 'reasoning.production_runs')
        .select('id')
        .where('id', '=', id)
        .execute();
    const requests = () =>
      database.db
        .selectFrom(scope === 'personal' ? 'reasoning.protected_requests' : 'reasoning.production_requests')
        .selectAll()
        .execute();
    return { calls, logs, quotas: () => quotas, purge, ledger, person, role, propose, rows, runs, requests };
  }

  it('keeps exact JSON-string primary/repair hashes, byte-based token reservation, null failed drafts and replay identity', async () => {
    const h = await setup([
      { ok: false, echo: 'PRIVATE-REJECTED-DRAFT' },
      { ok: true, echo: 'lantern' },
    ]);
    expect(await h.propose()).toMatchObject({
      kind: 'proposed',
      repaired: true,
      output: { ok: true, echo: 'lantern' },
    });
    expect(h.calls).toHaveLength(2);
    expect(h.quotas()).toBe(2);
    const rows = await h.rows();
    expect(rows.map((row) => [row.step, row.prompt_version, row.input_tokens, row.output_tokens])).toEqual([
      ['primary', 'hp5-tool-json-string', 25, 10],
      ['repair', 'hp5-tool-json-string', 25, 10],
    ]);
    expect(rows[0]?.output).toBeNull();
    expect(rows[1]?.causation_attempt_id).toBe(rows[0]?.id);
    const requests = await h.requests();
    for (const [index, bytes] of h.calls.entries()) {
      expect(rows[index]?.request_hash).toBe(digest(bytes));
      expect(rows[index]?.reserved_tokens).toBe(reservedTokensFor(bytes.length, h.role.maxOutputTokens));
      const stored = requests.find((request) => request.attempt_id === rows[index]?.id);
      expect(stored?.body_sha256).toBe(digest(bytes));
      expect(new Uint8Array(stored?.body ?? [])).toEqual(bytes);
      const receipt = await database.db
        .selectFrom('reasoning.usage_receipts')
        .selectAll()
        .where('attempt_id', '=', rows[index]?.id ?? '')
        .executeTakeFirstOrThrow();
      expect(receipt).toMatchObject({ input_tokens: 25, output_tokens: 10, state: 'settled' });
    }
    expect(JSON.stringify({ rows, logs: h.logs })).not.toContain('PRIVATE');
    expect(await h.propose()).toMatchObject({ kind: 'proposed', repaired: true });
    expect(h.calls).toHaveLength(2);
    expect(h.quotas()).toBe(2);
    expect(
      await h.propose({ ...h.role, nativeOutputSchema: 'zod-structural.v1', outputFormat: 'single-tool-object' }),
    ).toEqual({
      kind: 'refused',
      reason: 'request_mismatch',
    });
    expect(h.calls).toHaveLength(2);
  });

  it('refuses unsupported capability, shape and serialized request size before purge, run, reserve or quota', async () => {
    for (const [options, outputSchema, reason] of [
      [{ formatSupported: false }, echoRole.outputSchema, 'output_format_unsupported'],
      [{ supported: false }, echoRole.outputSchema, 'output_schema_unsupported'],
      [{}, z.strictObject({ value: z.bigint() }), 'output_schema_unsupported'],
      [
        {},
        z.strictObject({
          value: z.string().min(1).max(20).meta({ description: 'ignored' }),
          tooWide: z.literal('x'.repeat(1025)),
        }),
        'output_schema_unsupported',
      ],
      [{ maxRequestBytes: 100 }, echoRole.outputSchema, 'request_too_large'],
    ] as const) {
      const h = await setup([], options);
      expect(await h.propose({ ...h.role, outputSchema })).toEqual({ kind: 'refused', reason });
      expect(h.purge).not.toHaveBeenCalled();
      expect(await h.rows()).toEqual([]);
      expect(await h.runs()).toEqual([]);
      expect(h.quotas()).toBe(0);
      expect(h.calls).toHaveLength(0);
    }
  });

  it('keeps quota preflight fail-closed and redacts successful native data before recording or return', async () => {
    const blocked = await setup([], { quota: 10 });
    expect(await blocked.propose()).toMatchObject({ kind: 'quota_unavailable' });
    expect(blocked.quotas()).toBe(1);
    expect(blocked.calls).toHaveLength(0);
    const h = await setup([{ ok: true, echo: 'https://x.test/a?Signature=PRIVATE-CREDENTIAL' }]);
    expect(await h.propose()).toMatchObject({ kind: 'proposed', output: { ok: true, echo: 'https://x.test/a' } });
    expect(JSON.stringify({ rows: await h.rows(), logs: h.logs })).not.toContain('PRIVATE');
    expect(h.calls).toHaveLength(1);
  });
  it('rejects incomplete mode pairs before purge and preserves truncation with only one repair', async () => {
    const invalid = await setup([]);
    expect(await invalid.propose({ ...invalid.role, nativeOutputSchema: undefined })).toEqual({
      kind: 'refused',
      reason: 'role_invalid',
    });
    expect(invalid.purge).not.toHaveBeenCalled();
    expect(await invalid.rows()).toEqual([]);
    expect(invalid.calls).toHaveLength(0);
    const h = await setup(
      [
        { ok: true, echo: 'lantern' },
        { ok: true, echo: 'lantern' },
      ],
      { stopReason: 'max_tokens' },
    );
    expect(await h.propose()).toMatchObject({ kind: 'invalid_output', reason: 'OUTPUT_TRUNCATED' });
    expect(await h.propose()).toMatchObject({ kind: 'invalid_output', reason: 'OUTPUT_TRUNCATED' });
    expect(h.calls).toHaveLength(2);
    expect((await h.rows()).map((r) => r.output)).toEqual([null, null]);
  });

  it('keeps invalid inner-array types invalid, consumes one repair only and never stores rejected raw content', async () => {
    const h = await setup(['{"ok":false,"echo":"PRIVATE-CANARY"}', '{"ok":false,"echo":"PRIVATE-CANARY"}']);
    expect(await h.propose()).toMatchObject({ kind: 'invalid_output' });
    expect(await h.propose()).toMatchObject({ kind: 'invalid_output' });
    expect(h.calls).toHaveLength(2);
    expect(h.quotas()).toBe(2);
    expect((await h.rows()).map((r) => r.output)).toEqual([null, null]);
    expect(JSON.stringify({ rows: await h.rows(), logs: h.logs })).not.toContain('PRIVATE-CANARY');
    const arrays = await setup(['{"sections":"[]","bindings":{}}', '{"sections":[],"bindings":[]}']);
    const role: ReasoningRole<unknown> = {
      ...arrays.role,
      outputSchema: z.strictObject({ sections: z.array(z.unknown()), bindings: z.array(z.unknown()) }),
    };
    expect(await arrays.propose(role)).toMatchObject({
      kind: 'proposed',
      repaired: true,
      output: { sections: [], bindings: [] },
    });
    expect(arrays.calls).toHaveLength(2);
    expect((await arrays.rows())[0]?.output).toBeNull();
  });

  it('never repairs or resends unknown transport, and expiry purges bytes while liability and receipts remain', async () => {
    const h = await setup(['CI-UNKNOWN-TRANSPORT']);
    expect(await h.propose()).toMatchObject({ kind: 'unknown' });
    expect(await h.propose()).toMatchObject({ kind: 'unknown' });
    expect(h.calls).toHaveLength(1);
    const row = (await h.rows())[0]!;
    expect(row.state).toBe('unknown');
    expect(row.output).toBeNull();
    if (scope === 'personal')
      await sql`update reasoning.protected_requests set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where attempt_id=${row.id}`.execute(
        database.db,
      );
    else
      await sql`update reasoning.production_requests set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where attempt_id=${row.id}`.execute(
        database.db,
      );
    expect(await h.ledger.purgeExpiredRequests(500)).toBeGreaterThanOrEqual(1);
    expect((await h.requests()).some((r) => r.attempt_id === row.id)).toBe(false);
    expect((await h.rows())[0]?.state).toBe('unknown');
    const receipt = await database.db
      .selectFrom('reasoning.usage_receipts')
      .selectAll()
      .where('attempt_id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(receipt.state).toBe('unknown');
    expect(await h.propose()).toMatchObject({ kind: 'unknown' });
    expect(h.calls).toHaveLength(1);
  });

  it('erases personal protected grammar/context/output and retains nonpersonal supply accounting', async () => {
    const h = await setup([{ ok: true, echo: 'lantern' }]);
    expect(await h.propose()).toMatchObject({ kind: 'proposed' });
    const row = (await h.rows())[0]!;
    const erased = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(h.person.authority, (tx) =>
      eraseUniverse(tx, personalStores),
    );
    expect(erased.kind).toBe('entered');
    if (scope === 'personal') {
      expect(await h.rows()).toEqual([]);
      expect((await h.requests()).some((r) => r.attempt_id === row.id)).toBe(false);
    } else {
      expect(await h.rows()).toHaveLength(1);
      expect((await h.requests()).some((r) => r.attempt_id === row.id)).toBe(true);
    }
    expect(
      await database.db
        .selectFrom('reasoning.usage_receipts')
        .select('state')
        .where('attempt_id', '=', row.id)
        .executeTakeFirst(),
    ).toEqual({ state: 'settled' });
  });
});
