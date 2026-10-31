import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  coverageCatalogue,
  coverageHeadPorts,
  makeAdmissionStore,
  makeReadAdmittedCoverageMapping,
  readAdmittedCoverageMapping,
  readRegionEncounterCandidates,
  readmitCoverageUseCase,
  readmitRecipeCoverage,
} from '@knowscroll/backend/modules/content/nest-providers';
import { observedBindings } from '../../../packages/backend/src/modules/evidence/domain/coverage.js';
import { SCROLL_QUALIFICATION_POLICY_V0 } from '../../../packages/backend/src/modules/evidence/domain/policy.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import {
  answerWith,
  enableProductionScope,
  FIXTURE_PROSE,
  fixtureAuthored,
  fixtureProduction,
  fixtureResearchFor,
} from '../support/generated-scroll.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { baselineCapabilities } from '../support/scroll.js';
import { markRecipesV1 } from '../support/scroll-v2.js';

/**
 * Publishing a generated Scroll admits its topic and facet coverage in the same transaction, decided
 * by code from the recipe. The model is a labelled CI fixture; nothing here is provider output.
 */
describe('Generated Scroll coverage at publication (CI fixture transport, real PostgreSQL)', () => {
  // The plan marks these recipes v2 (D-217); this file uses them as v1 examples.
  const restoreRecipes = markRecipesV1('tides', 'tides-coasts', 'greenhouse');
  afterAll(restoreRecipes);
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recipe_coverage');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  /** Recipes of one or two pages: the fixture serves each page a recipe names as a source of its own. */
  function publishing(recipeKey: ScrollTopic) {
    for (const url of TOPICS[recipeKey].pages) expect(fixtureResearchFor(url).url).toBe(url);
    const run = fixtureProduction(database.db, () => answerWith(fixtureAuthored(writerFormatOf(TOPICS[recipeKey]))));
    return { ...run, publish: (resume = false) => run.produce(recipeKey, false, signal(), resume) };
  }

  async function storedRevision(assetId: string) {
    const row = await database.db
      .selectFrom('content.asset_revisions')
      .select(['reading_facts', 'document'])
      .where('asset_id', '=', assetId)
      .where('revision', '=', 1)
      .executeTakeFirstOrThrow();
    const topLevelIds = (row.document as { sections: { blocks: { id: string }[] }[] }).sections.flatMap((section) =>
      section.blocks.map((block) => block.id),
    );
    return { facts: row.reading_facts as never, topLevelIds };
  }

  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 2000 });

  it.each(['tides', 'tides-coasts', 'greenhouse'] as const)(
    'writes topic attribution and a facet mapping with the %s publication, and the consumers read them back',
    async (recipeKey) => {
      const recipe = TOPICS[recipeKey];
      const run = publishing(recipeKey);
      const result = await run.publish();
      expect(result).toMatchObject({ outcome: 'published', assetId: recipe.assetId, revision: 1 });
      expect(run.calls).toHaveLength(1);

      // Topic attribution: one primary topic carrying the whole weight.
      expect(
        await database.db
          .selectFrom('content.encounter_topics')
          .select(['topic_id', 'role', 'weight'])
          .where('asset_id', '=', recipe.assetId)
          .execute(),
      ).toEqual([{ topic_id: recipe.topicId, role: 'primary', weight: 1 }]);

      // Coverage: one active head decided by the recipe rule, never reviewed by a person or a model.
      const revisions = await database.db
        .selectFrom('content.coverage_revisions')
        .select(['revision', 'status', 'semantic_review_reference', 'mapping'])
        .where('asset_id', '=', recipe.assetId)
        .execute();
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        revision: 1,
        status: 'active',
        semantic_review_reference: `scroll-recipe-coverage.v1:${recipe.explanationUnitId}`,
      });
      const expectedFacets = [
        recipe.facetId,
        ...(recipe.supportingFacetId === undefined ? [] : [recipe.supportingFacetId]),
      ];
      expect(
        (revisions[0]?.mapping as { bindings: { facetId: string }[] }).bindings.map((binding) => binding.facetId),
      ).toEqual(expectedFacets);
      expect(
        (
          await database.db
            .selectFrom('content.region_bindings')
            .select('facet_id')
            .where('asset_id', '=', recipe.assetId)
            .execute()
        )
          .map((row) => row.facet_id)
          .sort(),
      ).toEqual([...expectedFacets].sort());

      // The consumer's port returns the mapping; every required block is a real top-level block.
      const person = await seedPerson(database.db);
      const read = await withScope()(person.authority, (scope) =>
        readAdmittedCoverageMapping(scope, { assetId: recipe.assetId, assetRevision: 1 }),
      );
      if (read.kind !== 'entered' || read.value.kind !== 'mapped') throw new Error('mapping not readable');
      const { head } = read.value;
      const { facts, topLevelIds } = await storedRevision(recipe.assetId);
      for (const binding of head.mapping.bindings) {
        expect(binding.requiredBlockIds.length).toBeGreaterThan(0);
        for (const id of binding.requiredBlockIds) expect(topLevelIds).toContain(id);
      }

      // The region consumer finds the Scroll under each facet it was bound to.
      for (const facetId of expectedFacets) {
        const regions = await withScope()(person.authority, (scope) =>
          readRegionEncounterCandidates(scope, {
            topicId: recipe.topicId,
            facetId,
            truthStatus: 'factual',
            capabilities: baselineCapabilities,
          }),
        );
        expect(regions).toMatchObject({
          kind: 'entered',
          value: { kind: 'read', candidates: [{ coverage: head.authority }] },
        });
      }

      // The evidence consumer credits the facets only to a reader who saw the required blocks.
      const readingFacts = facts as { estimatedReadingMs: number; totalWeight: number; blocks: { id: string }[] };
      const evidenceFor = (seenBlocks: string[]) => ({
        id: '00000000-0000-4000-8000-000000000001',
        revision: 1,
        inputWatermark: 1,
        policyVersion: SCROLL_QUALIFICATION_POLICY_V0.version,
        assetId: recipe.assetId,
        assetRevision: 1,
        qualification: 'qualified',
        q: 1,
        coverage: 1,
        estimatedReadingMs: readingFacts.estimatedReadingMs,
        summary: {
          v: 1,
          seenBlocks,
          seenWeight: readingFacts.totalWeight,
          totalWeight: readingFacts.totalWeight,
          dwellRatio: 1,
          interactions: [],
          coverageEvents: 1,
          dwellEvents: 1,
          instrumentationVersion: 1,
          sequenceGaps: 0,
          reasons: [],
        },
      });
      const allBlocks = readingFacts.blocks.map((block) => block.id);
      expect(observedBindings(evidenceFor(allBlocks), facts, head, canonicalSha256)?.map((b) => b.facetId)).toEqual(
        expectedFacets,
      );
      expect(observedBindings(evidenceFor(allBlocks.slice(0, 1)), facts, head, canonicalSha256)).toEqual([]);
    },
  );

  it('maps a real-shaped answer with exactly the three body blocks the rule needs, and publishes one with two without coverage', async () => {
    const recipe = TOPICS.tides;
    const authored = fixtureAuthored(writerFormatOf(recipe));
    const formatBlock = authored.blocks.find((block) => block.type === 'diagram');
    if (formatBlock === undefined) throw new Error('CI_FORMAT_MISSING');
    /** The fixture prose in `count` paragraphs, so the reading length stays the same. */
    const withBodyBlocks = (count: number) => {
      const size = FIXTURE_PROSE.length / count;
      const paragraphs = Array.from({ length: count }, (_, index) => ({
        type: 'paragraph' as const,
        cites: [`e${index + 1}`, `e${index + 2}`],
        text: FIXTURE_PROSE.slice(index * size, (index + 1) * size).join(' '),
      }));
      return { ...authored, blocks: [{ type: 'heading', text: 'The beam' }, ...paragraphs, formatBlock] };
    };
    const three = fixtureProduction(database.db, () => answerWith(withBodyBlocks(3)));
    expect(await three.produce('tides', false, signal())).toMatchObject({
      outcome: 'published',
      assetId: recipe.assetId,
    });
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([
      { revision: 1 },
    ]);

    await database.drop();
    database = await createTestDatabase<Database>('recipe_coverage');
    await enableProductionScope(database.db);
    const two = fixtureProduction(database.db, () => answerWith(withBodyBlocks(2)));
    const result = await two.produce('tides', false, signal());
    expect(result.outcome).toBe('published');
    expect(result.attempts).toContainEqual({ role: 'checks', kind: 'published', code: 'coverage_too_few_body_blocks' });
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([]);
  });

  it('lets two recipes of one planet each add their own facets', async () => {
    await publishing('tides').publish();
    await publishing('tides-coasts').publish();
    const person = await seedPerson(database.db);
    const candidatesFor = async (facetId: string) => {
      const regions = await withScope()(person.authority, (scope) =>
        readRegionEncounterCandidates(scope, {
          topicId: 'earth.tides',
          facetId,
          truthStatus: 'factual',
          capabilities: baselineCapabilities,
        }),
      );
      if (regions.kind !== 'entered' || regions.value.kind !== 'read') throw new Error('regions not readable');
      return regions.value.candidates.map((candidate) => candidate.coverage.assetId).sort();
    };
    expect(await candidatesFor('earth.tides.forcing')).toEqual([TOPICS.tides.assetId]);
    expect(await candidatesFor('earth.tides.coasts')).toEqual(
      [TOPICS.tides.assetId, TOPICS['tides-coasts'].assetId].sort(),
    );
  });

  it('rolls publication back with the coverage write, then resumes the same paid writer without a resend', async () => {
    await sql`create function content.ci_fail_coverage() returns trigger language plpgsql as $$ begin raise exception 'CI_COVERAGE_FAILURE'; end $$`.execute(
      database.db,
    );
    await sql`create trigger ci_fail_coverage before insert on content.coverage_revisions for each row execute function content.ci_fail_coverage()`.execute(
      database.db,
    );
    const run = publishing('tides');
    await expect(run.publish()).rejects.toThrow('CI_COVERAGE_FAILURE');
    expect(run.calls).toHaveLength(1);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toEqual([]);
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([]);
    expect(
      await database.db.selectFrom('content.scroll_production_runs').select('state').executeTakeFirstOrThrow(),
    ).toEqual({ state: 'writer' });

    await sql`drop trigger ci_fail_coverage on content.coverage_revisions`.execute(database.db);
    expect((await run.publish(true)).outcome).toBe('published');
    expect(run.calls).toHaveLength(1);
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([
      { revision: 1 },
    ]);
  });

  describe('after the plan changes', () => {
    /** A plan edit as the readers see it: a new digest, and the tides "coasts" facet reworded. */
    const editedCatalogue = {
      sha256: 'e'.repeat(64),
      meaningSha256: (topicId: string, facetId: string) =>
        facetId === 'earth.tides.coasts' ? 'f'.repeat(64) : coverageCatalogue.meaningSha256(topicId, facetId),
    };
    const readEdited = makeReadAdmittedCoverageMapping(editedCatalogue);
    const recipes = Object.values(RECIPES);
    const readmitPorts = (catalogue: typeof editedCatalogue | typeof coverageCatalogue) => ({
      coverage: { ...coverageHeadPorts, catalogue },
      inAdmission: makeAdmissionStore(database.db).inAdmission,
      listGeneratedRevisions: async () =>
        (
          await database.db
            .selectFrom('content.asset_revisions')
            .select(['asset_id', 'revision'])
            .where('provenance_kind', '=', 'generated')
            .execute()
        ).map((row) => ({ assetId: row.asset_id, assetRevision: row.revision })),
    });
    const headCount = async () =>
      (await database.db.selectFrom('content.coverage_revisions').select('revision').execute()).length;

    it('keeps stored coverage readable, drops only the facet whose meaning changed, and re-admission appends', async () => {
      const recipe = TOPICS.tides;
      await publishing('tides').publish();
      const person = await seedPerson(database.db);
      const readFacets = async (read: typeof readAdmittedCoverageMapping) => {
        const result = await withScope()(person.authority, (scope) =>
          read(scope, { assetId: recipe.assetId, assetRevision: 1 }),
        );
        if (result.kind !== 'entered' || result.value.kind !== 'mapped') throw new Error('mapping not readable');
        return {
          facets: result.value.head.mapping.bindings.map((binding) => binding.facetId),
          headRevision: result.value.head.authority.headRevision,
        };
      };

      // The old head is still readable against the edited plan; the reworded facet is unmapped.
      expect(await readFacets(readEdited)).toEqual({ facets: ['earth.tides.forcing'], headRevision: 1 });

      // Deciding again against the edited plan appends a corrected head, once.
      const first = await readmitRecipeCoverage(readmitPorts(editedCatalogue), recipes, { dryRun: false });
      expect(first).toEqual({ dryRun: false, considered: 1, appended: 1, unchanged: 0, skipped: {} });
      expect(await headCount()).toBe(2);
      expect(await readFacets(readEdited)).toEqual({
        facets: ['earth.tides.forcing', 'earth.tides.coasts'],
        headRevision: 2,
      });
      const again = await readmitRecipeCoverage(readmitPorts(editedCatalogue), recipes, { dryRun: false });
      expect(again).toMatchObject({ appended: 0, unchanged: 1 });
      expect(await headCount()).toBe(2);
    });

    it('reports what it would do in a dry run and writes nothing', async () => {
      await publishing('tides').publish();
      const dry = await readmitRecipeCoverage(readmitPorts(editedCatalogue), recipes, { dryRun: true });
      expect(dry).toEqual({ dryRun: true, considered: 1, appended: 1, unchanged: 0, skipped: {} });
      expect(await headCount()).toBe(1);
    });

    it('finds generated revisions itself and changes nothing when the plan is unchanged', async () => {
      await publishing('tides').publish();
      await publishing('tides-coasts').publish();
      const summary = await readmitCoverageUseCase(database.db)({ dryRun: false });
      expect(summary).toEqual({ dryRun: false, considered: 2, appended: 0, unchanged: 2, skipped: {} });
      expect(await headCount()).toBe(2);
    });
  });

  it('publishes without coverage when no body block can be bound, and records why in the job', async () => {
    // Fault injection in the real publication transaction: every claim loses its documented truth
    // state, so no block is eligible. Deliberately corrupt fixture state, never a migration.
    await sql`create function content.ci_unsupport_claims() returns trigger language plpgsql as $$
      begin
        update content.asset_provenance set provenance=jsonb_set(provenance,'{claims}',
          (select coalesce(jsonb_agg(jsonb_set(claim,'{truthState}','"interpretation"')),'[]'::jsonb)
           from jsonb_array_elements(provenance->'claims') claim))
        where asset_id=new.asset_id and revision=new.revision;
        return new;
      end $$`.execute(database.db);
    await sql`create trigger ci_unsupport_claims after insert on content.asset_provenance for each row execute function content.ci_unsupport_claims()`.execute(
      database.db,
    );
    const result = await publishing('tides').publish();
    expect(result.outcome).toBe('published');
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([
      { topic_id: 'earth.tides' },
    ]);
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([]);
    expect(await database.db.selectFrom('content.region_bindings').select('facet_id').execute()).toEqual([]);
    expect(result.attempts).toContainEqual({ role: 'checks', kind: 'published', code: 'coverage_too_few_body_blocks' });
  });

  it('publishes without a planet or coverage when the lineage cannot be verified, and records why', async () => {
    // Fault injection in the real publication transaction: the stored production record turns into
    // a fixture record, which no attribution or coverage may rest on.
    await sql`create function content.ci_fixture_production() returns trigger language plpgsql as $$
      begin
        update content.asset_provenance
          set provenance=jsonb_set(provenance,'{production}','{"kind":"fixture","label":"CI fixture lineage"}')
        where asset_id=new.asset_id and revision=new.revision;
        return new;
      end $$`.execute(database.db);
    await sql`create trigger ci_fixture_production after insert on content.asset_provenance for each row execute function content.ci_fixture_production()`.execute(
      database.db,
    );
    const result = await publishing('tides').publish();
    expect(result.outcome).toBe('published');
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([]);
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([]);
    expect(result.attempts).toContainEqual({ role: 'checks', kind: 'published', code: 'attribution_unverified' });
  });
});
