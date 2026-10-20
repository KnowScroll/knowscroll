import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ProductionReasoningHarness, ReasoningRole } from '@knowscroll/backend/reasoning';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  guardedModelPort,
  makeMiniMaxModelPort,
  type MiniMaxSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { ScrollDraft, normaliseDraftInput, REPAIR_HINTS } from '@knowscroll/scroll-model/producer';
import {
  extractResearch,
  ResearchRefusal,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import {
  hydrateSelectedClaims,
  quoteCandidates,
} from '../../../packages/backend/src/modules/content/production/quote-candidates.js';
import { writerDraftExampleJson } from '../../../packages/backend/src/modules/content/production/writer-example.js';
import {
  TOPICS,
  explanationUnitFor,
  type ScrollTopic,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import {
  claimsRole,
  generatedProvenance,
  writerRole,
} from '../../../packages/backend/src/modules/content/production/roles.js';
import {
  MAX_ISSUES,
  validateOutput,
  validSafeCustomIssues,
} from '../../../packages/backend/src/reasoning/domain/output.js';
import { buildPrompt } from '../../../packages/backend/src/reasoning/domain/prompt.js';
import { deriveNativeInputSchema } from '../../../packages/backend/src/reasoning/domain/native-schema.js';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import { canonicalJson } from '../../../packages/backend/src/infrastructure/receipts/canonical.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

// Every word below and every model answer is a labelled, authored CI fixture, never real provider evidence.
const passage =
  'This deliberately authored fixture passage describes the public research snapshot boundary with sufficiently distinctive wording for exact quote checks while avoiding overlap with the separate fixture explanation.';
function researchFixture(url: string): ResearchPage {
  // Every two-source recipe needs distinct content hashes, not merely different URLs.
  // Retain the original page/claim bytes and tides marker; new primary snapshots are authored separately.
  const extra =
    url === TOPICS.tides.pages[1]
      ? ' A separately authored second research snapshot.'
      : url === TOPICS['greenhouse-radiation'].pages[0]
        ? ' An independently authored radiation-path research fixture.'
        : url === TOPICS['greenhouse-balance'].pages[0]
          ? ' An independently authored system-boundary research fixture.'
          : '';
  return extractResearch(
    `<html><title>CI fixture</title><main>${[0, 1, 2, 3].map((n) => `<p>${passage} Example ${n}.${extra}</p>`).join('')}</main></html>`,
    url,
    '2026-10-20T00:00:00.000Z',
  );
}
const page = researchFixture('https://spaceplace.nasa.gov/seasons/en/');
const candidates = quoteCandidates([page]);
const selection = { candidateIds: candidates.slice(0, 4).map(({ id }) => id) };
const claims = hydrateSelectedClaims([page], candidates, selection.candidateIds);
function draft(interactive = false) {
  const starter = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/backend/src/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { draft: unknown };
  const value = ScrollDraft.parse(normaliseDraftInput(starter.draft));
  for (const section of value.sections)
    for (const block of section.blocks) {
      if (block.type !== 'subheading')
        value.bindings.push({ kind: 'block', blockId: block.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
      if (block.type === 'disclosure')
        for (const child of block.data.blocks)
          value.bindings.push({ kind: 'block', blockId: child.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
    }
  if (interactive) {
    const diagram = ScrollDraft.parse(JSON.parse(writerDraftExampleJson(true))).sections[0]?.blocks[1];
    if (diagram === undefined) throw new Error('CI_DIAGRAM_MISSING');
    value.sections[0]?.blocks.push(diagram);
    value.bindings.push({ kind: 'block', blockId: diagram.id ?? '', claimId: claims.claims[0]?.claimId ?? '' });
  }
  return value;
}
const answer = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });
// Cross-module harness assertions belong in integration, outside content's public-only module boundary.
describe('writer semantic feedback contract (authored CI fixture; no provider network)', () => {
  const sourceWords = passage;
  const fixtureDraft = () => draft();
  const provenance = generatedProvenance({
    topic: 'greenhouse',
    runId: 'fixture-writer-run',
    attemptIds: ['fixture-attempt'],
    model: 'CI-fixture-only',
    claims,
    pages: [page],
  });
  it('declares a bounded static writer catalogue admitted by the shared role contract; claims keep semantic feedback opted out', () => {
    const role = writerRole(provenance, false);
    expect(role.safeCustomIssues).toBeDefined();
    expect(validSafeCustomIssues(role.safeCustomIssues ?? {})).toBe(true);
    expect(role.safeCustomIssues).toMatchObject(REPAIR_HINTS);
    expect(Object.keys(role.safeCustomIssues ?? {}).length).toBe(Object.keys(REPAIR_HINTS).length + 3);
    expect(Object.isFrozen(role.safeCustomIssues)).toBe(true);
    expect(role.safeCustomIssues).not.toHaveProperty('admission_refused');
    expect(claimsRole([page]).safeCustomIssues).toBeUndefined();
    expect(claimsRole([page]).id).toBe('content.scroll-claims');
    expect(claimsRole([page]).version).toBe('scroll-claims.v4');
    expect(claimsRole([page]).nativeOutputSchema).toBe('zod-structural.v1');
    expect(role.id).toBe('content.scroll-writer');
    expect(role.version).toBe('scroll-writer.v6');
    expect(role.nativeOutputSchema).toBe('zod-structural.v1');
  });

  it.each([
    ['copied_passage', sourceWords],
    ['number_unbound', 'An unexplained count is 99 today.'],
    ['reader_source_or_url', 'A publisher called NASA said this.'],
  ])('carries an actual writer %s refusal through masked fixed feedback into repair context', (code, text) => {
    const role = writerRole(provenance, false);
    const bad = fixtureDraft();
    const paragraph = bad.sections[0]?.blocks.find((block) => block.type === 'paragraph');
    if (paragraph?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
    paragraph.data.spans = [{ text }];
    const result = validateOutput(role.outputSchema, bad, role.safeCustomIssues);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe('OUTPUT_SCHEMA_MISMATCH');
    expect(result.issues).toContainEqual(expect.objectContaining({ code, detail: role.safeCustomIssues?.[code] }));
    expect(result.issues.length).toBeLessThanOrEqual(MAX_ISSUES + 1);
    const repair = buildPrompt({
      roleId: role.id,
      roleVersion: role.version,
      instructions: role.instructions,
      outputFormat: role.outputFormat,
      nativeOutputSchema: role.nativeOutputSchema,
      bundleRef: 'ci-fixture-semantic-feedback',
      items: [],
      feedback: result.issues,
    });
    expect(repair.system).toContain(`${code} (${role.safeCustomIssues?.[code]})`);
    expect(repair.system).not.toContain(text);
    expect(JSON.stringify(result.issues)).not.toContain(text);
    expect(JSON.stringify(result.issues)).not.toContain(page.url);
    if (code === 'copied_passage' || code === 'number_unbound')
      expect(result.issues.some((issue) => issue.path.includes('?'))).toBe(true);
    // The same actual writer schema still suppresses semantic metadata without the explicit catalogue.
    const optedOut = validateOutput(role.outputSchema, bad);
    expect(optedOut.valid).toBe(false);
    if (!optedOut.valid)
      expect(optedOut.issues.every((issue) => issue.code === 'custom' && issue.detail === undefined)).toBe(true);
  });

  it('offers fixed feedback for production support and interactive requirements without accepting invalid drafts', () => {
    const missing = fixtureDraft();
    missing.bindings = [];
    for (const [role, value, code] of [
      [writerRole(provenance, false), missing, 'reader_block_unbound'],
      [writerRole(provenance, true), fixtureDraft(), 'interactive_required'],
    ] as const) {
      const verdict = validateOutput(role.outputSchema, value, role.safeCustomIssues);
      expect(verdict.valid).toBe(false);
      if (!verdict.valid)
        expect(verdict.issues).toContainEqual(expect.objectContaining({ code, detail: role.safeCustomIssues?.[code] }));
    }
  });

  it('keeps undeclared custom codes, reply-chosen paths and arbitrary messages out of writer feedback', () => {
    const role = writerRole(provenance, false);
    const privateText = 'WRITER-PRIVATE-UNDECLARED https://private.invalid/?Signature=fixture';
    const schema = role.outputSchema.superRefine((_draft, ctx) => {
      for (let index = 0; index < MAX_ISSUES + 2; index += 1)
        ctx.addIssue({
          code: 'custom',
          path: ['sections', 0, privateText],
          message: privateText,
          params: { safeCode: privateText },
        });
    });
    const verdict = validateOutput(schema, fixtureDraft(), role.safeCustomIssues);
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.issues).toHaveLength(MAX_ISSUES + 1);
    expect(verdict.issues.slice(0, MAX_ISSUES)).toEqual(
      Array.from({ length: MAX_ISSUES }, () => ({ path: 'sections[0].?', code: 'custom' })),
    );
    expect(verdict.issues.at(-1)).toEqual({ path: '(root)', code: 'more', detail: '2 more' });
    expect(JSON.stringify(verdict.issues)).not.toContain(privateText);
  });
});

// Authored text mirrors the observed bounded pool counts/total text sizes, not NASA prose.
// Actual public snapshots remain private investigation evidence; these fixtures confer no meaning.
function boundedRecipeResearch(url: string): ResearchPage {
  const count = url.includes('faq/') ? 7 : url.includes('/ems/') ? 15 : 20;
  const total = count === 7 ? 1923 : count === 15 ? 4040 : 7767;
  const paragraphs = Array.from({ length: count }, (_, index) => {
    const length = Math.floor(total / count) + (index < total % count ? 1 : 0);
    const prefix = `Authored bounded fixture passage ${index} `;
    return `${prefix}${'synthetic context '.repeat(40).slice(0, length - prefix.length - 1)}.`;
  });
  return extractResearch(
    `<html><title>Authored size fixture</title><main>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</main></html>`,
    url,
    '2026-10-20T00:00:00.000Z',
  );
}
describe('new recipe native bodies (authored bounded context; no provider network)', () => {
  it.each(['greenhouse-radiation', 'greenhouse-balance', 'greenhouse-limits'] as const)(
    'fits primary and repair for %s through the real M3 encoder without raising caps',
    (topic) => {
      const recipe = TOPICS[topic];
      const pages = recipe.pages.map(boundedRecipeResearch);
      const pool = quoteCandidates(pages);
      expect(pool).toHaveLength(topic === 'greenhouse-balance' ? 27 : 22);
      const ids = pages.flatMap((source) =>
        pool
          .filter(({ pageId }) => pageId === source.id)
          .slice(0, 4)
          .map(({ id }) => id),
      );
      const checked = hydrateSelectedClaims(pages, pool, ids);
      const provenance = generatedProvenance({
        topic,
        runId: 'bounded-fixture',
        attemptIds: ['bounded-fixture'],
        model: 'CI-fixture-only',
        claims: checked,
        pages,
      });
      const roles: readonly ReasoningRole<unknown>[] = [claimsRole(pages), writerRole(provenance, recipe.interactive)];
      for (const role of roles) {
        const isClaims = role.id === 'content.scroll-claims';
        const context = isClaims ? { policyVersion: 'quote-candidates.v1', candidates: pool } : checked;
        const invalid = validateOutput(role.outputSchema, {}, role.safeCustomIssues);
        if (invalid.valid) throw new Error('CI_INVALID_OUTPUT_ACCEPTED');
        const bodies = [undefined, invalid.issues].map((feedback) => {
          const prompt = buildPrompt({
            roleId: role.id,
            roleVersion: role.version,
            instructions: role.instructions,
            bundleRef: `scroll:bounded-fixture:${isClaims ? 'research' : 'claims'}`,
            items: [
              { ref: `brief:${topic}`, kind: 'production_brief', text: recipe.brief },
              {
                ref: `${isClaims ? 'quote-candidates' : 'claims'}:bounded-fixture`,
                kind: isClaims ? 'public_research_candidates' : 'checked_claims',
                text: canonicalJson(context),
              },
            ],
            outputFormat: 'single-tool-object',
            nativeOutputSchema: 'zod-structural.v1',
            ...(feedback === undefined ? {} : { feedback }),
          });
          return makeMiniMaxModelPort({
            apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
            model: 'MiniMax-M3',
            requestTimeoutMs: 200,
            quotaTimeoutMs: 200,
            quotaFloorPercent: 25,
            maxReplyBytes: 524288,
            maxRequestBytes: 100000,
          }).encode({
            ...prompt,
            maxOutputTokens: role.maxOutputTokens,
            outputFormat: 'single-tool-object',
            outputJsonSchema: deriveNativeInputSchema(role.outputSchema),
          });
        });
        for (const body of bodies) {
          expect(body.length).toBeLessThanOrEqual(100000);
          const wire = JSON.parse(new TextDecoder().decode(body)) as {
            max_tokens: number;
            tool_choice: unknown;
            tools: { input_schema: unknown }[];
          };
          expect(wire.max_tokens).toBe(isClaims ? 4000 : 12000);
          expect(wire.tool_choice).toEqual({ type: 'auto' });
          expect(wire.tools[0]?.input_schema).toEqual(deriveNativeInputSchema(role.outputSchema));
        }
        expect(
          createHash('sha256')
            .update(bodies[0] ?? new Uint8Array())
            .digest('hex'),
        ).not.toBe(
          createHash('sha256')
            .update(bodies[1] ?? new Uint8Array())
            .digest('hex'),
        );
        process.stdout.write(
          `${JSON.stringify({ event: 'coherent-recipe-authored-size', topic, role: role.id, candidateCount: pool.length, primaryBytes: bodies[0]?.length, repairBytes: bodies[1]?.length, cap: 100000 })}\n`,
        );
      }
      expect(claimsRole(pages).outputSchema.safeParse({ candidateIds: ids.slice(0, 3) }).success).toBe(false);
      expect(
        writerRole(provenance, recipe.interactive).outputSchema.safeParse(
          JSON.parse(writerDraftExampleJson(recipe.interactive)),
        ).success,
      ).toBe(false);
    },
  );
});

describe('Scroll production (CI fixture + real PostgreSQL; no provider network)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('scroll_production');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });
  function setup(script: Parameters<typeof fixtureModel>[0], admittedProviderIdentity = false) {
    // No transport/network is real: this explicit identity stand-in exercises production attribution.
    const fixture = fixtureModel(script, { label: 'scroll-production-CI-fixture' });
    const model = guardedModelPort({
      ...fixture,
      // Scripted domain fixtures declare the data capability; actual wire shape is exercised below.
      supportsSingleToolObject: true,
      supportsNativeOutputSchema: true,
      provider: admittedProviderIdentity ? 'minimax' : fixture.provider,
      model: admittedProviderIdentity ? 'MiniMax-M3' : fixture.model,
    });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: withScope,
        enabled: true,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    const produce = (
      selected: ProductionReasoningHarness = harness,
      research: (url: string) => Promise<ResearchPage> = (url) =>
        Promise.resolve(
          url === TOPICS.tides.pages[1] ||
            url === TOPICS['greenhouse-radiation'].pages[0] ||
            url === TOPICS['greenhouse-balance'].pages[0]
            ? researchFixture(url)
            : page,
        ),
    ) =>
      makeProduceScroll({
        db: database.db,
        authority: { scopeId: 'scroll-supply', generation: 1 },
        withScope,
        harness: selected,
        model: model.model,
        research,
      });
    return { model, harness, produce };
  }

  function setupNative(
    script: (sequence: number) => { input: unknown } | { blocks: unknown[] } | { disconnected: true },
    configuredModel: MiniMaxSettings['model'] = 'MiniMax-M3',
  ) {
    // Real reviewed encoder/parser, authored HTTP responses and no real provider/quota network.
    const calls: Uint8Array[] = [];
    let quotaChecks = 0;
    const transport = makeMiniMaxModelPort(
      {
        apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
        model: configuredModel,
        requestTimeoutMs: 200,
        quotaTimeoutMs: 200,
        quotaFloorPercent: 25,
        maxReplyBytes: 524_288,
        maxRequestBytes: 100_000,
      },
      (url, init) => {
        expect(url).toBe('https://api.minimax.io/anthropic/v1/messages');
        calls.push(new Uint8Array(init?.body as Uint8Array));
        const reply = script(calls.length);
        if ('disconnected' in reply) throw new TypeError('CI disconnection', { cause: { code: 'ECONNRESET' } });
        const content =
          'blocks' in reply
            ? reply.blocks
            : [
                { type: 'thinking', thinking: 'PRIVATE-NATIVE-THINKING-CANARY' },
                { type: 'tool_use', id: 'ci-output-only', name: 'submit_output', input: reply.input },
              ];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_ci_native',
              type: 'message',
              role: 'assistant',
              content,
              stop_reason: 'tool_use',
              usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0 },
            }),
          ),
        );
      },
    );
    const model = guardedModelPort({
      ...transport,
      observeQuota() {
        quotaChecks += 1;
        return Promise.resolve({
          verdict: 'not_applicable' as const,
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        });
      },
    });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: withScope,
        enabled: true,
        model,
        logEvent: silent,
        settings: { ...fixtureSettings, maxRequestBytes: 100_000 },
      }),
    );
    const produce = makeProduceScroll({
      db: database.db,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope,
      harness,
      model: model.model,
      research: () => Promise.resolve(page),
    });
    return { calls, harness, produce, quotaChecks: () => quotaChecks };
  }

  it.each([false, true])(
    'uses native objects for both roles and their only repair, interactive=%s (fake HTTP)',
    async (interactive) => {
      const copied = draft(interactive);
      const paragraph = copied.sections[0]?.blocks.find((block) => block.type === 'paragraph');
      if (paragraph?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
      paragraph.data.spans = [{ text: passage }];
      const inputs = [{ candidateIds: selection.candidateIds.slice(0, 3) }, selection, copied, draft(interactive)];
      const p = setupNative((sequence) => {
        if (sequence > inputs.length) throw new Error('CI_UNEXPECTED_EXTRA_ATTEMPT');
        return { input: inputs[sequence - 1] };
      });
      const topic = interactive ? 'seasons' : 'greenhouse';
      const first = await p.produce(topic, false, signal());
      expect(first).toMatchObject({ outcome: 'published', requestBound: 4 });
      expect(p.calls).toHaveLength(4);
      expect(p.quotaChecks()).toBe(4);
      const wires = p.calls.map(
        (bytes) =>
          JSON.parse(new TextDecoder().decode(bytes)) as {
            tools: unknown[];
            tool_choice: unknown;
            system: string;
            max_tokens: number;
          },
      );
      const expectedClaims = deriveNativeInputSchema(claimsRole([page]).outputSchema);
      const expectedWriter = deriveNativeInputSchema(
        writerRole(
          generatedProvenance({
            topic,
            runId: 'ci-schema-only',
            attemptIds: [],
            model: 'MiniMax-M3',
            claims,
            pages: [page],
          }),
          interactive,
        ).outputSchema,
      );
      expect(expectedClaims).toBeDefined();
      expect(expectedWriter).toBeDefined();
      expect(expectedClaims?.['required']).toEqual(['candidateIds']);
      expect(expectedWriter?.['required']).toEqual(['draftVersion', 'title', 'dek', 'sections', 'bindings']);
      for (const [index, wire] of wires.entries()) {
        expect(wire.tools).toEqual([
          {
            name: 'submit_output',
            description:
              'Submit the complete answer object as data matching the advisory input shape. This tool executes no action.',
            input_schema: index < 2 ? expectedClaims : expectedWriter,
          },
        ]);
        expect(wire.tool_choice).toEqual({ type: 'auto' });
        expect(wire.system).toContain('framing hp4-tool-schema');
        expect(wire.system).toContain('including for a repair');
        expect(wire).not.toHaveProperty('response_format');
        expect(p.calls[index]?.byteLength).toBeLessThanOrEqual(100000);
        expect(wire.max_tokens).toBe(index < 2 ? 4000 : 12000);
      }
      process.stdout.write(
        `${JSON.stringify({
          event: 'content-native-schema-request-bytes',
          interactive,
          bytes: p.calls.map((bytes) => bytes.byteLength),
          cap: 100000,
        })}\n`,
      );
      expect(wires.slice(0, 2).every((wire) => wire.system.includes('version scroll-claims.v4,'))).toBe(true);
      expect(wires.slice(2).every((wire) => wire.system.includes('version scroll-writer.v6,'))).toBe(true);
      expect(wires[1]?.system).toContain('candidateIds: too_small (at least 4 items)');
      expect(wires[3]?.system).toContain(`copied_passage (${REPAIR_HINTS.copied_passage})`);
      expect(wires[3]?.system).not.toContain(passage);
      expect(wires[3]?.system).not.toContain(page.url);
      const attempts = await database.db
        .selectFrom('reasoning.production_attempts')
        .selectAll()
        .orderBy('reserved_at')
        .orderBy('id')
        .execute();
      expect(
        attempts.map((row) => [row.role_id, row.role_version, row.step, row.prompt_version, row.outcome_code]),
      ).toEqual([
        ['content.scroll-claims', 'scroll-claims.v4', 'primary', 'hp4-tool-schema', 'OUTPUT_SCHEMA_MISMATCH'],
        ['content.scroll-claims', 'scroll-claims.v4', 'repair', 'hp4-tool-schema', 'SUCCEEDED'],
        ['content.scroll-writer', 'scroll-writer.v6', 'primary', 'hp4-tool-schema', 'OUTPUT_SCHEMA_MISMATCH'],
        ['content.scroll-writer', 'scroll-writer.v6', 'repair', 'hp4-tool-schema', 'SUCCEEDED'],
      ]);
      expect(attempts[0]?.output).toBeNull();
      expect(attempts[2]?.output).toBeNull();
      expect(JSON.stringify(attempts)).not.toContain(passage);
      expect(JSON.stringify(attempts)).not.toContain('PRIVATE-NATIVE-THINKING');
      const protectedRows = await database.db
        .selectFrom('reasoning.production_requests')
        .select(['attempt_id', 'body', 'body_sha256'])
        .execute();
      for (const [index, bytes] of p.calls.entries()) {
        expect(new Uint8Array(protectedRows.find((row) => row.attempt_id === attempts[index]?.id)?.body ?? [])).toEqual(
          bytes,
        );
        const digest = createHash('sha256').update(bytes).digest('hex');
        expect(attempts[index]?.request_hash).toBe(digest);
        expect(protectedRows.find((row) => row.attempt_id === attempts[index]?.id)?.body_sha256).toBe(digest);
        expect(attempts[index]?.reserved_tokens).toBe(bytes.length + (index < 2 ? 4000 : 12000));
      }
      const usage = await database.db
        .selectFrom('reasoning.usage_receipts')
        .select(['attempt_id', 'state', 'input_tokens', 'output_tokens'])
        .execute();
      expect(usage).toHaveLength(4);
      expect(usage.every((row) => row.state === 'settled' && row.input_tokens === 20 && row.output_tokens === 5)).toBe(
        true,
      );
      expect(new Set(usage.map((row) => row.attempt_id))).toEqual(new Set(attempts.map((row) => row.id)));
      const runs = await database.db
        .selectFrom('reasoning.production_runs')
        .select(['policy_version', 'generation'])
        .execute();
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.policy_version === 'scroll-production.v8' && run.generation === 1)).toBe(true);
      for (const receipt of first.attempts?.filter((item) => item.role !== 'checks') ?? []) {
        expect(receipt).toMatchObject({ repaired: true, inputTokens: 40, outputTokens: 10 });
        expect(receipt.attempts?.map((item) => item.step)).toEqual(['primary', 'repair']);
      }
      const provenance = await database.db
        .selectFrom('content.asset_provenance')
        .select('provenance')
        .where('asset_id', '=', first.assetId ?? '')
        .executeTakeFirstOrThrow();
      expect(provenance.provenance).toMatchObject({
        production: {
          promptVersion: 'scroll-writer.v6',
          model: 'MiniMax-M3',
          attemptIds: attempts.slice(2).map((attempt) => attempt.id),
        },
      });
      expect(await p.produce(topic, false, signal(), true)).toEqual(first);
      expect(p.calls).toHaveLength(4);
      expect(p.quotaChecks()).toBe(4);
    },
  );

  it('refuses JSON-string and mixed-text native writer answers without salvage or a third writer attempt', async () => {
    const p = setupNative((sequence) =>
      sequence === 1
        ? { input: selection }
        : sequence === 2
          ? { input: JSON.stringify(draft()) }
          : {
              blocks: [
                { type: 'tool_use', name: 'submit_output', input: draft() },
                { type: 'text', text: '' },
              ],
            },
    );
    const result = await p.produce('greenhouse', false, signal());
    expect(result.outcome).toBe('rejected');
    expect(p.calls).toHaveLength(3);
    const attempts = await database.db
      .selectFrom('reasoning.production_attempts')
      .select(['role_id', 'step', 'outcome_code', 'output'])
      .orderBy('reserved_at')
      .orderBy('id')
      .execute();
    expect(attempts.slice(1)).toEqual([
      { role_id: 'content.scroll-writer', step: 'primary', outcome_code: 'REPLY_TOOL_INPUT_INVALID', output: null },
      { role_id: 'content.scroll-writer', step: 'repair', outcome_code: 'REPLY_TOOL_SHAPE_INVALID', output: null },
    ]);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
    // Top-level rejection codes describe this delivery; the persisted summary retains receipts instead.
    const { codes, ...persistedSummary } = result;
    expect(codes).toEqual(['invalid_output']);
    expect(await p.produce('greenhouse', false, signal(), true)).toEqual(persistedSummary);
    expect(p.calls).toHaveLength(3);
    expect(p.quotaChecks()).toBe(3);
    expect(
      await database.db
        .selectFrom('reasoning.production_attempts')
        .select(['role_id', 'step', 'outcome_code', 'output'])
        .orderBy('reserved_at')
        .orderBy('id')
        .execute(),
    ).toEqual(attempts);
  });

  it.each(['claims', 'writer'] as const)(
    'never resends an uncertain native %s attempt on explicit resume',
    async (role) => {
      const p = setupNative((sequence) =>
        role === 'claims' || sequence === 2 ? { disconnected: true } : { input: selection },
      );
      const first = await p.produce('greenhouse', false, signal());
      expect(first.outcome).toBe('unknown');
      const count = role === 'claims' ? 1 : 2;
      expect(p.calls).toHaveLength(count);
      expect((await p.produce('greenhouse', false, signal(), true)).outcome).toBe('unknown');
      expect(p.calls).toHaveLength(count);
      expect(p.quotaChecks()).toBe(count);
    },
  );

  it('refuses both product roles on M2.7 before reasoning admission, quota or transport', async () => {
    const p = setupNative(() => {
      throw new Error('CI_FORBIDDEN_TRANSPORT');
    }, 'MiniMax-M2.7');
    const provenance = generatedProvenance({
      topic: 'greenhouse',
      runId: randomUUID(),
      attemptIds: [],
      model: 'MiniMax-M2.7',
      claims,
      pages: [page],
    });
    const roles: readonly ReasoningRole<unknown>[] = [claimsRole([page]), writerRole(provenance, false)];
    for (const role of roles)
      expect(
        await p.harness.proposeProduction(
          {
            run: {
              id: randomUUID(),
              ownerModule: 'content',
              purpose: 'fixture-unsupported',
              policyVersion: 'scroll-production.v8',
              authority: { scopeId: 'scroll-supply', generation: 1 },
            },
            role,
            context: { bundleRef: 'ci-unsupported', items: [] },
          },
          signal(),
        ),
      ).toEqual({ kind: 'refused', reason: 'output_format_unsupported' });
    expect(p.calls).toHaveLength(0);
    expect(p.quotaChecks()).toBe(0);
    expect(await database.db.selectFrom('reasoning.production_runs').select('id').execute()).toHaveLength(0);
    expect(await database.db.selectFrom('reasoning.production_attempts').select('id').execute()).toHaveLength(0);
  });
  it('publishes once, keeps private provenance separate and does no further work on rerun', async () => {
    const p = setup((n) => answer(n === 1 ? selection : draft()));
    const first = await p.produce()('greenhouse', false, signal());
    expect(first).toMatchObject({ outcome: 'published', requestBound: 4, revision: 1 });
    expect(p.model.calls).toHaveLength(2);
    expect(await p.produce()('greenhouse', false, signal())).toEqual(first);
    expect(p.model.calls).toHaveLength(2);
    const revision = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'explanation_unit_id', 'provenance_kind'])
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(revision.explanation_unit_id).toBe('legacy-cutroom-greenhouse');
    expect(revision.provenance_kind).toBe('generated');
    for (const hidden of ['claims', 'sources', 'bindings', 'checks', 'production'])
      expect(revision.document).not.toHaveProperty(hidden);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({ production: { model: 'fixture-model-v1' } });
    expect(
      await database.db
        .selectFrom('content.asset_revisions')
        .select('revision')
        .where('asset_id', '=', first.assetId ?? '')
        .execute(),
    ).toHaveLength(1);
  });
  it.each([
    'greenhouse',
    'seasons',
    'tides',
    'greenhouse-radiation',
    'greenhouse-balance',
    'greenhouse-limits',
  ] as const)(
    'attributes only a newly completed exact %s publication (CI transport identity stand-in)',
    async (topic) => {
      const p = setup((n) => answer(n === 1 ? selection : draft(TOPICS[topic].interactive)), true);
      const result = await p.produce()(topic, false, signal());
      expect(result.outcome).toBe('published');
      expect(p.model.calls).toHaveLength(2);
      const exactRevision = await database.db
        .selectFrom('content.asset_revisions')
        .select('explanation_unit_id')
        .where('asset_id', '=', result.assetId ?? '')
        .executeTakeFirstOrThrow();
      expect(result.assetId).toBe(TOPICS[topic].assetId);
      expect(exactRevision.explanation_unit_id).toBe(explanationUnitFor(topic));
      expect(p.model.calls[1]?.request.system).toContain('version scroll-writer.v6,');
      expect(
        await database.db
          .selectFrom('content.scroll_production_runs')
          .select('policy_version')
          .where('id', '=', result.runId ?? '')
          .executeTakeFirstOrThrow(),
      ).toEqual({ policy_version: 'scroll-production.v8' });
      expect(
        await database.db
          .selectFrom('content.asset_provenance')
          .select('provenance')
          .where('asset_id', '=', result.assetId ?? '')
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        provenance: { production: { promptVersion: 'scroll-writer.v6' } },
      });
      expect(p.model.calls.every((call) => call.request.fixture === 'scroll-production-CI-fixture')).toBe(true);
      const projected = await database.db
        .selectFrom('content.discovery_revisions')
        .select(['facets', 'attribution_version'])
        .where('asset_id', '=', result.assetId ?? '')
        .executeTakeFirstOrThrow();
      expect(projected).toEqual({
        facets: [TOPICS[topic].topicId],
        attribution_version: 'published-scroll-brief-taxonomy.v1',
      });
      expect(
        await database.db
          .selectFrom('content.encounter_topics')
          .select(['topic_id', 'role', 'weight'])
          .where('asset_id', '=', result.assetId ?? '')
          .execute(),
      ).toEqual([{ topic_id: TOPICS[topic].topicId, role: 'primary', weight: 1 }]);
      const bytes = () =>
        sql<{
          document: string;
          provenance: string;
        }>`select row_to_json(r)::text as document,row_to_json(p)::text as provenance from content.asset_revisions r join content.asset_provenance p using(asset_id,revision) where r.asset_id=${result.assetId}::uuid`.execute(
          database.db,
        );
      const before = (await bytes()).rows;
      expect(await p.produce()(topic, false, signal(), true)).toEqual(result);
      expect((await bytes()).rows).toEqual(before);
      expect(p.model.calls).toHaveLength(2);
      expect(await database.db.selectFrom('identity.universes').select('id').execute()).toHaveLength(0);
    },
  );
  it('publishes three distinct new units under one canonical topic without creating personal evidence', async () => {
    const assets: string[] = [];
    for (const topic of ['greenhouse-radiation', 'greenhouse-balance', 'greenhouse-limits'] as const) {
      const p = setup((n) => answer(n === 1 ? selection : draft(TOPICS[topic].interactive)), true);
      const result = await p.produce()(topic, false, signal());
      expect(result.outcome).toBe('published');
      expect(result.requestBound).toBe(4);
      assets.push(result.assetId ?? '');
      expect(p.model.calls).toHaveLength(2);
    }
    const topics = await database.db
      .selectFrom('content.encounter_topics')
      .select(['asset_id', 'topic_id', 'role', 'weight'])
      .where('asset_id', 'in', assets)
      .execute();
    expect(topics).toHaveLength(3);
    expect(new Set(topics.map(({ topic_id }) => topic_id))).toEqual(new Set(['earth.greenhouse-effect']));
    expect(topics.every(({ role, weight }) => role === 'primary' && weight === 1)).toBe(true);
    expect(new Set(assets).size).toBe(3);
    expect(await database.db.selectFrom('identity.universes').select('id').execute()).toHaveLength(0);
  });
  it('keeps the persisted recipe-key constraint closed after the forward extension', async () => {
    for (const topic of ['greenhouse-new-unknown', '__proto__', 'GREENHOUSE']) {
      await expect(
        sql`insert into content.scroll_production_runs (id,topic,policy_version,target_revision,scope_generation,state,claims_run_id,writer_run_id) values (${randomUUID()},${topic},'CI-unknown',1,1,'research',${randomUUID()},${randomUUID()})`.execute(
          database.db,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'scroll_production_runs_topic_check' });
    }
    expect(await database.db.selectFrom('content.scroll_production_runs').select('id').execute()).toHaveLength(0);
  });
  it('keeps normal fixture-generated lookalikes unknown despite model-kind provenance and a matching explanation ID', async () => {
    const p = setup((n) => answer(n === 1 ? selection : draft()));
    const result = await p.produce()('greenhouse', false, signal());
    expect(result.outcome).toBe('published');
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toHaveLength(0);
    expect(
      await database.db.selectFrom('content.discovery_revisions').select('facets').executeTakeFirstOrThrow(),
    ).toEqual({ facets: [] });
  });
  it.each([
    'no_job',
    'not_published',
    'foreign_asset',
    'wrong_writer_run',
    'wrong_prompt_version',
    'previous_prompt_version',
    'previous_native_prompt_version',
    'wrong_document_version',
    'wrong_provenance_version',
    'foreign_provenance_run',
    'foreign_receipt',
    'fixture_provenance',
    'foreign_attempt',
    'foreign_model',
    'wrong_job_version',
    'previous_job_version',
    'previous_native_job_version',
    'previous_schema_job_version',
    'incomplete',
    'mismatched_revision',
    'no_baseline',
    'conflicting_topic',
    'withdrawn',
  ])('leaves attribution unknown for %s authority (CI fault injection after job publication)', async (fault) => {
    // The test-only trigger runs in the REAL publication transaction before the private hook.
    // It is deliberately corrupt fixture state, never a migration or available runtime capability.
    await sql`create function content.ci_publication_fault() returns trigger language plpgsql as $$
      begin
        case tg_argv[0]
          when 'no_job' then delete from content.scroll_production_runs where id=new.id;
          when 'not_published' then update content.scroll_production_runs set state='writer',asset_id=null,asset_revision=null,completed_at=null where id=new.id;
          when 'foreign_asset' then update content.scroll_production_runs set asset_id=gen_random_uuid() where id=new.id;
          when 'wrong_writer_run' then update content.scroll_production_runs set writer_run_id=gen_random_uuid() where id=new.id;
          when 'wrong_prompt_version' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,promptVersion}','"scroll-writer.foreign"') where asset_id=new.asset_id;
          when 'previous_prompt_version' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,promptVersion}','"scroll-writer.v4"') where asset_id=new.asset_id;
          when 'previous_native_prompt_version' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,promptVersion}','"scroll-writer.v5"') where asset_id=new.asset_id;
          when 'wrong_document_version' then update content.asset_revisions set document_version='scroll-document.foreign' where asset_id=new.asset_id;
          when 'wrong_provenance_version' then update content.asset_provenance set provenance_version='scroll-provenance.foreign' where asset_id=new.asset_id;
          when 'foreign_provenance_run' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,runId}',to_jsonb(gen_random_uuid()::text)) where asset_id=new.asset_id;
          when 'foreign_receipt' then update content.scroll_production_runs set outcomes=jsonb_set(outcomes,'{1,attemptId}',to_jsonb(gen_random_uuid()::text)) where id=new.id;
          when 'fixture_provenance' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production}','{"kind":"fixture","label":"CI fixture authority must stay unknown"}') where asset_id=new.asset_id;
          when 'foreign_attempt' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,attemptIds}',jsonb_build_array(gen_random_uuid()::text)) where asset_id=new.asset_id;
          when 'foreign_model' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,model}','"foreign-model"') where asset_id=new.asset_id;
          when 'wrong_job_version' then update content.scroll_production_runs set policy_version='scroll-production.foreign' where id=new.id;
          when 'previous_job_version' then update content.scroll_production_runs set policy_version='scroll-production.v5' where id=new.id;
          when 'previous_native_job_version' then update content.scroll_production_runs set policy_version='scroll-production.v6' where id=new.id;
          when 'previous_schema_job_version' then update content.scroll_production_runs set policy_version='scroll-production.v7' where id=new.id;
          when 'incomplete' then update content.scroll_production_runs set writer_output=null where id=new.id;
          when 'mismatched_revision' then update content.scroll_production_runs set target_revision=target_revision+1 where id=new.id;
          when 'no_baseline' then delete from content.discovery_revisions where asset_id=new.asset_id;
          when 'conflicting_topic' then insert into content.encounter_topics values(new.asset_id,new.asset_revision,'ci.foreign-topic','primary',1);
          when 'withdrawn' then update content.assets set status='withdrawn' where id=new.asset_id;
          else raise exception 'CI_UNKNOWN_FAULT';
        end case;
        return new;
      end $$`.execute(database.db);
    await sql`create trigger ci_publication_fault after update of state on content.scroll_production_runs for each row when (new.state='published' and old.state<>'published') execute function content.ci_publication_fault(${sql.lit(fault)})`.execute(
      database.db,
    );
    const p = setup((n) => answer(n === 1 ? selection : draft()), true);
    await p.produce()('greenhouse', false, signal());
    expect(p.model.calls).toHaveLength(2);
    expect(
      await database.db
        .selectFrom('content.encounter_topics')
        .select('topic_id')
        .where('topic_id', '=', TOPICS.greenhouse.topicId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database.db
        .selectFrom('content.discovery_revisions')
        .select('asset_id')
        .where('attribution_version', '=', 'published-scroll-brief-taxonomy.v1')
        .execute(),
    ).toHaveLength(0);
  });
  it('cannot publish or attribute when the same-scope writer closure does not succeed', async () => {
    const p = setup((n) => answer(n === 1 ? selection : draft()), true);
    let closes = 0;
    const denied: ProductionReasoningHarness = {
      proposeProduction: (input, abort) => p.harness.proposeProduction(input, abort),
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) =>
        ++closes === 1 ? p.harness.closeProductionRun(scope, run) : Promise.resolve('not_open'),
    };
    expect((await p.produce(denied)('greenhouse', false, signal())).outcome).toBe('in_progress');
    expect(p.model.calls).toHaveLength(2);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toHaveLength(0);
  });
  it('rolls back closure/publication if topic projection fails, then resumes the same paid writer without resend', async () => {
    await sql`create function content.ci_fail_topic() returns trigger language plpgsql as $$ begin raise exception 'CI_TOPIC_PROJECTION_FAILURE'; end $$`.execute(
      database.db,
    );
    await sql`create trigger ci_fail_topic before insert on content.encounter_topics for each row execute function content.ci_fail_topic()`.execute(
      database.db,
    );
    const p = setup((n) => answer(n === 1 ? selection : draft()), true);
    await expect(p.produce()('greenhouse', false, signal())).rejects.toThrow('CI_TOPIC_PROJECTION_FAILURE');
    expect(p.model.calls).toHaveLength(2);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
    expect(
      await database.db.selectFrom('content.scroll_production_runs').select('state').executeTakeFirstOrThrow(),
    ).toEqual({ state: 'writer' });
    expect(
      await database.db
        .selectFrom('reasoning.production_runs')
        .select('state')
        .where('role_id', '=', 'content.scroll-writer')
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'admitted' });
    await sql`drop trigger ci_fail_topic on content.encounter_topics`.execute(database.db);
    expect((await p.produce()('greenhouse', false, signal(), true)).outcome).toBe('published');
    expect(p.model.calls).toHaveLength(2);
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([
      { topic_id: TOPICS.greenhouse.topicId },
    ]);
  });
  it('publishes at the four-request maximum with one foreign-candidate and one semantic writer repair', async () => {
    const badSelection = { candidateIds: [...selection.candidateIds.slice(0, 3), `q-${'0'.repeat(48)}`] };
    const badWriter = draft();
    badWriter.bindings = [];
    const p = setup((n) => answer(n === 1 ? badSelection : n === 2 ? selection : n === 3 ? badWriter : draft()));
    const first = await p.produce()('greenhouse', false, signal());
    expect(first).toMatchObject({ outcome: 'published', requestBound: 4 });
    expect(p.model.calls).toHaveLength(4);
    const receipts = first.attempts?.filter((item) => item.role !== 'checks') ?? [];
    expect(receipts.map((item) => item.role)).toEqual(['claims', 'writer']);
    for (const receipt of receipts) {
      expect(receipt.attempts?.map((attempt) => attempt.step)).toEqual(['primary', 'repair']);
      expect(receipt.inputTokens).toBe(80);
      expect(receipt.outputTokens).toBe(24);
    }
    expect(receipts.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0)).toBe(160);
    expect(receipts.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0)).toBe(48);
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({
      production: {
        attemptIds: receipts.find((item) => item.role === 'writer')?.attempts?.map((attempt) => attempt.attemptId),
      },
    });
    expect(await p.produce()('greenhouse', false, signal(), true)).toEqual(first);
    expect(p.model.calls).toHaveLength(4);
  });
  it('preserves historical v1–v7 jobs, attempts and native request bytes while v8 creates distinct runs', async () => {
    // Historical SHAPES only: synthetic IDs/receipts, never imported real research or provider output.
    const old = [
      { policy: 'scroll-production.v1', topic: 'seasons', counts: [1, 2] },
      { policy: 'scroll-production.v2', topic: 'seasons', counts: [2, 0] },
      { policy: 'scroll-production.v3', topic: 'seasons', counts: [1, 2] },
      { policy: 'scroll-production.v3', topic: 'greenhouse', counts: [1, 2] },
      { policy: 'scroll-production.v4', topic: 'greenhouse', counts: [1, 2] },
      { policy: 'scroll-production.v5', topic: 'greenhouse', counts: [2, 2] },
      { policy: 'scroll-production.v6', topic: 'greenhouse', counts: [1, 2] },
      { policy: 'scroll-production.v7', topic: 'greenhouse', counts: [1, 2] },
    ].map((shape) => ({ ...shape, id: randomUUID(), claims: randomUUID(), writer: randomUUID() }));
    for (const job of old) {
      await sql`insert into content.scroll_production_runs (id,topic,policy_version,target_revision,scope_generation,state,claims_run_id,writer_run_id,outcomes,completed_at) values (${job.id},${job.topic},${job.policy},1,1,'rejected',${job.claims},${job.writer},'[ {"role":"checks","kind":"rejected","code":"ci_prior_invalid_output"} ]'::jsonb,now())`.execute(
        database.db,
      );
      for (const [index, role] of ['claims', 'writer'].entries()) {
        const count = job.counts[index] ?? 0;
        if (count === 0) continue;
        const id = role === 'claims' ? job.claims : job.writer;
        const version =
          job.policy === 'scroll-production.v1'
            ? job.policy
            : role === 'writer'
              ? job.policy === 'scroll-production.v7'
                ? 'scroll-writer.v6'
                : job.policy === 'scroll-production.v6'
                  ? 'scroll-writer.v5'
                  : job.policy === 'scroll-production.v5'
                    ? 'scroll-writer.v4'
                    : job.policy === 'scroll-production.v4'
                      ? 'scroll-writer.v3'
                      : 'scroll-writer.v2'
              : job.policy === 'scroll-production.v7'
                ? 'scroll-claims.v4'
                : job.policy === 'scroll-production.v6'
                  ? 'scroll-claims.v3'
                  : job.policy === 'scroll-production.v2'
                    ? 'scroll-claims.v1'
                    : 'scroll-claims.v2';
        await sql`insert into reasoning.production_runs (scope_id,id,owner_module,purpose,generation,role_id,role_version,policy_version,provider,model,state,closed_at) values ('scroll-supply',${id},'content',${`scroll-${role}`},1,${`content.scroll-${role}`},${version},${job.policy},'fixture','historical-CI-fixture','failed',now())`.execute(
          database.db,
        );
        for (let step = 0; step < count; step += 1) {
          const attemptId = randomUUID();
          // Frozen authored native wire shapes, never a reconstruction of a real failed answer.
          const hp = job.policy === 'scroll-production.v7' ? 'hp4-tool-schema' : 'hp3-tool-object';
          const native = ['scroll-production.v6', 'scroll-production.v7'].includes(job.policy);
          const body = Buffer.from(
            JSON.stringify({
              model: 'MiniMax-M3',
              max_tokens: role === 'claims' ? 4000 : 12000,
              system: `Historical CI fixture ${version}, ${hp}, ${step === 0 ? 'primary' : 'repair'}`,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Historical authored CI context only.' }] }],
              thinking: { type: 'disabled' },
              tools: [
                {
                  name: 'submit_output',
                  description:
                    job.policy === 'scroll-production.v7'
                      ? 'Submit the complete answer object as data matching the advisory input shape. This tool executes no action.'
                      : 'Submit the complete answer object as data. This tool executes no action.',
                  input_schema:
                    job.policy === 'scroll-production.v7'
                      ? deriveNativeInputSchema(
                          (role === 'claims'
                            ? claimsRole([page])
                            : writerRole(
                                generatedProvenance({
                                  topic: job.topic as ScrollTopic,
                                  runId: id,
                                  attemptIds: [attemptId],
                                  model: 'historical-CI-fixture',
                                  claims,
                                  pages: [page],
                                }),
                                false,
                              )
                          ).outputSchema,
                        )
                      : { type: 'object' },
                },
              ],
              tool_choice: { type: 'auto' },
            }),
          );
          const digest = createHash('sha256').update(body).digest('hex');
          await sql`insert into reasoning.production_attempts (scope_id,id,run_id,step,provider,model,role_id,role_version,prompt_version,request_hash,state,dispatch_id,dispatched_at,settled_at,outcome_code) values ('scroll-supply',${attemptId},${id},${step === 0 ? 'primary' : 'repair'},'fixture','historical-CI-fixture',${`content.scroll-${role}`},${version},${native ? hp : null},${native ? digest : 'f'.repeat(64)},'failed',${randomUUID()},now(),now(),'CI_HISTORICAL_REFUSAL')`.execute(
            database.db,
          );
          if (native)
            await database.db
              .insertInto('reasoning.production_requests')
              .values({
                scope_id: 'scroll-supply',
                attempt_id: attemptId,
                body,
                body_sha256: digest,
                erasure_class: 'nonpersonal_production',
                expires_at: new Date(Date.now() + 3600000),
              })
              .execute();
        }
      }
    }
    const ids = old.flatMap((job) => [job.claims, job.writer]);
    const previousBytes = async () => ({
      jobs: (
        await sql<{
          bytes: string;
        }>`select row_to_json(r)::text as bytes from content.scroll_production_runs r where policy_version in ('scroll-production.v1','scroll-production.v2','scroll-production.v3','scroll-production.v4','scroll-production.v5','scroll-production.v6','scroll-production.v7') order by id`.execute(
          database.db,
        )
      ).rows,
      requests: (
        await sql<{
          bytes: string;
        }>`select row_to_json(r)::text as bytes from reasoning.production_requests r join reasoning.production_attempts a on a.id=r.attempt_id where a.run_id=any(${ids}::uuid[]) order by r.attempt_id`.execute(
          database.db,
        )
      ).rows,
      runs: (
        await sql<{
          bytes: string;
        }>`select row_to_json(r)::text as bytes from reasoning.production_runs r where id=any(${ids}::uuid[]) order by id`.execute(
          database.db,
        )
      ).rows,
      attempts: (
        await sql<{
          bytes: string;
        }>`select row_to_json(r)::text as bytes from reasoning.production_attempts r where run_id=any(${ids}::uuid[]) order by id`.execute(
          database.db,
        )
      ).rows,
    });
    const before = await previousBytes();
    expect(before.jobs).toHaveLength(8);
    expect(before.attempts).toHaveLength(24);
    expect(before.requests).toHaveLength(6);
    const v7 = old.find((job) => job.policy === 'scroll-production.v7');
    const v7RunIds = new Set<string | undefined>([v7?.claims, v7?.writer]);
    expect(
      before.jobs.filter(
        (row) => (JSON.parse(row.bytes) as { policy_version: string }).policy_version !== 'scroll-production.v7',
      ),
    ).toHaveLength(7);
    expect(
      before.attempts.filter((row) => !v7RunIds.has((JSON.parse(row.bytes) as { run_id: string }).run_id)),
    ).toHaveLength(21);
    const v6 = old.find((job) => job.policy === 'scroll-production.v6');
    const v6RunIds = new Set<string | undefined>([v6?.claims, v6?.writer]);
    const v6AttemptIds = new Set(
      before.attempts
        .filter((row) => v6RunIds.has((JSON.parse(row.bytes) as { run_id: string }).run_id))
        .map((row) => (JSON.parse(row.bytes) as { id: string }).id),
    );
    expect(
      before.requests.filter((row) => v6AttemptIds.has((JSON.parse(row.bytes) as { attempt_id: string }).attempt_id)),
    ).toHaveLength(3);
    const legacyJobs = before.jobs.filter(
      (row) =>
        (JSON.parse(row.bytes) as { policy_version: string }).policy_version !== 'scroll-production.v6' &&
        (JSON.parse(row.bytes) as { policy_version: string }).policy_version !== 'scroll-production.v7',
    );
    const legacyAttempts = before.attempts.filter(
      (row) =>
        !v6RunIds.has((JSON.parse(row.bytes) as { run_id: string }).run_id) &&
        !v7RunIds.has((JSON.parse(row.bytes) as { run_id: string }).run_id),
    );
    expect(legacyJobs).toHaveLength(6);
    expect(legacyAttempts).toHaveLength(18);
    const p = setup((n) => answer(n === 1 ? selection : draft()));
    const result = await p.produce()('greenhouse', false, signal());
    expect(result.outcome).toBe('published');
    expect(old.map(({ id }) => id)).not.toContain(result.runId);
    expect(await previousBytes()).toEqual(before);
    const current = await database.db
      .selectFrom('content.scroll_production_runs')
      .select(['policy_version', 'claims_run_id', 'writer_run_id'])
      .where('id', '=', result.runId ?? '')
      .executeTakeFirstOrThrow();
    expect(current.policy_version).toBe('scroll-production.v8');
    expect(ids).not.toContain(current.claims_run_id);
    expect(ids).not.toContain(current.writer_run_id);
    expect(p.model.calls[0]?.request.system).toContain('version scroll-claims.v4,');
    expect(p.model.calls[1]?.request.system).toContain('version scroll-writer.v6,');
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', result.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({ production: { promptVersion: 'scroll-writer.v6' } });
    expect(await p.produce()('greenhouse', false, signal(), true)).toEqual(result);
    expect(p.model.calls).toHaveLength(2);
    expect(await previousBytes()).toEqual(before);
  });
  it('repairs a lone span object once with schema-declared field paths, without loosening the canonical array contract', async () => {
    const bad = JSON.parse(JSON.stringify(draft())) as { sections: { blocks: { data: { spans: unknown } }[] }[] };
    const paragraph = bad.sections[0]?.blocks[0];
    if (!paragraph) throw new Error('CI_PARAGRAPH_MISSING');
    paragraph.data.spans = { text: 'An authored malformed shape, not a model output.' };
    const p = setup((n) => answer(n === 1 ? selection : n === 2 ? bad : draft()));
    expect((await p.produce()('greenhouse', false, signal())).outcome).toBe('published');
    expect(p.model.calls).toHaveLength(3);
    expect(p.model.calls[2]?.request.system).toContain('sections[0].blocks[0].data.spans');
    expect(p.model.calls[2]?.request.system).toContain('expected array');
    const failed = await database.db
      .selectFrom('reasoning.production_attempts')
      .select('output_issues')
      .where('role_id', '=', 'content.scroll-writer')
      .where('step', '=', 'primary')
      .executeTakeFirstOrThrow();
    expect(failed.output_issues).toMatchObject({
      issues: [{ code: 'invalid_type', path: 'sections[0].blocks[0].data.spans', detail: 'expected array' }],
    });
  });
  it('repairs an actual writer semantic refusal with fixed safe feedback and never retains the failed draft', async () => {
    const bad = draft();
    const paragraph = bad.sections[0]?.blocks.find((block) => block.type === 'paragraph');
    if (paragraph?.type !== 'paragraph') throw new Error('CI_PARAGRAPH_MISSING');
    paragraph.data.spans = [{ text: passage }];
    const p = setup((n) => answer(n === 1 ? selection : n === 2 ? bad : draft()));
    const result = await p.produce()('greenhouse', false, signal());
    expect(result).toMatchObject({ outcome: 'published', requestBound: 4 });
    expect(p.model.calls).toHaveLength(3);
    const repair = p.model.calls[2]?.request.system ?? '';
    expect(repair).toContain(`copied_passage (${REPAIR_HINTS.copied_passage})`);
    expect(repair).toContain('sections[0].blocks[0].?');
    expect(repair).not.toContain(passage);
    expect(repair).not.toContain(page.url);
    const failed = await database.db
      .selectFrom('reasoning.production_attempts')
      .select(['output', 'output_issues', 'outcome_code'])
      .where('role_id', '=', 'content.scroll-writer')
      .where('step', '=', 'primary')
      .executeTakeFirstOrThrow();
    expect(failed).toMatchObject({
      output: null,
      outcome_code: 'OUTPUT_SCHEMA_MISMATCH',
      output_issues: {
        reason: 'OUTPUT_SCHEMA_MISMATCH',
        issues: [{ path: 'sections[0].blocks[0].?', code: 'copied_passage', detail: REPAIR_HINTS.copied_passage }],
      },
    });
    expect(JSON.stringify(failed)).not.toContain(passage);
    expect(await p.produce()('greenhouse', false, signal(), true)).toEqual(result);
    expect(p.model.calls).toHaveLength(3);
  });
  it('still refuses reference grammar as invalid JSON through only one writer repair', async () => {
    const p = setup((n) =>
      n === 1 ? answer(selection) : { kind: 'success', text: '{"draftVersion":"scroll-draft.v1","title":4–240 chars}' },
    );
    const result = await p.produce()('greenhouse', false, signal());
    expect(result.outcome).toBe('rejected');
    expect(p.model.calls).toHaveLength(3);
    expect(result.attempts?.find((item) => item.role === 'writer')).toMatchObject({
      kind: 'invalid_output',
      code: 'OUTPUT_NOT_ONE_JSON_OBJECT',
    });
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
    expect((await p.produce()('greenhouse', false, signal(), true)).outcome).toBe('rejected');
    expect(p.model.calls).toHaveLength(3);
  });
  it('includes semantic refusal in the single writer repair and records terminal rejection without another retry', async () => {
    const p = setup((n) =>
      answer(
        n === 1
          ? selection
          : {
              draftVersion: 'scroll-draft.v1',
              title: 'Invalid draft',
              dek: 'An invalid scripted fixture.',
              sections: [],
              bindings: [],
            },
      ),
    );
    const first = await p.produce()('seasons', false, signal());
    expect(first.outcome).toBe('rejected');
    expect(p.model.calls).toHaveLength(3);
    expect(await p.produce()('seasons', false, signal(), true)).toMatchObject({
      outcome: 'rejected',
      runId: first.runId,
    });
    expect(p.model.calls).toHaveLength(3);
    const stored = await sql<{
      state: string;
      outcomes: { kind: string }[];
    }>`select state,outcomes from content.scroll_production_runs where id=${first.runId}`.execute(database.db);
    expect(stored.rows[0]?.state).toBe('rejected');
    expect(stored.rows[0]?.outcomes.some((r) => r.kind === 'invalid_output')).toBe(true);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
  });
  it.each(['content.scroll-claims', 'content.scroll-writer'])(
    'resumes frozen same-run %s output after a crash without a new paid attempt',
    async (role) => {
      const p = setup((n) => answer(n === 1 ? selection : draft()));
      let crashed = false;
      const crashing: ProductionReasoningHarness = {
        readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
        closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
        async proposeProduction(input, abort) {
          const output = await p.harness.proposeProduction(input, abort);
          if (input.role.id === role && !crashed) {
            crashed = true;
            throw new Error('CI_CRASH_AFTER_PROVIDER_SETTLEMENT');
          }
          return output;
        },
      };
      await expect(p.produce(crashing)('greenhouse', false, signal())).rejects.toThrow(
        'CI_CRASH_AFTER_PROVIDER_SETTLEMENT',
      );
      const raw = await database.db
        .selectFrom('reasoning.production_attempts')
        .select('output')
        .where('role_id', '=', 'content.scroll-claims')
        .executeTakeFirstOrThrow();
      expect(raw.output).toEqual({ v: 1, text: JSON.stringify(selection) });
      const storedSelection: unknown = JSON.parse((raw.output as { text: string }).text);
      expect(claimsRole([page]).outputSchema.safeParse(storedSelection)).toMatchObject({ success: true, data: claims });
      expect(claimsRole([page]).outputSchema.safeParse(claims).success).toBe(false);
      expect((await p.produce()('greenhouse', false, signal())).outcome).toBe('in_progress');
      const resumed = await p.produce()('greenhouse', false, signal(), true);
      expect(resumed.outcome).toBe('published');
      expect(p.model.calls).toHaveLength(2);
    },
  );
  it('rejects insufficient frozen candidates before any provider admission', async () => {
    const scarce = extractResearch(
      `<html><main><p>${passage} ${passage}</p></main></html>`,
      page.url,
      page.retrievedAt,
    );
    const p = setup(() => ({ kind: 'malformed' }));
    const result = await p.produce(p.harness, () => Promise.resolve(scarce))('greenhouse', false, signal());
    expect(result.outcome).toBe('rejected');
    expect(result.codes).toContain('candidate_pool_insufficient');
    expect(p.model.calls).toHaveLength(0);
    expect(await database.db.selectFrom('reasoning.production_attempts').select('id').execute()).toHaveLength(0);
  });
  it.each(['claims', 'research'] as const)('revalidates stored %s integrity before writer resume', async (changed) => {
    const p = setup((n) => answer(n === 1 ? selection : draft()));
    const stopBeforeWriter: ProductionReasoningHarness = {
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      async proposeProduction(input, abort) {
        if (input.role.id === 'content.scroll-writer') throw new Error('CI_STOP_BEFORE_WRITER');
        return p.harness.proposeProduction(input, abort);
      },
    };
    await expect(p.produce(stopBeforeWriter)('greenhouse', false, signal())).rejects.toThrow('CI_STOP_BEFORE_WRITER');
    if (changed === 'claims')
      await sql`update content.scroll_production_runs set claims=jsonb_set(claims,'{claims,0,quote}','"tampered CI quote"'::jsonb) where topic='greenhouse' and policy_version='scroll-production.v8'`.execute(
        database.db,
      );
    else
      await sql`update content.scroll_production_runs set research=jsonb_set(research,'{0,passages,0,text}','"tampered CI passage"'::jsonb) where topic='greenhouse' and policy_version='scroll-production.v8'`.execute(
        database.db,
      );
    const resumed = await p.produce()('greenhouse', false, signal(), true);
    expect(resumed.outcome).toBe('rejected');
    expect(resumed.codes).toContain(
      changed === 'claims' ? 'candidate_stored_claim_integrity' : 'candidate_research_integrity',
    );
    expect(p.model.calls).toHaveLength(1);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
  });
  it.each(['success', 'refusal'] as const)(
    'keeps an advanced writer alive when concurrent stale research finishes with %s',
    async (outcome) => {
      const researchEntered = gate();
      const researchRelease = gate();
      const writerEntered = gate();
      const writerRelease = gate<FixtureScenario>();
      const p = setup((n) => {
        if (n === 1) return answer(selection);
        writerEntered.open();
        return { kind: 'hold', until: writerRelease.promise };
      });
      const stale = p.produce(p.harness, async () => {
        researchEntered.open();
        await researchRelease.promise;
        if (outcome === 'refusal') throw new ResearchRefusal('network_failed');
        return page;
      })('greenhouse', false, signal());
      await researchEntered.promise;
      const active = p.produce()('greenhouse', false, signal(), true);
      try {
        await writerEntered.promise;
        researchRelease.open();
        const replay = await stale;
        expect(replay.outcome).toBe('in_progress');
        const current = await sql<{
          state: string;
          outcomes: { role: string; kind: string }[];
        }>`select state,outcomes from content.scroll_production_runs where id=${replay.runId}`.execute(database.db);
        expect(current.rows[0]?.state).toBe('writer');
        expect(current.rows[0]?.outcomes.map((receipt) => receipt.role)).toEqual(['claims']);
        expect(p.model.calls).toHaveLength(2);
        const attempts = await database.db
          .selectFrom('reasoning.production_attempts')
          .select(['state', 'step'])
          .orderBy('reserved_at')
          .execute();
        expect(attempts.map((attempt) => attempt.state)).toEqual(['succeeded', 'dispatched']);
        writerRelease.open(answer(draft()));
        expect((await active).outcome).toBe('published');
        expect(p.model.calls).toHaveLength(2);
      } finally {
        researchRelease.open();
        writerRelease.open(answer(draft()));
        await Promise.allSettled([stale, active]);
      }
    },
  );
  it('replays the current job when a stale claims delivery finds its run closed during another writer', async () => {
    const claimsEntered = gate();
    const claimsRelease = gate();
    const writerEntered = gate();
    const writerRelease = gate<FixtureScenario>();
    const p = setup((n) => {
      if (n === 1) return answer(selection);
      writerEntered.open();
      return { kind: 'hold', until: writerRelease.promise };
    });
    const delayed: ProductionReasoningHarness = {
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      async proposeProduction(input, abort) {
        if (input.role.id === 'content.scroll-claims') {
          claimsEntered.open();
          await claimsRelease.promise;
        }
        return p.harness.proposeProduction(input, abort);
      },
    };
    const stale = p.produce(delayed)('greenhouse', false, signal());
    await claimsEntered.promise;
    const active = p.produce()('greenhouse', false, signal(), true);
    try {
      await writerEntered.promise;
      claimsRelease.open();
      const replay = await stale;
      expect(replay.outcome).toBe('in_progress');
      const current = await sql<{
        state: string;
      }>`select state from content.scroll_production_runs where id=${replay.runId}`.execute(database.db);
      expect(current.rows[0]?.state).toBe('writer');
      expect(p.model.calls).toHaveLength(2);
      writerRelease.open(answer(draft()));
      expect((await active).outcome).toBe('published');
      expect(p.model.calls).toHaveLength(2);
    } finally {
      claimsRelease.open();
      writerRelease.open(answer(draft()));
      await Promise.allSettled([stale, active]);
    }
  });
  it('halts an unknown attempt and never resends it even with explicit resume', async () => {
    const p = setup(() => ({ kind: 'timeout_after_dispatch' }));
    expect((await p.produce()('seasons', false, signal())).outcome).toBe('unknown');
    expect((await p.produce()('seasons', false, signal(), true)).outcome).toBe('unknown');
    expect(p.model.calls).toHaveLength(1);
  });
  it('dry run reports the bound and performs no database/provider effects', async () => {
    const p = setup(() => ({ kind: 'malformed' }));
    expect(await p.produce()('greenhouse', true, signal())).toEqual({ outcome: 'dry_run', requestBound: 4 });
    expect(p.model.calls).toHaveLength(0);
    expect(
      (
        await sql<{ count: string }>`select count(*)::text as count from content.scroll_production_runs`.execute(
          database.db,
        )
      ).rows[0]?.count,
    ).toBe('0');
  });
});
