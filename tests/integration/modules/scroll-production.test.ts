import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  guardedModelPort,
  makeAttemptLedger,
  makeMiniMaxModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  reasoningOperatorFor,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  extractResearch,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

// Every source paragraph and every model answer below is an authored CI fixture about an invented
// lighthouse, never provider output and never product content.
const SOURCE = [
  'The Skerry lighthouse keeper winds the lamp clockwork every four hours through the long winter nights.',
  'A prism ring around the flame gathers the light into a single beam that sweeps across the water.',
  'Sailors count the seconds between flashes to learn which lighthouse they are approaching on the coast.',
  'Fog signals complement the beam, because light cannot cross a thick bank of fog for any useful distance.',
  'The tower stands twenty-one metres tall, which places the lamp high enough to clear distant waves.',
  'Today the clockwork has been replaced by a small motor, though the prisms are still the original glass.',
];
const page: ResearchPage = extractResearch(
  `<html><title>CI fixture</title><main>${SOURCE.map((text) => `<p>${text}</p>`).join('')}</main></html>`,
  'https://spaceplace.nasa.gov/seasons/en/',
  '2026-10-20T00:00:00.000Z',
);

/** Reader prose in other words than the source (no nine-word run in common), ~280 words in all. */
const PROSE = [
  'Ships need a way to know where the land begins long before they can see it. A tall tower with a bright lamp answers that need, and the clever part is how the lamp is shaped rather than how strong it is. Glass rings bend the glow into one narrow ribbon.',
  'Because the ribbon turns, a distant observer sees it only for a moment each rotation. Those regular flashes are not decoration. Each tower repeats its own rhythm, so a navigator who times the gaps can tell neighbouring towers apart on a dark coast.',
  'Someone had to keep that rotation going. In earlier times a keeper climbed the stairs on a fixed schedule to wind a weight-driven mechanism, and a missed visit meant a dark coast. Modern towers use a motor, yet the glass that shapes the beam is often the very same.',
  'Weather changes what a lamp can do. Thick fog scatters light in every direction, so the beam dissolves after a short distance, however clever its glass. That is why towers also carry sound signals, which travel through fog far better than any flash.',
  'Height matters as well as brightness. Raising the lamp pushes the horizon outward, so the beam can be seen from farther away before the curve of the sea hides the tower. A modest hill or a tall column both do the same job.',
  'Put together, these ideas describe a small system: a shaped beam, a signature rhythm, a dependable rotation and a backup for bad weather. Each part solves a different problem, and the whole is only as reliable as its weakest piece.',
];

function authored(overrides: { readonly drop?: string; readonly paragraph?: string } = {}) {
  const prose = PROSE.map((text, index) => (index === 1 && overrides.paragraph ? overrides.paragraph : text));
  return {
    title: 'How a lighthouse guides ships',
    dek: 'A shaped beam, a rhythm and a dependable rotation turn one lamp into a coastal signal.',
    blocks: [
      { type: 'heading', text: 'The beam' },
      { type: 'paragraph', cites: ['e1', 'e2'], text: prose[0] },
      { type: 'paragraph', cites: ['e2', 'e3'], text: prose[1] },
      { type: 'heading', text: 'The upkeep' },
      { type: 'paragraph', cites: ['e1', 'e6'], text: prose[2] },
      { type: 'paragraph', cites: ['e4'], text: prose[3] },
      {
        type: 'diagram',
        cites: ['e2', 'e3', 'e4'],
        title: 'A lighthouse in two conditions',
        layout: 'flow-lr',
        nodes: [
          { id: 'lamp', label: 'Lamp' },
          { id: 'prisms', label: 'Prism ring', kind: 'process' },
          { id: 'ship', label: 'Ship' },
        ],
        edges: [
          { id: 'glow', from: 'lamp', to: 'prisms', label: 'Glow' },
          { id: 'beam', from: 'prisms', to: 'ship', label: 'Beam' },
        ],
        frames: [
          {
            label: 'Clear night',
            description: 'The beam crosses open water and reaches the ship.',
            highlight: ['beam'],
          },
          {
            label: 'Thick fog',
            description: 'The beam fades early, so a sound signal must take over.',
            hide: ['beam'],
          },
        ],
      },
      { type: 'heading', text: 'Putting it together' },
      { type: 'paragraph', cites: ['e5'], text: prose[4] },
      { type: 'paragraph', cites: ['e3', 'e5'], text: prose[5] },
      {
        type: 'callout',
        cites: ['e4'],
        kind: 'limit',
        title: 'Where this stops',
        text: 'This picture ignores radio and satellite navigation, which now do most of the work.',
      },
    ].filter((block) => block.type !== overrides.drop),
  };
}
const answer = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });

