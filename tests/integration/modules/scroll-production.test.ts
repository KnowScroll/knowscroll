import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  guardedModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import { ScrollDraft, normaliseDraftInput } from '@knowscroll/scroll-model/producer';
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
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { claimsRole } from '../../../packages/backend/src/modules/content/production/roles.js';
import { makeProduceScroll } from '../../../packages/backend/src/modules/content/production/produce.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

// Every word below and every model answer is a labelled, authored CI fixture, never real provider evidence.
const passage =
  'This deliberately authored fixture passage describes the public research snapshot boundary with sufficiently distinctive wording for exact quote checks while avoiding overlap with the separate fixture explanation.';
function researchFixture(url: string): ResearchPage {
  // The two-page tides recipe needs two distinct source identities; fixture claims keep the
  // first snapshot's exact bytes while the second is a separately labelled authored source.
  const extra = url === TOPICS.tides.pages[1] ? ' A separately authored second research snapshot.' : '';
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
        Promise.resolve(url === TOPICS.tides.pages[1] ? researchFixture(url) : page),
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
  it.each(['greenhouse', 'seasons', 'tides'] as const)(
    'attributes only a newly completed exact %s publication (CI transport identity stand-in)',
    async (topic) => {
      const p = setup((n) => answer(n === 1 ? selection : draft(topic !== 'greenhouse')), true);
      const result = await p.produce()(topic, false, signal());
      expect(result.outcome).toBe('published');
      expect(p.model.calls).toHaveLength(2);
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
    'wrong_document_version',
    'wrong_provenance_version',
    'foreign_provenance_run',
    'foreign_receipt',
    'fixture_provenance',
    'foreign_attempt',
    'foreign_model',
    'wrong_job_version',
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
          when 'wrong_document_version' then update content.asset_revisions set document_version='scroll-document.foreign' where asset_id=new.asset_id;
          when 'wrong_provenance_version' then update content.asset_provenance set provenance_version='scroll-provenance.foreign' where asset_id=new.asset_id;
          when 'foreign_provenance_run' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,runId}',to_jsonb(gen_random_uuid()::text)) where asset_id=new.asset_id;
          when 'foreign_receipt' then update content.scroll_production_runs set outcomes=jsonb_set(outcomes,'{1,attemptId}',to_jsonb(gen_random_uuid()::text)) where id=new.id;
          when 'fixture_provenance' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production}','{"kind":"fixture","label":"CI fixture authority must stay unknown"}') where asset_id=new.asset_id;
          when 'foreign_attempt' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,attemptIds}',jsonb_build_array(gen_random_uuid()::text)) where asset_id=new.asset_id;
          when 'foreign_model' then update content.asset_provenance set provenance=jsonb_set(provenance,'{production,model}','"foreign-model"') where asset_id=new.asset_id;
          when 'wrong_job_version' then update content.scroll_production_runs set policy_version='scroll-production.foreign' where id=new.id;
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
  it('preserves all four historical terminal jobs and eleven attempt fixtures byte-for-byte while v4 creates distinct runs', async () => {
    // Historical SHAPES only: synthetic IDs/receipts, never imported real research or provider output.
    const old = [
      { policy: 'scroll-production.v1', topic: 'seasons', counts: [1, 2] },
      { policy: 'scroll-production.v2', topic: 'seasons', counts: [2, 0] },
      { policy: 'scroll-production.v3', topic: 'seasons', counts: [1, 2] },
      { policy: 'scroll-production.v3', topic: 'greenhouse', counts: [1, 2] },
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
              ? 'scroll-writer.v2'
              : job.policy === 'scroll-production.v2'
                ? 'scroll-claims.v1'
                : 'scroll-claims.v2';
        await sql`insert into reasoning.production_runs (scope_id,id,owner_module,purpose,generation,role_id,role_version,policy_version,provider,model,state,closed_at) values ('scroll-supply',${id},'content',${`scroll-${role}`},1,${`content.scroll-${role}`},${version},${job.policy},'fixture','historical-CI-fixture','failed',now())`.execute(
          database.db,
        );
        for (let step = 0; step < count; step += 1)
          await sql`insert into reasoning.production_attempts (scope_id,id,run_id,step,provider,model,role_id,role_version,request_hash,state,dispatch_id,dispatched_at,settled_at,outcome_code) values ('scroll-supply',${randomUUID()},${id},${step === 0 ? 'primary' : 'repair'},'fixture','historical-CI-fixture',${`content.scroll-${role}`},${version},${'f'.repeat(64)},'failed',${randomUUID()},now(),now(),'CI_HISTORICAL_REFUSAL')`.execute(
            database.db,
          );
      }
    }
    const ids = old.flatMap((job) => [job.claims, job.writer]);
    const previousBytes = async () => ({
      jobs: (
        await sql<{
          bytes: string;
        }>`select row_to_json(r)::text as bytes from content.scroll_production_runs r where policy_version in ('scroll-production.v1','scroll-production.v2','scroll-production.v3') order by id`.execute(
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
    expect(before.jobs).toHaveLength(4);
    expect(before.attempts).toHaveLength(11);
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
    expect(current.policy_version).toBe('scroll-production.v4');
    expect(ids).not.toContain(current.claims_run_id);
    expect(ids).not.toContain(current.writer_run_id);
    expect(p.model.calls[0]?.request.system).toContain('version scroll-claims.v2,');
    expect(p.model.calls[1]?.request.system).toContain('version scroll-writer.v3,');
    const provenance = await database.db
      .selectFrom('content.asset_provenance')
      .select('provenance')
      .where('asset_id', '=', result.assetId ?? '')
      .executeTakeFirstOrThrow();
    expect(provenance.provenance).toMatchObject({ production: { promptVersion: 'scroll-writer.v3' } });
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
      await sql`update content.scroll_production_runs set claims=jsonb_set(claims,'{claims,0,quote}','"tampered CI quote"'::jsonb) where topic='greenhouse' and policy_version='scroll-production.v4'`.execute(
        database.db,
      );
    else
      await sql`update content.scroll_production_runs set research=jsonb_set(research,'{0,passages,0,text}','"tampered CI passage"'::jsonb) where topic='greenhouse' and policy_version='scroll-production.v4'`.execute(
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
