import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeMiniMaxModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { ScrollDraft } from '@knowscroll/scroll-model/producer';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { canonicalJson } from '../../../packages/backend/src/infrastructure/receipts/canonical.js';
import {
  claimsRole,
  generatedProvenance,
  writerRole,
} from '../../../packages/backend/src/modules/content/production/roles.js';
import {
  quoteCandidates,
  hydrateSelectedClaims,
} from '../../../packages/backend/src/modules/content/production/quote-candidates.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { writerDraftExampleJson } from '../../../packages/backend/src/modules/content/production/writer-example.js';
import { deriveNativeInputSchema } from '../../../packages/backend/src/reasoning/domain/native-schema.js';
import { buildPrompt } from '../../../packages/backend/src/reasoning/domain/prompt.js';
import { validateOutput } from '../../../packages/backend/src/reasoning/domain/output.js';
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

// Authored CI fixtures only: real PostgreSQL + real adapter + fake HTTP. No provider/live job.
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
const source =
  'This labelled authored CI research passage supplies distinct wording for verifying exact quote selection while describing no actual world event, generated asset or provider result.';
const page = extractResearch(
  `<html><title>CI fixture only</title><main>${[0, 1, 2, 3].map((n) => `<p>${source} Passage ${n}.</p>`).join('')}</main></html>`,
  TOPICS.greenhouse.pages[0] ?? '',
  '2026-10-20T00:00:00.000Z',
);
const candidates = quoteCandidates([page]);
const selection = { candidateIds: candidates.slice(0, 4).map((c) => c.id) };
const claims = hydrateSelectedClaims([page], candidates, selection.candidateIds);
const provenance = generatedProvenance({
  topic: 'greenhouse',
  runId: 'schema-fixture',
  attemptIds: ['schema-fixture'],
  model: 'CI-fixture-only',
  claims,
  pages: [page],
});

describe('actual Content input descriptors, without activating a consumer', () => {
  it('encodes canonical writer and claims primary/repair shapes below the unchanged 100000-byte cap', () => {
    const descriptors: readonly ReasoningRole<unknown>[] = [
      claimsRole([page]),
      writerRole(provenance, false),
      writerRole(provenance, true),
    ];
    for (const original of descriptors) {
      expect(original.nativeOutputSchema).toBeUndefined();
      const role = { ...original, nativeOutputSchema: 'zod-structural.v1' as const };
      const schema = deriveNativeInputSchema(role.outputSchema);
      expect(schema).toBeDefined();
      expect(schema?.['required']).toEqual(
        original.id.endsWith('claims') ? ['candidateIds'] : ['draftVersion', 'title', 'dek', 'sections', 'bindings'],
      );
      // Use the shipped prepared brief/claims context shape; sources are labelled fixed fixtures.
      const context = original.id.endsWith('claims')
        ? {
            bundleRef: 'scroll:schema-fixture:research',
            items: [
              { ref: 'brief:greenhouse', kind: 'production_brief', text: TOPICS.greenhouse.brief },
              {
                ref: 'candidates:schema-fixture',
                kind: 'public_research_candidates',
                text: canonicalJson({ candidates }),
              },
            ],
          }
        : {
            bundleRef: 'scroll:schema-fixture:claims',
            items: [
              { ref: 'brief:greenhouse', kind: 'production_brief', text: TOPICS.greenhouse.brief },
              { ref: 'claims:schema-fixture', kind: 'checked_claims', text: canonicalJson(claims) },
            ],
          };
      const invalid = validateOutput(role.outputSchema, {}, role.safeCustomIssues);
      if (invalid.valid) throw new Error('Fixture must fail actual strict role validation');
      const bodies = [undefined, invalid.issues].map((feedback) => {
        const prompt = buildPrompt({
          roleId: role.id,
          roleVersion: 'schema-fixture.v1',
          instructions: role.instructions,
          ...context,
          outputFormat: 'single-tool-object',
          nativeOutputSchema: 'zod-structural.v1',
          ...(feedback === undefined ? {} : { feedback }),
        });
        return makeMiniMaxModelPort(settings).encode({
          ...prompt,
          maxOutputTokens: role.maxOutputTokens,
          outputFormat: 'single-tool-object',
          outputJsonSchema: schema,
        });
      });
      for (const body of bodies) {
        expect(body.length).toBeLessThanOrEqual(100000);
        expect(new TextDecoder().decode(body)).toContain('hp4-tool-schema');
        expect(reservedTokensFor(body.length, role.maxOutputTokens)).toBe(body.length + role.maxOutputTokens);
      }
      expect(digest(bodies[0] ?? new Uint8Array())).not.toBe(digest(bodies[1] ?? new Uint8Array()));
      // Safe metrics only; no request/prompt/context/provenance text enters CI output.
      process.stdout.write(
        `${JSON.stringify({
          event: 'native-schema-fixture-size',
          role: role.id,
          primaryBytes: bodies[0]?.length,
          repairBytes: bodies[1]?.length,
          schemaBytes: Buffer.byteLength(JSON.stringify(schema)),
          requestCap: 100000,
        })}\n`,
      );
    }
    const role = claimsRole([page]);
    expect(role.outputSchema.safeParse(selection).success).toBe(true);
    expect(role.outputSchema.safeParse({ candidateIds: selection.candidateIds.slice(0, 3) }).success).toBe(false);
    expect(role.outputSchema.safeParse({ candidateIds: Array(4).fill(selection.candidateIds[0]) }).success).toBe(false);
    expect(role.outputSchema.safeParse(claims).success).toBe(false);
    const draft = JSON.parse(writerDraftExampleJson(false)) as unknown;
    expect(ScrollDraft.safeParse(draft).success).toBe(true);
    expect(writerRole(provenance, false).outputSchema.safeParse(draft).success).toBe(false);
  });
});

