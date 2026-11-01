import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  admitLibraryContinuityUseCase,
  makeReviewGate,
  readDiscoveryCandidates,
  readLibraryStatus,
  readAdmittedCoverageMapping,
} from '@knowscroll/backend/modules/content/nest-providers';
import { ExposureDocumentResponseSchema } from '@knowscroll/contracts';
import { parseDocumentV2, SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import { makeRenderScroll } from '../../../packages/backend/src/modules/content/adapters/render-scroll.js';
import { WRITER_V2_PROMPT_VERSION } from '../../../packages/backend/src/modules/content/production/writer-v2.js';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { scrollUseCases, textCapabilities } from '../support/scroll.js';
import { markScrollV1, markScrollV2, v2Capabilities } from '../support/scroll-v2.js';

/**
 * A v2 Scroll is published through the production job, covered, served and read like a v1 one.
 * The model is a labelled CI fixture and the Scroll is the authored Orrin fixture: no provider,
 * no product content.
 */
describe('Publishing a v2 Scroll (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('scroll_v2_admission');
    await enableProductionScope(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const revisionsOf = (assetId: string) =>
    database.db
      .selectFrom('content.asset_revisions')
      .select(['revision', 'document_version', 'document', 'reading_facts'])
      .where('asset_id', '=', assetId)
      .orderBy('revision')
      .execute();

  it('regenerates a v1 Seasons Scroll as a v2 revision, with coverage v2, provenance for its citations and a real status', async () => {
    const recipe = TOPICS.seasons;
    // The Scroll the library held before the plan marked the recipe v2 (D-137): a v1 revision.
    const undoV1 = markScrollV1('seasons');
    try {
      const v1 = fixtureProduction(database.db, () => answerWith(fixtureAuthored('diagram')));
      expect(await v1.produce('seasons', false, signal())).toMatchObject({ outcome: 'published', revision: 1 });
      expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'published', revision: 1 });
    } finally {
      undoV1();
    }

    // A v1 Scroll does not satisfy a recipe the plan marks v2: the recipe is produced again.
    expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'not_started' });
    const v2 = fixtureProduction(
      database.db,
      () => answerWith(fixtureAuthoredV2()),
      () => fixtureResearchPageV2,
    );
    const result = await v2.produce('seasons', false, signal());
    // One writer request, no repair, and the revision is the next of the same asset. It is held for review (D-138).
    expect(result).toMatchObject({ outcome: 'published', held: true, assetId: recipe.assetId, revision: 2 });
    expect(v2.calls).toHaveLength(1);
    expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'held', heldRevision: 2 });
    const job = await database.db
      .selectFrom('content.scroll_production_runs')
      .select(['policy_version', 'state'])
      .where('topic', '=', 'seasons')
      .orderBy('policy_version')
      .execute();
    expect(job).toEqual([
      { policy_version: 'scroll-production.v14', state: 'published' },
      { policy_version: 'scroll-production.v20', state: 'published' },
    ]);

    const [first, second] = await revisionsOf(recipe.assetId);
    expect(first).toMatchObject({ revision: 1, document_version: 'scroll-document.v1' });
    expect(second).toMatchObject({ revision: 2, document_version: SCROLL_DOCUMENT_V2_SCHEMA_VERSION });
    for (const hidden of ['claims', 'sources', 'citations', 'production'])
      expect(second?.document).not.toHaveProperty(hidden);
    const facts = second?.reading_facts as { v: number; blocks: { id: string; type: string }[]; nested: unknown[] };
    expect(facts).toMatchObject({ v: 3, nested: [] });
    expect([...new Set(facts.blocks.map((block) => block.type))].sort()).toEqual(['call_it', 'final_call', 'stop']);

    // Provenance: every stop, aside and the recap cites claims that are the exact source passages.
    const stored = await database.db
      .selectFrom('content.asset_provenance')
      .select(['provenance_version', 'provenance'])
      .where('asset_id', '=', recipe.assetId)
      .where('revision', '=', 2)
      .executeTakeFirstOrThrow();
    expect(stored.provenance_version).toBe('scroll-provenance.v2');
    const provenance = ScrollProvenanceV2.parse(stored.provenance);
    expect(provenance.production).toMatchObject({
      kind: 'model',
      model: 'MiniMax-M3.1-Flash',
      promptVersion: WRITER_V2_PROMPT_VERSION,
    });
    const partIds = provenance.citations.map((entry) => entry.partId);
    expect(partIds).toEqual(expect.arrayContaining([...facts.blocks.map((block) => block.id), 'recap']));
    const claimIds = new Set(provenance.claims.map((claim) => claim.claimId));
    for (const entry of provenance.citations) for (const id of entry.claimIds) expect(claimIds.has(id)).toBe(true);
    for (const claim of provenance.claims)
      expect(fixtureResearchPageV2.passages.some((passage) => passage.text === claim.quote)).toBe(true);
    expect(provenance.sources).toHaveLength(1);

    // Coverage: decided by code at publication, over the read stops only, next to the v1 head.
    const heads = await database.db
      .selectFrom('content.coverage_revisions')
      .select(['asset_revision', 'status', 'semantic_review_reference', 'mapping'])
      .where('asset_id', '=', recipe.assetId)
      .orderBy('asset_revision')
      .execute();
    expect(heads.map((head) => [head.asset_revision, head.status, head.semantic_review_reference])).toEqual([
      [1, 'active', `scroll-recipe-coverage.v1:${recipe.explanationUnitId}`],
      [2, 'active', `scroll-recipe-coverage.v2:${recipe.explanationUnitId}`],
    ]);
    const mapping = heads[1]?.mapping as {
      readingFactsVersion: number;
      bindings: { facetId: string; requiredBlockIds: string[] }[];
    };
    expect(mapping.readingFactsVersion).toBe(3);
    expect(mapping.bindings.map((binding) => binding.facetId)).toEqual([recipe.facetId, recipe.supportingFacetId]);
    const stops = new Set(facts.blocks.filter((block) => block.type === 'stop').map((block) => block.id));
    for (const binding of mapping.bindings) for (const id of binding.requiredBlockIds) expect(stops.has(id)).toBe(true);
    expect(mapping.bindings[0]?.requiredBlockIds.length).toBeGreaterThanOrEqual(3);
    const bound = await database.db
      .selectFrom('content.region_bindings')
      .select(['asset_revision', 'facet_id'])
      .where('asset_id', '=', recipe.assetId)
      .where('asset_revision', '=', 2)
      .execute();
    expect(bound.map((row) => row.facet_id).sort()).toEqual([recipe.facetId, recipe.supportingFacetId].sort());
    // Nobody can read the coverage of a held revision; once an operator releases it, the same mapping is served.
    const person = await seedPerson(database.db);
    const readMapping = () =>
      makeWithPersonalScope(database.db, { lockTimeoutMs: 2000 })(person.authority, (scope) =>
        readAdmittedCoverageMapping(scope, { assetId: recipe.assetId, assetRevision: 2 }),
      );
    expect(await readMapping()).toMatchObject({ kind: 'entered', value: { kind: 'unavailable' } });
    expect(
      await makeReviewGate(database.db).release({ assetId: recipe.assetId, revision: 2, decidedBy: 'cli:ci-reviewer' }),
    ).toMatchObject({ kind: 'released', replacedRevision: 1 });
    expect(await readMapping()).toMatchObject({ kind: 'entered', value: { kind: 'mapped' } });
    expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'published', revision: 2 });
  });

  it('serves the v2 document to a client that declares the schema, and a v1 revision to one that does not', async () => {
    const recipe = TOPICS.seasons;
    const render = makeRenderScroll(database.db);
    const rendition = await render({ assetId: recipe.assetId, revision: 2, capabilities: v2Capabilities });
    if (rendition.kind !== 'rendition') throw new Error('CI expected a rendition');
    expect(rendition.degradedEssential).toEqual([]);
    expect(await render({ assetId: recipe.assetId, revision: 2, capabilities: textCapabilities })).toEqual({
      kind: 'cannot_render',
      reason: 'unsupported_document',
    });
    expect(await render({ assetId: recipe.assetId, revision: 1, capabilities: textCapabilities })).toMatchObject({
      kind: 'rendition',
    });

    // The wire contract accepts it and the client path parses it again, verifying measures and hash.
    const wire = ExposureDocumentResponseSchema.parse({
      exposureId: '00000000-0000-4000-8000-000000000001',
      assetId: recipe.assetId,
      assetRevision: 2,
      document: JSON.parse(JSON.stringify(rendition.document)) as unknown,
      degradedEssential: [],
    });
    expect(parseDocumentV2(wire.document, { verify: true }).kind).toBe('valid');

    // Discovery offers each client the revision it can render; an asset with none is not offered.
    const person = await seedPerson(database.db);
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 2000 });
    const offered = async (capabilities: typeof textCapabilities) => {
      const entered = await withScope(person.authority, (scope) =>
        readDiscoveryCandidates(scope, { languages: ['en'], formats: ['scroll'], capabilities, limit: 10 }),
      );
      if (entered.kind !== 'entered') throw new Error('CI scope refused');
      return entered.value.filter((encounter) => encounter.assetId === recipe.assetId);
    };
    expect((await offered(v2Capabilities)).map((encounter) => encounter.assetRevision)).toEqual([2]);
    expect((await offered(textCapabilities)).map((encounter) => encounter.assetRevision)).toEqual([1]);
  });

  it('opens the v2 revision and reads its document through the experience use cases', async () => {
    const useCases = await scrollUseCases(database);
    try {
      const person = await seedPerson(database.db);
      const open = (capabilities: typeof textCapabilities) =>
        useCases.openExposure(person.authority, {
          commandId: randomUUID(),
          target: { kind: 'scroll', assetId: TOPICS.seasons.assetId },
          origin: { kind: 'direct' },
          capabilities,
        });
      const opened = await open(v2Capabilities);
      if (opened.kind !== 'opened') throw new Error('CI open refused');
      expect(opened.outcome.assetRevision).toBe(2);
      const read = await useCases.readExposureDocument(person.authority, opened.outcome.exposureId);
      if (read.kind !== 'document') throw new Error('CI expected the document');
      expect(read.document.schemaVersion).toBe(SCROLL_DOCUMENT_V2_SCHEMA_VERSION);
      expect(read.degradedEssential).toEqual([]);
      for (const internal of ['claimId', 'citations', 'scroll-provenance', '"production"', 'snapshotSha256'])
        expect(JSON.stringify(read.document)).not.toContain(internal);

      // A client that did not declare the schema is told it cannot render this revision.
      const old = await open(textCapabilities);
      if (old.kind !== 'opened') throw new Error('CI open refused');
      expect(await useCases.readExposureDocument(person.authority, old.outcome.exposureId)).toMatchObject({
        kind: 'refused',
        reason: 'cannot_render',
        cannotRender: 'unsupported_document',
      });
    } finally {
      await useCases.close();
    }
  });

  it('refuses a v2 recipe whose misconception source no person has reviewed before any job or request', async () => {
    const undo = markScrollV2('greenhouse', {
      variant: 'stage',
      misconception: {
        kind: 'myth',
        claim: 'Orrin is warmest because it is closest to its star.',
        source: { label: 'A common idea; its source is still to be named', reviewed: false },
      },
    });
    try {
      const run = fixtureProduction(
        database.db,
        () => answerWith(fixtureAuthoredV2()),
        () => fixtureResearchPageV2,
      );
      const result = await run.produce('greenhouse', false, signal());
      expect(result).toMatchObject({ outcome: 'plan_refused', codes: ['misconception_source_unreviewed'] });
      // Nothing was sent, no job row was reserved, and nothing was stored.
      expect(run.calls).toHaveLength(0);
      expect(
        await database.db
          .selectFrom('content.scroll_production_runs')
          .select('id')
          .where('topic', '=', 'greenhouse')
          .execute(),
      ).toEqual([]);
      expect(await revisionsOf(TOPICS.greenhouse.assetId)).toEqual([]);
      // The operator's status and the Quartermaster see a recipe no take can start.
      expect((await readLibraryStatus(database.db, ['greenhouse']))[0]).toMatchObject({ state: 'stopped' });
    } finally {
      undo();
    }
  });

  it('counts a series total from its admitted units, over the v2 part the gate released and v1 parts', async () => {
    // The other two parts stay v1 here (a recipe the plan does not mark v2 is produced as it always was).
    for (const key of ['seasons-hemispheres', 'seasons-elsewhere'] as const) {
      const undo = markScrollV1(key);
      try {
        const run = fixtureProduction(database.db, () => answerWith(fixtureAuthored(writerFormatOf(TOPICS[key]))));
        expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', revision: 1 });
      } finally {
        undo();
      }
      expect((await revisionsOf(TOPICS[key].assetId))[0]).toMatchObject({ document_version: 'scroll-document.v1' });
    }
    const admitted = await admitLibraryContinuityUseCase(database.db)({ dryRun: false });
    expect(admitted.seriesRevisionsAdmitted).toBeGreaterThan(0);
    const units = await database.db
      .selectFrom('content.series_units')
      .select(['series_id', 'asset_revision'])
      .execute();
    const seasons = units.filter((unit) => unit.series_id === 'library.earth.seasons');
    expect(seasons).toHaveLength(3);
    // Part 1 is the v2 revision the library holds now.
    expect(seasons.map((unit) => unit.asset_revision).sort()).toEqual([1, 1, 2]);
  });
});
