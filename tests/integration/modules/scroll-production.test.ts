import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { spikePlanV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/plans.js';
import {
  explanationUnitFor,
  SCROLL_PRODUCTION_V3_VERSION,
  TOPICS,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import { WRITER_V3A_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v3.js';
import { WRITER_V3_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v3-version.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { FIXTURE_SOURCE } from '../support/generated-scroll.js';
import { fixtureModel, fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { orrinResearchFor } from '../support/scroll-v2.js';
import { orrinV3 } from '../support/scroll-v3.js';

const SOURCE = FIXTURE_SOURCE;
/** The writer's answer: the recorded Orrin reply of the document v3 writer (an invented planet; never provider output or product content). */
const authored = () => orrinV3();
const answer = (value: unknown): FixtureScenario => ({ kind: 'success', text: JSON.stringify(value) });
/** The recorded reply with its first paragraph opening by pointing back, which the writer's own check refuses (as in `writer-v3-publication.test.ts`). */
function pointingBack(): unknown {
  const draft = JSON.parse(JSON.stringify(orrinV3())) as { items: { text?: string }[] };
  draft.items[1] = { ...draft.items[1], text: `This ${draft.items[1]?.text ?? ''}` };
  return draft;
}

describe('Scroll production (CI fixture + real PostgreSQL; no provider network)', () => {
  // The production job writes a document v3 Scroll, the only kind there is (#818). The recorded Orrin reply is written to the Seasons plan (a
  // statement and a grid, three sections), so the recipes this file produces take that plan for the file's own process, as the v3 publication
  // test does, and get their own back after.
  const PRODUCED = [
    'greenhouse',
    'greenhouse-balance',
    'greenhouse-limits',
    'greenhouse-radiation',
    'stars-fusion',
    'tides',
  ] as const;
  const ownPlans = new Map(PRODUCED.map((key) => [key, RECIPES[key].scrollV3]));
  beforeAll(() => {
    for (const key of PRODUCED) (RECIPES[key] as { scrollV3?: ScrollV3Plan }).scrollV3 = spikePlanV3('seasons');
  });
  afterAll(() => {
    for (const [key, plan] of ownPlans) (RECIPES[key] as { scrollV3?: ScrollV3Plan }).scrollV3 = plan;
  });
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
    research: (url: string) => Promise<ResearchPage> = (url) => Promise.resolve(orrinResearchFor(url)),
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
    const first = await p.produce('stars-fusion', false, signal());
    expect(first).toMatchObject({ outcome: 'published', requestBound: 6, revision: 1 });
    expect(p.fixture.calls).toHaveLength(1);
    // The first delivery holds the Scroll for review; the delivery after it reports the settled job.
    const { held, ...settled } = first;
    expect(held).toBe(true);
    expect(await p.produce('stars-fusion', false, signal())).toEqual(settled);
    expect(p.fixture.calls).toHaveLength(1);

    const revision = await database.db
      .selectFrom('content.asset_revisions')
      .select(['document', 'explanation_unit_id', 'provenance_kind'])
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(revision.explanation_unit_id).toBe(TOPICS['stars-fusion'].explanationUnitId);
    expect(revision.provenance_kind).toBe('generated');
    for (const hidden of ['claims', 'sources', 'bindings', 'checks', 'production'])
      expect(revision.document).not.toHaveProperty(hidden);
    expect((revision.document as { schemaVersion: string }).schemaVersion).toBe('scroll-document.v3');
    expect(revision.document).toMatchObject({ title: 'Why Orrin has summers and winters' });

    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', first.assetId ?? '')
      .executeTakeFirstOrThrow();
    const stored = provenance.provenance as { production: { model: string; attemptIds: string[] }; claims: unknown[] };
    expect(stored.production).toMatchObject({ model: 'MiniMax-M3.1-Flash', attemptIds: [expect.any(String)] });
    // Only the passages the Scroll cites become claims, each the exact source text.
    const cited = new Set(
      [...authored().items, ...authored().pictures].flatMap((part) => ('cites' in part ? (part.cites ?? []) : [])),
    );
    expect(stored.claims).toHaveLength(cited.size);
    const job = await database.db
      .selectFrom('content.scroll_production_runs')
      .select(['state', 'claims', 'writer_output'])
      .where('topic', '=', 'stars-fusion')
      .executeTakeFirstOrThrow();
    expect(job.state).toBe('published');
    expect(job.claims).toHaveLength(cited.size);
    expect(job.writer_output).toMatchObject({ title: 'Why Orrin has summers and winters' });
    expect(await rejectedRows()).toEqual([]);
  });

  // The repair's own data (the refused answer as delimited data, the quoted copy in the repair notes) is tested on the document v3 writer in
  // `writer-v3-publication.test.ts`; the v1 copy notes and the v1 diagram defaults (`authoring-normalisation`) went with the v1 writer (#818).
  it('sends no repair notes for a finding that is not about copying', async () => {
    const p = setup((sequence) => answer(sequence === 1 ? pointingBack() : authored()));
    expect((await p.produce('stars-fusion', false, signal())).outcome).toBe('published');
    const repair = p.fixture.calls[1]?.request;
    expect(repair?.user).toContain('<previous-answer>');
    expect(repair?.user).not.toContain('<repair-notes>');
  });

  it('rejects after the repair also fails, keeps both refused answers redacted and lists them for the operator', async () => {
    const key = 'sk-cp-FIXTUREfixtureFIXTUREfixture0000';
    const p = setup((sequence) =>
      sequence === 1
        ? { kind: 'success', text: `{"title": "${key}", "note": "https://leak.example/a?X-Amz-Signature=canary" ` }
        : answer(pointingBack()),
    );
    const result = await p.produce('stars-fusion', false, signal());
    expect(result).toMatchObject({ outcome: 'rejected', codes: ['invalid_output'] });
    expect(p.fixture.calls).toHaveLength(2);

    const rows = await rejectedRows();
    expect(rows.map((row) => row.reason)).toEqual(['OUTPUT_NOT_ONE_JSON_OBJECT', 'OUTPUT_SCHEMA_MISMATCH']);
    // Redacted at the recording boundary: a key-shaped value and a credential-bearing query never reach the table.
    expect(rows[0]?.answer_text).not.toContain(key);
    expect(rows[0]?.answer_text).not.toContain('X-Amz-Signature');
    expect(rows[1]?.issues).toContainEqual(expect.objectContaining({ code: 'first_beat_points_back' }));

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
    await p.produce('stars-fusion', false, signal());
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
    const p = setup(() => ({ kind: 'truncated', text: '{"title": "Why Orrin has summers' }));
    const result = await p.produce('stars-fusion', false, signal());
    expect(result).toMatchObject({ outcome: 'rejected' });
    expect((await rejectedRows()).map((row) => row.reason)).toEqual(['OUTPUT_TRUNCATED', 'OUTPUT_TRUNCATED']);
    expect(p.fixture.calls[1]?.request.system).toContain('truncated');
  });

  it('halts an unknown attempt and never resends it, even with an explicit resume', async () => {
    const p = setup(() => ({ kind: 'gateway_timeout' }));
    expect(await p.produce('stars-fusion', false, signal())).toMatchObject({ outcome: 'unknown' });
    expect(await p.produce('stars-fusion', false, signal(), true)).toMatchObject({ outcome: 'unknown' });
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
    expect(await p.produce('stars-fusion', false, signal())).toMatchObject({
      outcome: 'rejected',
      codes: ['evidence_insufficient'],
    });
    expect(fixture.calls).toHaveLength(0);
  });

  it('reports the bound on a dry run and does no database or provider work', async () => {
    const p = setup(() => answer(authored()));
    expect(await p.produce('stars-fusion', true, signal())).toEqual({ outcome: 'dry_run', requestBound: 6 });
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
      intact.producerWith({ harness: stopBeforeWriter(intact) })('stars-fusion', false, signal()),
    ).rejects.toThrow('CI_STOP_BEFORE_WRITER');
    const fetches: string[] = [];
    const resumed = await intact.producerWith({
      research: (url) => {
        fetches.push(url);
        return Promise.reject(new Error('CI_NO_SECOND_FETCH'));
      },
    })('stars-fusion', false, signal(), true);
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
    await expect(p.producerWith({ harness: stop })('stars-fusion', false, signal())).rejects.toThrow(
      'CI_STOP_BEFORE_WRITER',
    );
    await sql`update content.scroll_production_runs set research=jsonb_set(research,'{0,passages,0,text}','"tampered CI passage"'::jsonb) where topic='stars-fusion'`.execute(
      database.db,
    );
    const resumed = await p.produce('stars-fusion', false, signal(), true);
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
          return orrinResearchFor(url);
        },
      })('stars-fusion', false, signal());
      await researchEntered.promise;
      const active = p.produce('stars-fusion', false, signal(), true);
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
    // Library recipes written as document v3 Scrolls (the recipes this file gives the Seasons plan).
    const producedRecipes = [
      'stars-fusion',
      'tides',
      'greenhouse',
      'greenhouse-radiation',
      'greenhouse-balance',
      'greenhouse-limits',
    ] as const;
    const publishOnce = (topic: (typeof producedRecipes)[number], minimaxIdentity = true) => {
      const p = setup(() => answer(authored()), minimaxIdentity);
      return { p, publish: (resume = false) => p.produce(topic, false, signal(), resume) };
    };

    it.each(producedRecipes)(
      'attributes only a newly completed exact %s publication (CI transport identity stand-in)',
      async (topic) => {
        const recipe = TOPICS[topic];
        const { p, publish } = publishOnce(topic);
        const result = await publish();
        expect(result.outcome).toBe('published');
        expect(p.fixture.calls).toHaveLength(1);
        expect(p.fixture.calls[0]?.request.system).toContain(`version ${WRITER_V3A_VERSION},`);
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
        ).toEqual({ policy_version: SCROLL_PRODUCTION_V3_VERSION });
        expect(
          await database.db
            .selectFrom('content.asset_provenance')
            .select('provenance')
            .where('asset_id', '=', result.assetId ?? '')
            .executeTakeFirstOrThrow(),
        ).toMatchObject({ provenance: { production: { promptVersion: WRITER_V3_PROMPT_VERSION } } });
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
        // The first delivery holds the Scroll for review; a resume reports the settled job.
        const { held, ...settled } = result;
        expect(held).toBe(true);
        expect(await publish(true)).toEqual(settled);
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
        expect(result.requestBound).toBe(6);
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
      // A document v3 revision is held for review, and a held revision rests on its review row, not on the asset's status.
      no_review_row: 'delete from content.revision_reviews where asset_id=new.asset_id',
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
      const p = setup(() => answer(authored()));
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
      const result = await p.produce('stars-fusion', false, signal());
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
      expect(await p.produce('stars-fusion', false, signal())).toMatchObject({
        outcome: 'rejected',
        codes: ['failed'],
      });
      expect(p.calls).toHaveLength(1);
      const attempt = await database.db
        .selectFrom('reasoning.production_attempts')
        .select(['state', 'outcome_code', 'output_tokens'])
        .executeTakeFirstOrThrow();
      expect(attempt).toMatchObject({ state: 'failed', outcome_code: 'MODEL_MISMATCH', output_tokens: 700 });
    });

    it('keeps the bounded raw reply of an unreadable answer for the operator and never feeds it back to the repair', async () => {
      const p = viaTransport(() => message([{ type: 'thinking', thinking: 'ONLY-THINKING', signature: 'ci' }]));
      await p.produce('stars-fusion', false, signal());
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
