import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  admitLibraryContinuityUseCase,
  lockCurrentCoverageAuthorities,
  makeReviewGate,
  readAdmittedCoverageMapping,
  readDiscoveryCandidates,
  readExactEncounter,
  readLibraryStatus,
  readRegionEncounterCandidates,
  readSavedMetadata,
  readShareableContent,
} from '@knowscroll/backend/modules/content/nest-providers';
import { planLibraryProduction } from '@knowscroll/backend/modules/content';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { makeRenderScroll } from '../../../packages/backend/src/modules/content/adapters/render-scroll.js';
import { chooseScrollRecipe } from '../../../packages/backend/src/modules/content/adapters/production-state.js';
import {
  FIXTURE_SOURCE_V2,
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { scrollUseCases, textCapabilities } from '../support/scroll.js';
import { markScrollV1, v2Capabilities } from '../support/scroll-v2.js';

/**
 * The operator review gate for library v2 Scrolls (D-138). A v2 library recipe is produced through the
 * real production job, with a labelled CI fixture in place of the model and the invented planet Orrin in
 * place of any product content. Nothing here is provider output.
 */
describe('The review gate for library v2 Scrolls (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  const gate = () => makeReviewGate(database.db);
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 2000 });
  const operator = 'cli:ci-reviewer';

  beforeAll(async () => {
    database = await createTestDatabase<Database>('review_gate');
    await enableProductionScope(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** The page the fixture serves for a recipe URL: the Orrin page, and for a second URL a page of its own. */
  const orrinPageFor = (url: string) =>
    url === fixtureResearchPageV2.url
      ? fixtureResearchPageV2
      : extractResearch(
          `<html><title>CI fixture</title><main>${[...FIXTURE_SOURCE_V2, `This invented fixture page for ${url} adds nothing further about Orrin.`].map((text) => `<p>${text}</p>`).join('')}</main></html>`,
          url,
          '2026-10-20T00:00:00.000Z',
        );
  /** A production run whose writer answers with the Orrin v2 fixture, for a recipe the plan marks v2. */
  const producingV2 = () => fixtureProduction(database.db, () => answerWith(fixtureAuthoredV2()), orrinPageFor);
  /** A production run for a v1 recipe: the lighthouse fixture, in the format the recipe asks for. */
  const producingV1 = (key: ScrollTopic) =>
    fixtureProduction(database.db, () => answerWith(fixtureAuthored(writerFormatOf(TOPICS[key]))));

  const assetOf = (key: ScrollTopic) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision', 'availability_revision'])
      .where('id', '=', TOPICS[key].assetId)
      .executeTakeFirst();
  const reviewOf = (key: ScrollTopic, revision: number) =>
    database.db
      .selectFrom('content.revision_reviews')
      .selectAll()
      .where('asset_id', '=', TOPICS[key].assetId)
      .where('revision', '=', revision)
      .executeTakeFirst();
  const statusOf = async (key: ScrollTopic) => (await readLibraryStatus(database.db, [key]))[0];

  /** What a reader's discovery, exact reads, rendering, coverage and region reads hand out for one revision. */
  async function reachable(key: ScrollTopic, revision: number) {
    const recipe = TOPICS[key];
    const ref = { assetId: recipe.assetId, assetRevision: revision };
    const person = await seedPerson(database.db);
    const inScope = async <T>(work: (scope: Parameters<typeof readExactEncounter>[0]) => Promise<T>) => {
      const entered = await withScope()(person.authority, work);
      if (entered.kind !== 'entered') throw new Error('CI scope refused');
      return entered.value;
    };
    const discovered = await inScope((scope) =>
      readDiscoveryCandidates(scope, {
        languages: ['en'],
        formats: ['scroll'],
        capabilities: v2Capabilities,
        limit: 100,
      }),
    );
    const regions = await inScope((scope) =>
      readRegionEncounterCandidates(scope, {
        topicId: recipe.topicId,
        facetId: recipe.facetId,
        truthStatus: 'factual',
        capabilities: v2Capabilities,
      }),
    );
    const mapping = await inScope((scope) => readAdmittedCoverageMapping(scope, ref));
    const rendition = await makeRenderScroll(database.db)({
      assetId: recipe.assetId,
      revision,
      capabilities: v2Capabilities,
    });
    return {
      offered: discovered.filter((encounter) => encounter.assetId === recipe.assetId).map((e) => e.assetRevision),
      exact: (await inScope((scope) => readExactEncounter(scope, { ...ref, capabilities: v2Capabilities })))
        ?.assetRevision,
      rendered: rendition.kind === 'rendition',
      mapping: mapping.kind,
      regionCandidates:
        regions.kind === 'read'
          ? regions.candidates
              .filter((candidate) => candidate.encounter.assetId === recipe.assetId)
              .map((candidate) => candidate.encounter.assetRevision)
          : 'unsupported',
      locked: await inScope((scope) =>
        mapping.kind === 'mapped'
          ? lockCurrentCoverageAuthorities(scope, [mapping.head.authority])
          : lockCurrentCoverageAuthorities(scope, [
              { assetId: recipe.assetId, assetRevision: revision, headRevision: 1, mappingSha256: 'a'.repeat(64) },
            ]),
      ),
      shared: (await inScope((scope) => readShareableContent(scope, [ref])))[0]?.status,
      saved: (await inScope((scope) => readSavedMetadata(scope, [ref])))[0]?.availability,
    };
  }

  const invisible = {
    offered: [],
    exact: undefined,
    rendered: false,
    mapping: 'unavailable',
    regionCandidates: [],
    locked: false,
    shared: 'unavailable',
    saved: 'withdrawn',
  } as const;

  describe('a v2 recipe with no Scroll yet (seasons-hemispheres)', () => {
    const key = 'seasons-hemispheres';
    const assetId = TOPICS[key].assetId;

    it('is never commissioned by an ask, because no ask could be answered by a Scroll that waits for a read', async () => {
      const person = await seedPerson(database.db);
      for (const brief of [
        { topicId: TOPICS[key].topicId, facetId: TOPICS[key].facetId },
        { topicId: TOPICS[key].topicId },
      ]) {
        const chosen = await withScope()(person.authority, (scope) => chooseScrollRecipe(scope, brief));
        expect(chosen).toMatchObject({ kind: 'entered', value: { kind: 'none' } });
      }
      // A recipe of another planet is still chosen: the rule is about v2 recipes, not about asking.
      const other = await withScope()(person.authority, (scope) =>
        chooseScrollRecipe(scope, { topicId: TOPICS.tides.topicId, facetId: TOPICS.tides.facetId }),
      );
      expect(other).toMatchObject({ kind: 'entered', value: { kind: 'recipe', recipe: 'tides', take: 1 } });
    });

    it('ends production held: stored, with provenance and coverage, and reported as held rather than published', async () => {
      const run = producingV2();
      const result = await run.produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', held: true, assetId, revision: 1 });
      expect(run.calls).toHaveLength(1);

      expect(await assetOf(key)).toMatchObject({ status: 'held', revision: 1 });
      expect(await reviewOf(key, 1)).toMatchObject({ state: 'held', decided_at: null, decided_by: null, reason: null });
      const stored = await database.db
        .selectFrom('content.asset_revisions as revision')
        .innerJoin('content.asset_provenance as provenance', (join) =>
          join
            .onRef('provenance.asset_id', '=', 'revision.asset_id')
            .onRef('provenance.revision', '=', 'revision.revision'),
        )
        .select(['revision.document_version', 'provenance.provenance_version'])
        .where('revision.asset_id', '=', assetId)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({ document_version: 'scroll-document.v2', provenance_version: 'scroll-provenance.v2' });
      // The facets are mapped for the held revision, so the operator sees the planet would form.
      expect(
        (
          await database.db
            .selectFrom('content.coverage_heads')
            .select('revision')
            .where('asset_id', '=', assetId)
            .execute()
        ).length,
      ).toBe(1);
      expect(
        (
          await database.db
            .selectFrom('content.region_bindings')
            .select('facet_id')
            .where('asset_id', '=', assetId)
            .execute()
        ).map((row) => row.facet_id),
      ).toContain(TOPICS[key].facetId);
      expect(
        await database.db
          .selectFrom('content.encounter_topics')
          .select('topic_id')
          .where('asset_id', '=', assetId)
          .execute(),
      ).toEqual([{ topic_id: TOPICS[key].topicId }]);
      const job = await database.db
        .selectFrom('content.scroll_production_runs')
        .select(['state', 'outcomes'])
        .where('topic', '=', key)
        .executeTakeFirstOrThrow();
      expect(job.state).toBe('published');
      expect(JSON.stringify(job.outcomes)).toContain('held_for_review');
      expect(JSON.stringify(job.outcomes)).not.toContain('coverage_');
    });

    it('is not published as far as production-status goes, and produce-library neither sends it again nor asks for a second take', async () => {
      expect(await statusOf(key)).toMatchObject({ recipe: key, state: 'held', job: 'held', heldRevision: 1, takes: 1 });
      expect(await statusOf(key)).not.toHaveProperty('revision');
      const plan = planLibraryProduction([(await statusOf(key))!], { interactiveFirst: false });
      expect(plan.queue).toEqual([]);
      expect(plan.skipped).toEqual([{ recipe: key, reason: 'held' }]);
      // Asking for the next take, or for the same one again, stores nothing more.
      const again = producingV2();
      expect(await again.produce(key, false, signal(), true)).toMatchObject({ outcome: 'published' });
      expect(await again.produce(key, false, signal(), false, 2)).toMatchObject({ outcome: 'take_refused' });
      expect(again.calls).toHaveLength(0);
      expect(
        await database.db
          .selectFrom('content.asset_revisions')
          .select('revision')
          .where('asset_id', '=', assetId)
          .execute(),
      ).toEqual([{ revision: 1 }]);
      // Quartermaster does not pick a held recipe for a person's ask either.
      const person = await seedPerson(database.db);
      const chosen = await withScope()(person.authority, (scope) =>
        chooseScrollRecipe(scope, { topicId: TOPICS[key].topicId, facetId: TOPICS[key].facetId }),
      );
      expect(chosen).toMatchObject({ kind: 'entered', value: { kind: 'none' } });
    });

    it('is invisible to discovery, exact reads, rendering, coverage, regions, sharing and a series', async () => {
      expect(await reachable(key, 1)).toEqual(invisible);
      const asset = await database.db
        .selectFrom('content.assets')
        .select(['status'])
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow();
      expect(asset.status).not.toBe('admitted');
      // A person cannot open it: the asset is not admitted.
      const useCases = await scrollUseCases(database);
      try {
        const person = await seedPerson(database.db);
        expect(
          await useCases.openExposure(person.authority, {
            commandId: randomUUID(),
            target: { kind: 'scroll', assetId },
            origin: { kind: 'direct' },
            capabilities: v2Capabilities,
          }),
        ).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      } finally {
        await useCases.close();
      }
      // The series that would carry it is skipped whole while a part is held.
      const summary = await admitLibraryContinuityUseCase(database.db)({ dryRun: false });
      expect(JSON.stringify(summary)).toContain(key);
      expect(
        await database.db
          .selectFrom('content.series_units')
          .select('asset_id')
          .where('asset_id', '=', assetId)
          .execute(),
      ).toEqual([]);
    });

    it('lists the held revision for the operator with counts and no body text, and shows the text to read', async () => {
      const listed = await gate().list({ all: false });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        assetId,
        recipe: key,
        revision: 1,
        state: 'held',
        coverage: 'mapped',
        servedRevision: null,
        hasPicture: true,
        decidedBy: null,
      });
      expect(listed[0]!.words).toBeGreaterThan(300);
      const document = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', assetId)
        .executeTakeFirstOrThrow();
      const firstStop = (document.document as { stops: { blocks: { text: string }[] }[] }).stops[0]!.blocks[0]!.text;
      expect(JSON.stringify(listed)).not.toContain(firstStop.slice(0, 40));

      const shown = await gate().show({ assetId, withSources: true });
      if (shown.kind !== 'shown') throw new Error('CI expected the text');
      expect(shown.text).toContain(firstStop);
      expect(shown.text).toContain('> source passage:');
      expect(shown.listing.revision).toBe(1);
      expect(await gate().show({ assetId: randomUUID(), withSources: false })).toEqual({
        kind: 'refused',
        reason: 'not_under_review',
      });
    });

    it('is served once an operator releases exactly that revision, and a repeat changes nothing', async () => {
      const before = await assetOf(key);
      expect(await gate().release({ assetId, revision: 2, decidedBy: operator })).toEqual({
        kind: 'refused',
        reason: 'not_under_review',
      });
      expect(await assetOf(key)).toEqual(before);

      expect(await gate().release({ assetId, revision: 1, decidedBy: operator })).toEqual({
        kind: 'released',
        assetId,
        revision: 1,
        replacedRevision: null,
      });
      const released = await reviewOf(key, 1);
      expect(released).toMatchObject({ state: 'released', decided_by: operator, reason: null });
      expect(released?.decided_at).toBeInstanceOf(Date);
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
      expect((await assetOf(key))!.availability_revision).toBeGreaterThan(before!.availability_revision);

      expect(await reachable(key, 1)).toEqual({
        offered: [1],
        exact: 1,
        rendered: true,
        mapping: 'mapped',
        regionCandidates: [1],
        locked: true,
        shared: 'available',
        saved: 'available',
      });
      expect(await statusOf(key)).toMatchObject({ state: 'published', assetId, revision: 1 });
      expect(await gate().list({ all: false })).toEqual([]);

      // Releasing again changes nothing: not the state, not who or when, not the asset.
      const after = await assetOf(key);
      expect(await gate().release({ assetId, revision: 1, decidedBy: 'cli:someone-else' })).toMatchObject({
        kind: 'already_released',
        revision: 1,
      });
      expect(await reviewOf(key, 1)).toEqual(released);
      expect(await assetOf(key)).toEqual(after);

      const audit = await gate().list({ all: true });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ state: 'released', decidedBy: operator, servedRevision: 1 });
      // A served revision cannot be rejected afterwards.
      expect(await gate().reject({ assetId, revision: 1, reason: 'too late', decidedBy: operator })).toEqual({
        kind: 'refused',
        reason: 'revision_released',
      });
    });
  });

  describe('a v2 recipe that already serves a v1 Scroll (seasons)', () => {
    const key = 'seasons';
    const assetId = TOPICS[key].assetId;

    it('keeps serving the v1 revision while the v2 one is held, and shows the held one to nobody', async () => {
      const undo = markScrollV1(key);
      try {
        expect(await producingV1(key).produce(key, false, signal())).toMatchObject({
          outcome: 'published',
          revision: 1,
        });
      } finally {
        undo();
      }
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
      // The plan marks the recipe v2 again, so the v1 Scroll does not count as published.
      expect(await statusOf(key)).toMatchObject({ state: 'not_started' });

      const run = producingV2();
      const result = await run.produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', held: true, assetId, revision: 2 });
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
      expect(await reviewOf(key, 2)).toMatchObject({ state: 'held' });
      expect(await reviewOf(key, 1)).toBeUndefined();
      expect(await statusOf(key)).toMatchObject({ state: 'held', heldRevision: 2 });

      expect(await reachable(key, 2)).toEqual({ ...invisible, offered: [1], regionCandidates: [1] });
      const v1 = await reachable(key, 1);
      expect(v1).toMatchObject({ offered: [1], exact: 1, rendered: true, mapping: 'mapped' });
      // A person who opens it is given the v1 revision, never the held one.
      const useCases = await scrollUseCases(database);
      try {
        const person = await seedPerson(database.db);
        const opened = await useCases.openExposure(person.authority, {
          commandId: randomUUID(),
          target: { kind: 'scroll', assetId },
          origin: { kind: 'direct' },
          capabilities: textCapabilities,
        });
        if (opened.kind !== 'opened') throw new Error('CI open refused');
        expect(opened.outcome.assetRevision).toBe(1);
      } finally {
        await useCases.close();
      }
    });

    it('lists it with the revision it would replace', async () => {
      const listed = await gate().list({ all: false });
      expect(listed.filter((entry) => entry.recipe === key)).toMatchObject([
        { revision: 2, state: 'held', servedRevision: 1, coverage: 'mapped' },
      ]);
    });

    it('moves the served revision to the released one and keeps the old revision readable by its own references', async () => {
      expect(await gate().release({ assetId, revision: 2, decidedBy: operator })).toEqual({
        kind: 'released',
        assetId,
        revision: 2,
        replacedRevision: 1,
      });
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 2 });
      expect(await reachable(key, 2)).toMatchObject({
        exact: 2,
        rendered: true,
        mapping: 'mapped',
        regionCandidates: [2],
      });
      expect(await statusOf(key)).toMatchObject({ state: 'published', revision: 2 });
      // An earlier revision cannot be released over a newer one.
      expect(await gate().release({ assetId, revision: 1, decidedBy: operator })).toEqual({
        kind: 'refused',
        reason: 'not_under_review',
      });
    });
  });

  describe('a rejection', () => {
    const key = 'seasons-limits';
    const assetId = TOPICS[key].assetId;

    it('keeps a held revision of a served Scroll out, leaves the earlier revision served, and frees the next take', async () => {
      const undo = markScrollV1(key);
      try {
        expect(await producingV1(key).produce(key, false, signal())).toMatchObject({
          outcome: 'published',
          revision: 1,
        });
      } finally {
        undo();
      }
      expect(await producingV2().produce(key, false, signal())).toMatchObject({ held: true, revision: 2 });
      expect(await gate().reject({ assetId, revision: 2, reason: '   ', decidedBy: operator })).toEqual({
        kind: 'refused',
        reason: 'reason_invalid',
      });
      expect(await reviewOf(key, 2)).toMatchObject({ state: 'held' });

      expect(
        await gate().reject({ assetId, revision: 2, reason: 'A claim is not in the cited page.', decidedBy: operator }),
      ).toEqual({ kind: 'rejected', assetId, revision: 2 });
      expect(await reviewOf(key, 2)).toMatchObject({
        state: 'rejected',
        reason: 'A claim is not in the cited page.',
        decided_by: operator,
      });
      // The previous revision stays served, and the rejected one is still reachable by nobody.
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
      expect(await reachable(key, 2)).toEqual({ ...invisible, offered: [1], regionCandidates: [1] });
      expect(await reachable(key, 1)).toMatchObject({ offered: [1], exact: 1 });
      // Rejected is final: it is never released, and repeating the rejection keeps the first reason.
      expect(await gate().release({ assetId, revision: 2, decidedBy: operator })).toEqual({
        kind: 'refused',
        reason: 'revision_rejected',
      });
      expect(await gate().reject({ assetId, revision: 2, reason: 'another reason', decidedBy: 'cli:other' })).toEqual({
        kind: 'already_rejected',
        assetId,
        revision: 2,
      });
      expect((await reviewOf(key, 2))?.reason).toBe('A claim is not in the cited page.');
      expect(await gate().list({ all: false })).toEqual([]);
      expect((await gate().list({ all: true })).filter((entry) => entry.recipe === key)).toMatchObject([
        { revision: 2, state: 'rejected', reason: 'A claim is not in the cited page.', decidedBy: operator },
      ]);

      // Production may write it again: the rejected take is spent, the next take stores the next revision.
      expect(await statusOf(key)).toMatchObject({ state: 'retryable', job: 'rejected', takes: 1 });
      const plan = planLibraryProduction([(await statusOf(key))!], { interactiveFirst: false });
      expect(plan.queue).toEqual([{ recipe: key, take: 2 }]);
      const second = producingV2();
      expect(await second.produce(key, false, signal(), false, 2)).toMatchObject({
        outcome: 'published',
        held: true,
        revision: 3,
        take: 2,
      });
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
      expect(await statusOf(key)).toMatchObject({ state: 'held', heldRevision: 3, takes: 2 });
      expect(await gate().release({ assetId, revision: 3, decidedBy: operator })).toMatchObject({
        kind: 'released',
        replacedRevision: 1,
      });
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 3 });
    });
  });

  describe('a rejection of the only revision', () => {
    const key = 'seasons-elsewhere';
    const assetId = TOPICS[key].assetId;

    it('leaves the asset held and unreachable, and a later take can still be released', async () => {
      const plain = fixtureAuthoredV2();
      // The recipe is a plain Scroll, so the fixture's picture is taken out the way a writer would write none.
      const withoutPicture = JSON.parse(JSON.stringify(plain)) as { items: { stage?: unknown }[] };
      for (const item of withoutPicture.items) delete item.stage;
      const run = fixtureProduction(database.db, () => answerWith(withoutPicture), orrinPageFor);
      const first = await run.produce(key, false, signal());
      expect(first).toMatchObject({ outcome: 'published', held: true, revision: 1 });
      expect(await assetOf(key)).toMatchObject({ status: 'held', revision: 1 });
      expect(
        await gate().reject({ assetId, revision: 1, reason: 'Uranus is described wrongly.', decidedBy: operator }),
      ).toMatchObject({
        kind: 'rejected',
      });
      expect(await assetOf(key)).toMatchObject({ status: 'held', revision: 1 });
      expect(await reachable(key, 1)).toEqual(invisible);
      expect(await statusOf(key)).toMatchObject({ state: 'retryable' });

      expect(await run.produce(key, false, signal(), false, 2)).toMatchObject({ held: true, revision: 2, take: 2 });
      expect(await assetOf(key)).toMatchObject({ status: 'held', revision: 1 });
      expect(await reachable(key, 2)).toEqual(invisible);
      expect(await gate().release({ assetId, revision: 2, decidedBy: operator })).toEqual({
        kind: 'released',
        assetId,
        revision: 2,
        replacedRevision: null,
      });
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 2 });
      expect(await reachable(key, 2)).toMatchObject({ offered: [2], exact: 2, rendered: true });
      // The rejected revision is still not served.
      expect(await reachable(key, 1)).toMatchObject({ exact: undefined, rendered: false, mapping: 'unavailable' });
    });
  });

  describe('what the gate leaves alone', () => {
    it('publishes a v1 recipe straight to admitted, with no review row, as it always did', async () => {
      const key = 'greenhouse';
      const result = await producingV1(key).produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', revision: 1 });
      expect(result).not.toHaveProperty('held');
      expect(await assetOf(key)).toMatchObject({ status: 'admitted', revision: 1 });
      expect(await reviewOf(key, 1)).toBeUndefined();
      expect(await statusOf(key)).toMatchObject({ state: 'published', revision: 1 });
    });

    it('refuses to release a revision that never went through the gate', async () => {
      expect(await gate().release({ assetId: TOPICS.greenhouse.assetId, revision: 1, decidedBy: operator })).toEqual({
        kind: 'refused',
        reason: 'not_under_review',
      });
    });

    it('keeps the table honest: a rejection needs a reason, and a decision needs who and when', async () => {
      const assetId = TOPICS['seasons-hemispheres'].assetId;
      await expect(
        sql`update content.revision_reviews set state = 'rejected' where asset_id = ${assetId}::uuid and revision = 1`.execute(
          database.db,
        ),
      ).rejects.toThrow();
      await expect(
        sql`update content.revision_reviews set decided_by = null where asset_id = ${assetId}::uuid and revision = 1`.execute(
          database.db,
        ),
      ).rejects.toThrow();
      await expect(
        sql`update content.revision_reviews set state = 'held' where asset_id = ${assetId}::uuid and revision = 1`.execute(
          database.db,
        ),
      ).rejects.toThrow();
    });
  });
});
