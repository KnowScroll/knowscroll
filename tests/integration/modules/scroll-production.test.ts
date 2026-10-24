import { randomUUID } from 'node:crypto';
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
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import {
  extractResearch,
  ResearchRefusal,
  type ResearchPage,
} from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import {
  explanationUnitFor,
  SCROLL_PRODUCTION_VERSION,
  TOPICS,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import {
  WRITER_PROMPT_VERSION,
  writerFormatOf,
} from '../../../packages/backend/src/modules/content/production/writer.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { FIXTURE_PROSE, FIXTURE_SOURCE, fixtureAuthored, fixtureResearchFor } from '../support/generated-scroll.js';
import { fixtureModel, fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

const SOURCE = FIXTURE_SOURCE;
const PROSE = FIXTURE_PROSE;
const authored = (overrides: { readonly drop?: string; readonly paragraph?: string } = {}) =>
  fixtureAuthored('diagram', overrides);
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

  function setup(script: (sequence: number) => FixtureScenario | Promise<FixtureScenario>, minimaxIdentity = true) {
    const fixture = fixtureModel(script, { label: 'scroll-production-CI-fixture' });
    // No transport is real: the MiniMax stand-in identity lets the publication attribute its model.
    const model = guardedModelPort(
      minimaxIdentity ? { ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' } : fixture,
    );
    return { fixture, ...wire(model) };
  }

  function wire(
    model: ReturnType<typeof guardedModelPort>,
    research: (url: string) => Promise<ResearchPage> = (url) => Promise.resolve(fixtureResearchFor(url)),
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
    /** A producer over this model, optionally with another harness or research function. */
    const producerWith = (
      overrides: { readonly harness?: ProductionReasoningHarness; readonly research?: typeof research } = {},
    ) =>
      makeProduceScroll({
        db: database.db,
        authority: { scopeId: 'scroll-supply', generation: 1 },
        withScope,
        harness: overrides.harness ?? harness,
        model: model.model,
        research: overrides.research ?? research,
      });
    return { model, harness, produce: producerWith(), producerWith };
  }

  const rejectedRows = () =>
    database.db
      .selectFrom('reasoning.production_rejected_answers')
      .select(['attempt_id', 'reason', 'issues', 'answer_kind', 'answer_text', 'truncated'])
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
    expect(repair?.system).toContain('Rewrite only the sentences of this block that contain one');
    // The refused answer travels as escaped, delimited data in the user text, never in the instructions.
    expect(repair?.system).toContain('repeated as data in the <previous-answer> block');
    expect(repair?.system).not.toContain('CANARYWORD');
    expect(repair?.user).toContain('<previous-answer>\n{"title":"How a lighthouse guides ships"');
    expect(repair?.user).toContain('CANARYWORD');
    // The copied words themselves (public research text) travel as delimited data, not as an instruction.
    expect(repair?.system).toContain('the <repair-notes> block there holds facts about it');
    expect(repair?.system).not.toContain('a prism ring around');
    expect(repair?.user).toContain(
      '<repair-notes>\nEach line names the words of your text that also appear in the source passages',
    );
    expect(repair?.user).toContain(
      'blocks[2] copies: "a prism ring around the flame gathers the light into a single beam that sweeps across the water"',
    );
    expect(primary?.user).not.toContain('<repair-notes>');

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
    expect(kept).toMatchObject({ reason: 'OUTPUT_SCHEMA_MISMATCH', answer_kind: 'answer', truncated: false });
    expect(kept?.issues).toEqual([expect.objectContaining({ path: 'blocks[2]', code: 'copied_passage' })]);
    expect(kept?.answer_text).toContain('CANARYWORD');
  });

  it('sends no repair notes for a finding that is not about copying', async () => {
    const p = setup((sequence) => answer(sequence === 1 ? authored({ drop: 'diagram' }) : authored()));
    expect((await p.produce('seasons', false, signal())).outcome).toBe('published');
    const repair = p.fixture.calls[1]?.request;
    expect(repair?.user).toContain('<previous-answer>');
    expect(repair?.user).not.toContain('<repair-notes>');
    expect(repair?.system).not.toContain('repair-notes');
  });

  it('publishes a diagram whose layout and node kind are not allowed values, and records the defaults in the provenance', async () => {
    const base = authored();
    const styled = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.type === 'diagram'
          ? {
              ...block,
              layout: 'horizontal',
              nodes: block.nodes.map((node, index) => (index === 1 ? { ...node, kind: 'building' } : node)),
            }
          : block,
      ),
    };
    const p = setup(() => answer(styled));
    const result = await p.produce('seasons', false, signal());
    expect(result.outcome).toBe('published');
    expect(p.fixture.calls).toHaveLength(1);
    const stored = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', result.assetId ?? '')
      .executeTakeFirstOrThrow();
    const checks = (stored.provenance as { checks: { name: string; reasonCodes: string[] }[] }).checks;
    expect(checks.find((check) => check.name === 'authoring-normalisation')?.reasonCodes).toEqual([
      'diagram_layout_defaulted_block_6',
      'diagram_node_kind_defaulted_block_6',
    ]);
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

  it('resumes a job whose research is frozen without fetching again, and refuses research that no longer matches its hashes', async () => {
    const stopBeforeWriter = (p: ReturnType<typeof setup>): ProductionReasoningHarness => ({
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      proposeProduction: () => Promise.reject(new Error('CI_STOP_BEFORE_WRITER')),
    });
    const intact = setup(() => answer(authored()));
    await expect(
      intact.producerWith({ harness: stopBeforeWriter(intact) })('seasons', false, signal()),
    ).rejects.toThrow('CI_STOP_BEFORE_WRITER');
    const fetches: string[] = [];
    const resumed = await intact.producerWith({
      research: (url) => {
        fetches.push(url);
        return Promise.reject(new Error('CI_NO_SECOND_FETCH'));
      },
    })('seasons', false, signal(), true);
    expect(resumed.outcome).toBe('published');
    expect(fetches).toEqual([]);
    expect(intact.fixture.calls).toHaveLength(1);
  });

  it('refuses to resume on stored research whose text was changed, before any model call', async () => {
    const p = setup(() => answer(authored()));
    const stop: ProductionReasoningHarness = {
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      proposeProduction: () => Promise.reject(new Error('CI_STOP_BEFORE_WRITER')),
    };
    await expect(p.producerWith({ harness: stop })('seasons', false, signal())).rejects.toThrow(
      'CI_STOP_BEFORE_WRITER',
    );
    await sql`update content.scroll_production_runs set research=jsonb_set(research,'{0,passages,0,text}','"tampered CI passage"'::jsonb) where topic='seasons'`.execute(
      database.db,
    );
    const resumed = await p.produce('seasons', false, signal(), true);
    expect(resumed.outcome).toBe('rejected');
    expect(resumed.codes).toContain('research_integrity');
    expect(p.fixture.calls).toHaveLength(0);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
  });

  it.each(['success', 'refusal'] as const)(
    'keeps an advanced writer alive when a concurrent stale research delivery finishes with %s',
    async (outcome) => {
      const researchEntered = gate();
      const researchRelease = gate();
      const writerEntered = gate();
      const writerRelease = gate<FixtureScenario>();
      const p = setup(() => {
        writerEntered.open();
        return { kind: 'hold', until: writerRelease.promise };
      });
      const stale = p.producerWith({
        research: async (url) => {
          researchEntered.open();
          await researchRelease.promise;
          if (outcome === 'refusal') throw new ResearchRefusal('network_failed');
          return fixtureResearchFor(url);
        },
      })('seasons', false, signal());
      await researchEntered.promise;
      const active = p.produce('seasons', false, signal(), true);
      try {
        await writerEntered.promise;
        researchRelease.open();
        const replay = await stale;
        expect(replay.outcome).toBe('in_progress');
        const current = await sql<{
          state: string;
          outcomes: unknown[];
        }>`select state,outcomes from content.scroll_production_runs where id=${replay.runId}`.execute(database.db);
        expect(current.rows[0]).toMatchObject({ state: 'writer', outcomes: [] });
        expect(p.fixture.calls).toHaveLength(1);
        const attempts = await database.db
          .selectFrom('reasoning.production_attempts')
          .select('state')
          .orderBy('reserved_at')
          .execute();
        expect(attempts.map((attempt) => attempt.state)).toEqual(['dispatched']);
        writerRelease.open(answer(authored()));
        expect((await active).outcome).toBe('published');
        expect(p.fixture.calls).toHaveLength(1);
      } finally {
        researchRelease.open();
        writerRelease.open(answer(authored()));
        await Promise.allSettled([stale, active]);
      }
    },
  );

  describe('publication authority (topic attribution)', () => {
    const original = [
      'seasons',
      'tides',
      'greenhouse',
      'greenhouse-radiation',
      'greenhouse-balance',
      'greenhouse-limits',
    ] as const;
    const publishOnce = (topic: (typeof original)[number], minimaxIdentity = true) => {
      const p = setup(() => answer(fixtureAuthored(writerFormatOf(TOPICS[topic]))), minimaxIdentity);
      return { p, publish: (resume = false) => p.produce(topic, false, signal(), resume) };
    };

    it.each(original)(
      'attributes only a newly completed exact %s publication (CI transport identity stand-in)',
      async (topic) => {
        const recipe = TOPICS[topic];
        const { p, publish } = publishOnce(topic);
        const result = await publish();
        expect(result.outcome).toBe('published');
        expect(p.fixture.calls).toHaveLength(1);
        expect(p.fixture.calls[0]?.request.system).toContain(`version ${WRITER_PROMPT_VERSION},`);
        expect(result.assetId).toBe(recipe.assetId);
        expect(
          await database.db
            .selectFrom('content.asset_revisions')
            .select('explanation_unit_id')
            .where('asset_id', '=', result.assetId ?? '')
            .executeTakeFirstOrThrow(),
        ).toEqual({ explanation_unit_id: explanationUnitFor(topic) });
        expect(
          await database.db
            .selectFrom('content.scroll_production_runs')
            .select('policy_version')
            .where('id', '=', result.runId ?? '')
            .executeTakeFirstOrThrow(),
        ).toEqual({ policy_version: SCROLL_PRODUCTION_VERSION });
        expect(
          await database.db
            .selectFrom('content.asset_provenance')
            .select('provenance')
            .where('asset_id', '=', result.assetId ?? '')
            .executeTakeFirstOrThrow(),
        ).toMatchObject({ provenance: { production: { promptVersion: WRITER_PROMPT_VERSION } } });
        expect(
          await database.db
            .selectFrom('content.discovery_revisions')
            .select(['facets', 'attribution_version'])
            .where('asset_id', '=', result.assetId ?? '')
            .executeTakeFirstOrThrow(),
        ).toEqual({ facets: [recipe.topicId], attribution_version: 'published-scroll-brief-taxonomy.v1' });
        expect(
          await database.db
            .selectFrom('content.encounter_topics')
            .select(['topic_id', 'role', 'weight'])
            .where('asset_id', '=', result.assetId ?? '')
            .execute(),
        ).toEqual([{ topic_id: recipe.topicId, role: 'primary', weight: 1 }]);

        const bytes = () =>
          sql<{
            document: string;
            provenance: string;
          }>`select row_to_json(r)::text as document,row_to_json(p)::text as provenance from content.asset_revisions r join content.asset_provenance p using(asset_id,revision) where r.asset_id=${result.assetId}::uuid`.execute(
            database.db,
          );
        const before = (await bytes()).rows;
        expect(await publish(true)).toEqual(result);
        expect((await bytes()).rows).toEqual(before);
        expect(p.fixture.calls).toHaveLength(1);
        expect(await database.db.selectFrom('identity.universes').select('id').execute()).toHaveLength(0);
      },
    );

    it('publishes three distinct units under one canonical topic without creating personal evidence', async () => {
      const assets: string[] = [];
      for (const topic of ['greenhouse-radiation', 'greenhouse-balance', 'greenhouse-limits'] as const) {
        const result = await publishOnce(topic).publish();
        expect(result.outcome).toBe('published');
        expect(result.requestBound).toBe(2);
        assets.push(result.assetId ?? '');
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

    it('keeps the persisted recipe-key constraint to the shape of a key; the code-owned plan decides which keys exist', async () => {
      for (const topic of ['__proto__', 'GREENHOUSE', 'greenhouse_radiation', '-greenhouse', 'x'.repeat(65)]) {
        await expect(
          sql`insert into content.scroll_production_runs (id,topic,policy_version,target_revision,scope_generation,state,writer_run_id) values (${randomUUID()},${topic},'CI-unknown',1,1,'research',${randomUUID()})`.execute(
            database.db,
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'scroll_production_runs_topic_check' });
      }
      expect(await database.db.selectFrom('content.scroll_production_runs').select('id').execute()).toHaveLength(0);
    });

    it('keeps normal fixture-generated lookalikes unknown despite model-kind provenance and a matching explanation ID', async () => {
      const result = await publishOnce('greenhouse', false).publish();
      expect(result.outcome).toBe('published');
      expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toHaveLength(0);
      expect(
        await database.db.selectFrom('content.discovery_revisions').select('facets').executeTakeFirstOrThrow(),
      ).toEqual({ facets: [] });
    });

    // Each fault corrupts one fact the publication hook checks, inside the real publication
    // transaction, and attribution must stay unknown. Deliberately corrupt fixture state, never a
    // migration or a runtime capability.
    const faults = {
      no_job: 'delete from content.scroll_production_runs where id=new.id',
      not_published:
        "update content.scroll_production_runs set state='writer',asset_id=null,asset_revision=null,completed_at=null where id=new.id",
      foreign_asset: 'update content.scroll_production_runs set asset_id=gen_random_uuid() where id=new.id',
      wrong_writer_run: 'update content.scroll_production_runs set writer_run_id=gen_random_uuid() where id=new.id',
      wrong_prompt_version:
        "update content.asset_provenance set provenance=jsonb_set(provenance,'{production,promptVersion}','\"scroll-writer.foreign\"') where asset_id=new.asset_id",
      previous_prompt_version:
        "update content.asset_provenance set provenance=jsonb_set(provenance,'{production,promptVersion}','\"scroll-writer.v12\"') where asset_id=new.asset_id",
      wrong_document_version:
        "update content.asset_revisions set document_version='scroll-document.foreign' where asset_id=new.asset_id",
      wrong_provenance_version:
        "update content.asset_provenance set provenance_version='scroll-provenance.foreign' where asset_id=new.asset_id",
      foreign_provenance_run:
        "update content.asset_provenance set provenance=jsonb_set(provenance,'{production,runId}',to_jsonb(gen_random_uuid()::text)) where asset_id=new.asset_id",
      foreign_receipt:
        "update content.scroll_production_runs set outcomes=jsonb_set(outcomes,'{0,attemptId}',to_jsonb(gen_random_uuid()::text)) where id=new.id",
      emptied_receipt:
        "update content.scroll_production_runs set outcomes=jsonb_set(outcomes,'{0,attempts}','[]'::jsonb) where id=new.id",
      fixture_provenance:
        'update content.asset_provenance set provenance=jsonb_set(provenance,\'{production}\',\'{"kind":"fixture","label":"CI fixture authority must stay unknown"}\') where asset_id=new.asset_id',
      foreign_attempt:
        "update content.asset_provenance set provenance=jsonb_set(provenance,'{production,attemptIds}',jsonb_build_array(gen_random_uuid()::text)) where asset_id=new.asset_id",
      foreign_model:
        "update content.asset_provenance set provenance=jsonb_set(provenance,'{production,model}','\"foreign-model\"') where asset_id=new.asset_id",
      wrong_job_version:
        "update content.scroll_production_runs set policy_version='scroll-production.foreign' where id=new.id",
      previous_job_version:
        "update content.scroll_production_runs set policy_version='scroll-production.v13' where id=new.id",
      no_writer_output: 'update content.scroll_production_runs set writer_output=null where id=new.id',
      no_cited_claims: 'update content.scroll_production_runs set claims=null where id=new.id',
      mismatched_revision:
        'update content.scroll_production_runs set target_revision=target_revision+1 where id=new.id',
      no_baseline: 'delete from content.discovery_revisions where asset_id=new.asset_id',
      conflicting_topic:
        "insert into content.encounter_topics values(new.asset_id,new.asset_revision,'ci.foreign-topic','primary',1)",
      withdrawn: "update content.assets set status='withdrawn' where id=new.asset_id",
    } as const;
    it.each(Object.entries(faults))(
      'leaves attribution unknown for %s authority (CI fault injection after job publication)',
      async (_fault, statement) => {
        // The trigger runs in the REAL publication transaction before the private hook.
        await sql`create function content.ci_publication_fault() returns trigger language plpgsql as $$
          begin ${sql.raw(statement)}; return new; end $$`.execute(database.db);
        await sql`create trigger ci_publication_fault after update of state on content.scroll_production_runs for each row when (new.state='published' and old.state<>'published') execute function content.ci_publication_fault()`.execute(
          database.db,
        );
        const { p, publish } = publishOnce('greenhouse');
        await publish();
        expect(p.fixture.calls).toHaveLength(1);
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
      },
    );

    it('cannot publish or attribute when the same-scope writer closure does not succeed', async () => {
      const p = setup(() => answer(fixtureAuthored('comparison')));
      const denied: ProductionReasoningHarness = {
        proposeProduction: (input, abort) => p.harness.proposeProduction(input, abort),
        readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
        closeProductionRun: () => Promise.resolve('not_open'),
      };
      expect((await p.producerWith({ harness: denied })('greenhouse', false, signal())).outcome).toBe('in_progress');
      expect(p.fixture.calls).toHaveLength(1);
      expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toHaveLength(0);
      expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toHaveLength(0);
    });

    it('rolls back closure and publication if topic projection fails, then resumes the same paid writer without a resend', async () => {
      await sql`create function content.ci_fail_topic() returns trigger language plpgsql as $$ begin raise exception 'CI_TOPIC_PROJECTION_FAILURE'; end $$`.execute(
        database.db,
      );
      await sql`create trigger ci_fail_topic before insert on content.encounter_topics for each row execute function content.ci_fail_topic()`.execute(
        database.db,
      );
      const { p, publish } = publishOnce('greenhouse');
      await expect(publish()).rejects.toThrow('CI_TOPIC_PROJECTION_FAILURE');
      expect(p.fixture.calls).toHaveLength(1);
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
      expect((await publish(true)).outcome).toBe('published');
      expect(p.fixture.calls).toHaveLength(1);
      expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([
        { topic_id: TOPICS.greenhouse.topicId },
      ]);
    });
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

    it('keeps the bounded raw reply of an unreadable answer for the operator and never feeds it back to the repair', async () => {
      const p = viaTransport(() => message([{ type: 'thinking', thinking: 'ONLY-THINKING', signature: 'ci' }]));
      await p.produce('seasons', false, signal());
      const rows = await rejectedRows();
      expect(rows.map((row) => row.reason)).toEqual(['REPLY_NO_TEXT', 'REPLY_NO_TEXT']);
      expect(rows.map((row) => row.answer_kind)).toEqual(['raw_reply', 'raw_reply']);
      expect(rows[0]?.answer_text).toContain('ONLY-THINKING');
      // The repair carries the fixed findings only: no envelope, no thinking, no previous-answer block.
      expect(p.calls).toHaveLength(2);
      const repair = JSON.stringify(p.calls[1]);
      expect(repair).not.toContain('ONLY-THINKING');
      expect(repair).not.toContain('<previous-answer>');
    });
  });
});