describe.each(['personal', 'production'] as const)('advisory native schema through the %s harness', (scope) => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>(`native-schema-${scope}`);
    await database.db
      .updateTable('reasoning.production_scopes')
      .set({ enabled: true })
      .where('id', '=', 'scroll-supply')
      .execute();
  });
  afterAll(async () => {
    await database.drop();
  });

  async function setup(
    answers: readonly unknown[],
    options: { supported?: boolean; maxRequestBytes?: number; quota?: number } = {},
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
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'message',
            id: 'msg_native_schema_fixture',
            stop_reason: 'tool_use',
            content: [
              { type: 'thinking', thinking: 'PRIVATE-THINKING' },
              { type: 'tool_use', name: 'submit_output', input },
            ],
            usage: { input_tokens: 25, output_tokens: 10 },
          }),
        ),
      );
    });
    const model = { ...port, supportsNativeOutputSchema: options.supported ?? true };
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
      version: 'native-schema-fixture.v1',
      outputFormat: 'single-tool-object',
      nativeOutputSchema: 'zod-structural.v1',
    };
    const fields = { id, ownerModule: 'fixture', purpose: 'native-schema', policyVersion: 'native-schema-fixture.v1' };
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
    return { calls, logs, quotas: () => quotas, purge, role, propose, rows, runs, requests };
  }

  it('keeps exact native primary/repair hashes, byte-based token reservation, null failed drafts and replay identity', async () => {
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
      ['primary', 'hp4-tool-schema', 25, 10],
      ['repair', 'hp4-tool-schema', 25, 10],
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
    expect(await h.propose({ ...h.role, nativeOutputSchema: undefined })).toEqual({
      kind: 'refused',
      reason: 'request_mismatch',
    });
    expect(h.calls).toHaveLength(2);
  });

  it('refuses unsupported capability, shape and serialized request size before purge, run, reserve or quota', async () => {
    for (const [options, outputSchema, reason] of [
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
});