describe('Scroll production (CI fixture + real PostgreSQL; no provider network)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('scroll_production');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  function setup(script: (sequence: number) => FixtureScenario | Promise<FixtureScenario>) {
    const fixture = fixtureModel(script, { label: 'scroll-production-CI-fixture' });
    // No transport is real: this stand-in identity lets the publication attribute its model.
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    return { fixture, ...wire(model) };
  }

  function wire(
    model: ReturnType<typeof guardedModelPort>,
    research: (url: string) => Promise<ResearchPage> = () => Promise.resolve(page),
  ) {
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
    const produce = makeProduceScroll({
      db: database.db,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope,
      harness,
      model: model.model,
      research,
    });
    return { model, harness, produce };
  }

  const rejectedRows = () =>
    database.db
      .selectFrom('reasoning.production_rejected_answers')
      .select(['attempt_id', 'reason', 'issues', 'answer_text', 'truncated'])
      .orderBy('recorded_at')
      .execute();

  it('publishes once from one writer call, keeps provenance private and does no further work on rerun', async () => {
    const p = setup(() => answer(authored()));
    const first = await p.produce('seasons', false, signal());
    expect(first).toMatchObject({ outcome: 'published', requestBound: 2, revision: 1 });
    expect(p.fixture.calls).toHaveLength(1);
    expect(await p.produce('seasons', false, signal())).toEqual(first);
    expect(p.fixture.calls).toHaveLength(1);

    const revision = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'explanation_unit_id', 'provenance_kind'])
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(revision.explanation_unit_id).toBe('legacy-cutroom-seasons-v5');
    expect(revision.provenance_kind).toBe('generated');
    for (const hidden of ['claims', 'sources', 'bindings', 'checks', 'production'])
      expect(revision.document).not.toHaveProperty(hidden);
    const document = revision.document as { sections: { heading: string | null; blocks: { type: string }[] }[] };
    expect(document.sections.map((section) => section.heading)).toEqual([
      'The beam',
      'The upkeep',
      'Putting it together',
    ]);
    expect(document.sections.flatMap((section) => section.blocks.map((block) => block.type))).toContain('diagram');

    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    const stored = provenance.provenance as { production: { model: string; attemptIds: string[] }; claims: unknown[] };
    expect(stored.production).toMatchObject({ model: 'MiniMax-M3.1-Flash', attemptIds: [expect.any(String)] });
    // Only the passages the Scroll cites become claims, each the exact source text.
    expect(stored.claims).toHaveLength(6);
    const job = await database.db
      .selectFrom('content.scroll_production_runs')
      .select(['state', 'claims', 'writer_output'])
      .where('topic', '=', 'seasons')
      .executeTakeFirstOrThrow();
    expect(job.state).toBe('published');
    expect(job.claims).toHaveLength(6);
    expect(job.writer_output).toMatchObject({ title: 'How a lighthouse guides ships' });
    expect(await rejectedRows()).toEqual([]);
  });

  it('sends fixed findings and the refused answer as delimited data for the one repair, then publishes the repaired answer', async () => {
    const copiedRun = 'Glass rings bend the glow into one narrow ribbon CANARYWORD';
    const p = setup((sequence) =>
      answer(sequence === 1 ? authored({ paragraph: `${PROSE[1]} ${SOURCE[1]} ${copiedRun}` }) : authored()),
    );
    const result = await p.produce('seasons', false, signal());
    expect(result).toMatchObject({ outcome: 'published' });
    expect(p.fixture.calls).toHaveLength(2);

    const primary = p.fixture.calls[0]?.request;
    const repair = p.fixture.calls[1]?.request;
    expect(primary?.user).not.toContain('<previous-answer>');
    expect(repair?.system).toContain('blocks[2]: copied_passage');
    expect(repair?.system).toContain('Write every sentence of this block again from scratch');
    // The refused answer travels as escaped, delimited data in the user text, never in the instructions.
    expect(repair?.system).toContain('repeated as data in the <previous-answer> block');
    expect(repair?.system).not.toContain('CANARYWORD');
    expect(repair?.user).toContain('<previous-answer>\n{"title":"How a lighthouse guides ships"');
    expect(repair?.user).toContain('CANARYWORD');

    const attempts = await database.db
      .selectFrom('reasoning.production_attempts')
      .select(['step', 'state', 'causation_attempt_id'])
      .orderBy('reserved_at')
      .execute();
    expect(attempts.map((attempt) => [attempt.step, attempt.state])).toEqual([
      ['primary', 'succeeded'],
      ['repair', 'succeeded'],
    ]);
    // The refused primary is kept for diagnosis, with the validator's own findings.
    const [kept] = await rejectedRows();
    expect(kept).toMatchObject({ reason: 'OUTPUT_SCHEMA_MISMATCH', truncated: false });
    expect(kept?.issues).toEqual([expect.objectContaining({ path: 'blocks[2]', code: 'copied_passage' })]);
    expect(kept?.answer_text).toContain('CANARYWORD');
  });

  it('rejects after the repair also fails, keeps both refused answers redacted and lists them for the operator', async () => {
    const key = 'sk-cp-FIXTUREfixtureFIXTUREfixture0000';
    const p = setup((sequence) =>
      sequence === 1
        ? { kind: 'success', text: `{"title": "${key}", "note": "https://leak.example/a?X-Amz-Signature=canary" ` }
        : answer(authored({ drop: 'diagram' })),
    );
    const result = await p.produce('seasons', false, signal());
    expect(result).toMatchObject({ outcome: 'rejected', codes: ['invalid_output'] });
    expect(p.fixture.calls).toHaveLength(2);

    const rows = await rejectedRows();
    expect(rows.map((row) => row.reason)).toEqual(['OUTPUT_NOT_ONE_JSON_OBJECT', 'OUTPUT_SCHEMA_MISMATCH']);
    // Redacted at the recording boundary: a key-shaped value and a credential-bearing query never reach the table.
    expect(rows[0]?.answer_text).not.toContain(key);
    expect(rows[0]?.answer_text).not.toContain('X-Amz-Signature');
    expect(rows[1]?.issues).toContainEqual(expect.objectContaining({ path: '(root)', code: 'format_required' }));

    const operator = reasoningOperatorFor(database.db, silent);
    const listed = await operator.listRejectedAnswers(10);
    expect(listed.map((entry) => entry.reason)).toEqual(['OUTPUT_SCHEMA_MISMATCH', 'OUTPUT_NOT_ONE_JSON_OBJECT']);
    expect(JSON.stringify(listed)).not.toContain('answerText');
    const shown = await operator.showRejectedAnswer(listed[1]?.attemptId ?? '');
    expect(shown).toMatchObject({ kind: 'found', record: { step: 'primary', roleId: 'content.scroll-writer' } });
    expect(await operator.showRejectedAnswer('not-a-uuid')).toMatchObject({ kind: 'invalid_request' });
  });

  it('bounds a kept answer at 64 KiB, expires it after thirty days and keeps no personal answer', async () => {
    const p = setup(() => ({ kind: 'success', text: `{"filler": "${'x'.repeat(100_000)}"}` }));
    await p.produce('seasons', false, signal());
    const [kept] = await rejectedRows();
    expect(kept?.truncated).toBe(true);
    expect(kept?.answer_text.length).toBeLessThanOrEqual(65_536);

    const operator = reasoningOperatorFor(database.db, silent);
    expect((await operator.listRejectedAnswers(10)).length).toBeGreaterThan(0);
    await sql`update reasoning.production_rejected_answers set expires_at = now() - interval '1 second', recorded_at = now() - interval '31 days'`.execute(
      database.db,
    );
    expect(await operator.listRejectedAnswers(10)).toEqual([]);
    expect(await operator.purgeExpired()).toBeGreaterThan(0);
    expect(await rejectedRows()).toEqual([]);

    // Only the production ledger can keep a refused answer: the personal ledger has no such operation.
    expect(makeAttemptLedger(database.db).recordRejectedAnswer).toBeUndefined();
  });

  it('refuses a truncated answer as truncated and gives its repair the same fixed findings', async () => {
    const p = setup(() => ({ kind: 'truncated', text: '{"title": "How a lighthouse' }));
    const result = await p.produce('seasons', false, signal());
    expect(result).toMatchObject({ outcome: 'rejected' });
    expect((await rejectedRows()).map((row) => row.reason)).toEqual(['OUTPUT_TRUNCATED', 'OUTPUT_TRUNCATED']);
    expect(p.fixture.calls[1]?.request.system).toContain('truncated');
  });

  it('halts an unknown attempt and never resends it, even with an explicit resume', async () => {
    const p = setup(() => ({ kind: 'gateway_timeout' }));
    expect(await p.produce('seasons', false, signal())).toMatchObject({ outcome: 'unknown' });
    expect(await p.produce('seasons', false, signal(), true)).toMatchObject({ outcome: 'unknown' });
    expect(p.fixture.calls).toHaveLength(1);
  });

  it('rejects research with too few passages before any model call', async () => {
    const thin = extractResearch(
      `<html><title>CI fixture</title><main>${[SOURCE.slice(0, 3).join(' '), SOURCE.slice(3).join(' ')]
        .map((text) => `<p>${text}</p>`)
        .join('')}</main></html>`,
      'https://spaceplace.nasa.gov/seasons/en/',
      '2026-10-20T00:00:00.000Z',
    );
    const fixture = fixtureModel(() => answer(authored()), { label: 'scroll-production-CI-fixture' });
    const p = wire(guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' }), () =>
      Promise.resolve(thin),
    );
    expect(await p.produce('seasons', false, signal())).toMatchObject({
      outcome: 'rejected',
      codes: ['evidence_insufficient'],
    });
    expect(fixture.calls).toHaveLength(0);
  });

  it('reports the bound on a dry run and does no database or provider work', async () => {
    const p = setup(() => answer(authored()));
    expect(await p.produce('seasons', true, signal())).toEqual({ outcome: 'dry_run', requestBound: 2 });
    expect(p.fixture.calls).toHaveLength(0);
    expect(await database.db.selectFrom('content.scroll_production_runs').select('id').execute()).toEqual([]);
  });

  describe('through the MiniMax-M3.1-Flash transport (authored HTTP, no network)', () => {
    function viaTransport(reply: (sequence: number, request: Record<string, unknown>) => unknown) {
      const calls: Record<string, unknown>[] = [];
      const transport = makeMiniMaxModelPort(
        {
          apiKey: 'sk-cp-FIXTUREfixtureFIXTUREfixture0000',
          model: 'MiniMax-M3.1-Flash',
          requestTimeoutMs: 1_000,
          quotaTimeoutMs: 1_000,
          quotaFloorPercent: 25,
          maxReplyBytes: 524_288,
          maxRequestBytes: 262_144,
        },
        (_url, init) => {
          calls.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>);
          return Promise.resolve(new Response(JSON.stringify(reply(calls.length, calls[calls.length - 1] ?? {}))));
        },
      );
      const model = guardedModelPort({
        ...transport,
        observeQuota: () =>
          Promise.resolve({
            verdict: 'not_applicable' as const,
            intervalRemainingPercent: null,
            weeklyRemainingPercent: null,
          }),
      });
      return { calls, ...wire(model) };
    }
    const message = (content: unknown[], model = 'MiniMax-M3.1-Flash') => ({
      id: 'msg_ci',
      type: 'message',
      model,
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 900, output_tokens: 700, output_tokens_details: { thinking_tokens: 300 } },
    });

    it('asks for adaptive thinking at the writer’s effort and parses plain JSON after a thinking block', async () => {
      const p = viaTransport(() =>
        message([
          { type: 'thinking', thinking: 'PRIVATE-THINKING-CANARY', signature: 'ci' },
          { type: 'text', text: JSON.stringify(authored()) },
        ]),
      );
      const result = await p.produce('seasons', false, signal());
      expect(result).toMatchObject({ outcome: 'published' });
      expect(p.calls[0]).toMatchObject({
        model: 'MiniMax-M3.1-Flash',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        max_tokens: 16_000,
      });
      expect(p.calls[0]).not.toHaveProperty('tools');
      const attempt = await database.db
        .selectFrom('reasoning.production_attempts')
        .select(['reasoning_tokens', 'output_tokens', 'model'])
        .executeTakeFirstOrThrow();
      expect(attempt).toMatchObject({ reasoning_tokens: 300, output_tokens: 700, model: 'MiniMax-M3.1-Flash' });
      expect(JSON.stringify(await rejectedRows())).not.toContain('PRIVATE-THINKING-CANARY');
    });

    it('refuses an answer served by another model, charges it and does not repair it', async () => {
      const p = viaTransport(() => message([{ type: 'text', text: JSON.stringify(authored()) }], 'MiniMax-M3'));
      expect(await p.produce('seasons', false, signal())).toMatchObject({ outcome: 'rejected', codes: ['failed'] });
      expect(p.calls).toHaveLength(1);
      const attempt = await database.db
        .selectFrom('reasoning.production_attempts')
        .select(['state', 'outcome_code', 'output_tokens'])
        .executeTakeFirstOrThrow();
      expect(attempt).toMatchObject({ state: 'failed', outcome_code: 'MODEL_MISMATCH', output_tokens: 700 });
    });

    it('keeps the bounded raw reply of an unreadable answer, thinking only', async () => {
      const p = viaTransport(() => message([{ type: 'thinking', thinking: 'ONLY-THINKING', signature: 'ci' }]));
      await p.produce('seasons', false, signal());
      const rows = await rejectedRows();
      expect(rows.map((row) => row.reason)).toEqual(['REPLY_NO_TEXT', 'REPLY_NO_TEXT']);
      expect(rows[0]?.answer_text).toContain('ONLY-THINKING');
    });
  });
});
