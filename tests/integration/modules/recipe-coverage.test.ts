import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  readAdmittedCoverageMapping,
  readRegionEncounterCandidates,
} from '@knowscroll/backend/modules/content/nest-providers';
import { observedBindings } from '../../../packages/backend/src/modules/evidence/domain/coverage.js';
import { SCROLL_QUALIFICATION_POLICY_V0 } from '../../../packages/backend/src/modules/evidence/domain/policy.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import {
  answerWith,
  enableProductionScope,
  fixtureClaimSelection,
  fixtureProduction,
  fixtureWriterDraft,
} from '../support/generated-scroll.js';
import { baselineCapabilities } from '../support/scroll.js';

/**
 * Publishing a generated Scroll admits its topic and facet coverage in the same transaction, decided
 * by code from the recipe. The model is a labelled CI fixture; nothing here is provider output.
 */
describe('Generated Scroll coverage at publication (CI fixture transport, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recipe_coverage');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  /** Recipes that name one page, because the fixture serves a single research page. */
  function publishing(recipeKey: ScrollTopic) {
    expect(TOPICS[recipeKey].pages).toHaveLength(1);
    const run = fixtureProduction(database.db, (call) =>
      answerWith(call === 1 ? fixtureClaimSelection : fixtureWriterDraft(TOPICS[recipeKey].interactive)),
    );
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

  it.each(['seasons', 'seasons-limits', 'greenhouse'] as const)(
    'writes topic attribution and a facet mapping with the %s publication, and the consumers read them back',
    async (recipeKey) => {
      const recipe = TOPICS[recipeKey];
      const run = publishing(recipeKey);
      const result = await run.publish();
      expect(result).toMatchObject({ outcome: 'published', assetId: recipe.assetId, revision: 1 });
      expect(run.calls).toHaveLength(2);

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

  it('lets two recipes of one planet each add their own facets', async () => {
    await publishing('seasons').publish();
    await publishing('seasons-limits').publish();
    const person = await seedPerson(database.db);
    const candidatesFor = async (facetId: string) => {
      const regions = await withScope()(person.authority, (scope) =>
        readRegionEncounterCandidates(scope, {
          topicId: 'earth.seasons',
          facetId,
          truthStatus: 'factual',
          capabilities: baselineCapabilities,
        }),
      );
      if (regions.kind !== 'entered' || regions.value.kind !== 'read') throw new Error('regions not readable');
      return regions.value.candidates.map((candidate) => candidate.coverage.assetId).sort();
    };
    expect(await candidatesFor('earth.seasons.axial-tilt')).toEqual([TOPICS.seasons.assetId]);
    expect(await candidatesFor('earth.seasons.limits')).toEqual(
      [TOPICS.seasons.assetId, TOPICS['seasons-limits'].assetId].sort(),
    );
  });

  it('rolls publication back with the coverage write, then resumes the same paid writer without a resend', async () => {
    await sql`create function content.ci_fail_coverage() returns trigger language plpgsql as $$ begin raise exception 'CI_COVERAGE_FAILURE'; end $$`.execute(
      database.db,
    );
    await sql`create trigger ci_fail_coverage before insert on content.coverage_revisions for each row execute function content.ci_fail_coverage()`.execute(
      database.db,
    );
    const run = publishing('seasons');
    await expect(run.publish()).rejects.toThrow('CI_COVERAGE_FAILURE');
    expect(run.calls).toHaveLength(2);
    expect(await database.db.selectFrom('content.asset_revisions').select('asset_id').execute()).toEqual([]);
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([]);
    expect(
      await database.db.selectFrom('content.scroll_production_runs').select('state').executeTakeFirstOrThrow(),
    ).toEqual({ state: 'writer' });

    await sql`drop trigger ci_fail_coverage on content.coverage_revisions`.execute(database.db);
    expect((await run.publish(true)).outcome).toBe('published');
    expect(run.calls).toHaveLength(2);
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([
      { revision: 1 },
    ]);
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
    const result = await publishing('seasons').publish();
    expect(result.outcome).toBe('published');
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([
      { topic_id: 'earth.seasons' },
    ]);
    expect(await database.db.selectFrom('content.coverage_heads').select('revision').execute()).toEqual([]);
    expect(await database.db.selectFrom('content.region_bindings').select('facet_id').execute()).toEqual([]);
    expect(result.attempts).toContainEqual({ role: 'checks', kind: 'published', code: 'coverage_too_few_body_blocks' });
  });
});
