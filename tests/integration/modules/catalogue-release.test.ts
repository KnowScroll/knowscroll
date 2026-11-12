import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { CatalogueSnapshot } from '@knowscroll/backend/modules/content';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  appendRelease,
  catalogueStatus,
  makeCatalogue,
  makeReadAdmittedCoverageMapping,
  planCoverageCatalogue,
  readCatalogueIn,
  readReleasedCoverage,
  readmitCoverageUseCase,
  makeReviewGate,
  showServableTopics,
  syncCatalogue,
} from '@knowscroll/backend/modules/content/nest-providers';
import { stableUuid } from '../../../packages/backend/src/infrastructure/ids/index.js';
import {
  RELEASE_1_COUNTS,
  RELEASE_1_DIGEST,
  RELEASE_1_PLAN,
} from '../../../packages/backend/src/modules/content/domain/catalogue/release-1.fixture.js';
import { seedSnapshot } from '../../../packages/backend/src/modules/content/domain/catalogue/seed.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson } from '../support/fixtures.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { orrinResearchFor, plainOrrin } from '../support/scroll-v2.js';
import { authoredWorld, geographyReader, seedAuthoredGeography } from '../support/visit-world.js';

type Draft = Extract<Parameters<typeof appendRelease>[1][number], { readonly kind: 'add' }>['draft'];

/** Release 1 as the migration seeded it, from the frozen copy of the plan: never from the plan in code, which keeps growing. */
const releaseOne = () => seedSnapshot(RELEASE_1_PLAN, canonicalSha256);

const draft = (id: string, kind: 'topic' | 'facet', parentId: string, label: string, meaning: string): Draft => ({
  id,
  kind,
  parentId,
  label,
  meaning,
  sceneFamily: null,
  haze: null,
  sameMeaningAs: [],
});

const VOLCANOES = [
  draft('earth.volcanoes', 'topic', 'earth', 'Volcanoes', 'How volcanoes build and reshape land.'),
  draft('earth.volcanoes.magma', 'facet', 'earth.volcanoes', 'Magma', 'Magma rises through the crust and erupts.'),
  draft(
    'earth.volcanoes.plates',
    'facet',
    'earth.volcanoes',
    'Plates',
    'Plate boundaries decide where volcanoes form.',
  ),
] as const;

/** A concept of the library plan as an authored node, for a revision of it. */
function nodeOf(snapshot: CatalogueSnapshot, topicId: string, facetId: string): Draft {
  const facet = snapshot.concept(topicId)!.facets.find((entry) => entry.id === facetId)!;
  return draft(facet.id, 'facet', topicId, facet.label, facet.meaning);
}

/**
 * The topic catalogue as data (#674, slice 2.1, D-419) on a real PostgreSQL: the migration seeds the plan exactly, a release adds a
 * topic with no deploy and nobody's places or certificates change, a topic is not servable until the library has released
 * supply for it, and a wording-only revision keeps certificates valid while a semantic change does not. The model, the pages
 * and every Scroll are labelled CI fixtures about an invented planet: nothing here is provider output or product data.
 */
describe('The topic catalogue as data (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  const db = () => database.db;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const live = () => makeCatalogue(db(), { revalidateMs: 0, background: false });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('catalogue_release');
    await enableProductionScope(db());
  });
  afterAll(async () => {
    await database.drop();
  });

  describe('the migration seeds the library plan exactly (catalogue-equivalence)', () => {
    it('holds release 1 with six systems, seventeen topics and fifty-three facets, and nothing waits for supply', async () => {
      const counts = await sql<{ kind: string; n: string }>`
        select kind, count(*) as n from content.concept_nodes group by kind order by kind`.execute(db());
      expect(counts.rows.map((row) => [row.kind, Number(row.n)])).toEqual([
        ['facet', RELEASE_1_COUNTS.facets],
        ['system', RELEASE_1_COUNTS.systems],
        ['topic', RELEASE_1_COUNTS.topics],
      ]);
      expect(
        (await db().selectFrom('content.concept_current').select('release_id').executeTakeFirstOrThrow()).release_id,
      ).toBe(1);
      expect(
        (
          await db().selectFrom('content.concept_nodes').select('visible_in').where('kind', '=', 'topic').execute()
        ).every((row) => row.visible_in === 1),
      ).toBe(true);
      expect(await catalogueStatus(db())).toMatchObject({
        releaseId: 1,
        systems: RELEASE_1_COUNTS.systems,
        topics: RELEASE_1_COUNTS.topics,
        facets: RELEASE_1_COUNTS.facets,
        servableTopics: RELEASE_1_COUNTS.topics,
        waitingTopics: 0,
      });
    });

    it('reads every value from the database exactly as the frozen release-1 plan gave it: ids, order, meanings, labels, looks, digests', async () => {
      const stored = await readCatalogueIn(db());
      const plan = releaseOne();
      expect(stored.releaseId).toBe(plan.releaseId);
      expect(stored.digest).toBe(RELEASE_1_DIGEST);
      expect(stored.digest).toBe(plan.digest);
      expect(stored.all()).toEqual(plan.all());
      expect(stored.systems()).toEqual(plan.systems());
      expect(stored.topics()).toEqual(plan.topics());
      for (const concept of plan.all()) {
        expect(stored.systemOf(concept.id)).toBe(plan.systemOf(concept.id));
        expect(stored.label(concept.id)).toBe(plan.label(concept.id));
        expect(stored.sceneFamilyOf(concept.id)).toBe(plan.sceneFamilyOf(concept.id));
        expect(stored.hazeOf(concept.id)).toBe(plan.hazeOf(concept.id));
        expect(stored.children(concept.id)).toEqual(plan.children(concept.id));
        for (const facet of concept.facets) {
          expect(stored.meaning(concept.id, facet.id)).toEqual(plan.meaning(concept.id, facet.id));
          expect(stored.meaningSha256(concept.id, facet.id)).toBe(plan.meaningSha256(concept.id, facet.id));
          expect(stored.label(concept.id, facet.id)).toBe(plan.label(concept.id, facet.id));
        }
      }
    });

    it('is what `content catalogue sync` finds in that plan: nothing to import, nothing to make servable, nothing missing', async () => {
      const dry = await syncCatalogue(db(), { dryRun: true }, RELEASE_1_PLAN);
      expect(dry).toMatchObject({
        plan: 'unchanged',
        missingFromPlan: 0,
        nowServable: 0,
        releaseBefore: 1,
        releaseAfter: 1,
      });
      const real = await syncCatalogue(db(), { dryRun: false }, RELEASE_1_PLAN);
      expect(real).toMatchObject({
        plan: 'unchanged',
        releaseBefore: 1,
        releaseAfter: 1,
        digestAfter: RELEASE_1_DIGEST,
      });
      expect((await db().selectFrom('content.concept_releases').select('release_id').execute()).length).toBe(1);
    });
  });

  describe('the database keeps a release, a revision and a node’s identity', () => {
    const refused = async (statement: RawBuilder<unknown>) => {
      await expect(statement.execute(db())).rejects.toMatchObject({
        message: expect.stringContaining('CONTENT_CONCEPT') as string,
      });
    };

    it('refuses to rewrite or delete a release or a revision, to change a node’s identity or place, or to move the pointer back', async () => {
      await refused(
        sql`update content.concept_node_revisions set meaning = 'A meaning rewritten in place, long enough.' where node_id = 'earth'`,
      );
      await refused(sql`delete from content.concept_node_revisions where node_id = 'earth'`);
      await refused(sql`update content.concept_releases set digest = ${'0'.repeat(64)} where release_id = 1`);
      await refused(sql`delete from content.concept_releases where release_id = 1`);
      await refused(sql`update content.concept_nodes set seq = 999 where node_id = 'earth'`);
      await refused(sql`update content.concept_nodes set parent_id = 'space' where node_id = 'earth.tides'`);
      await refused(sql`update content.concept_nodes set visible_in = null where node_id = 'earth.tides'`);
      await refused(sql`delete from content.concept_nodes where node_id = 'earth.tides.coasts'`);
      await expect(sql`update content.concept_current set release_id = 0`.execute(db())).rejects.toBeDefined();
    });

    it('refuses a node or a revision introduced at or below the release the pointer names, and a show or a retirement it has already passed', async () => {
      // A release that exists never grows: rows for release 1 are refused while the pointer is at 1, whatever their shape.
      await refused(
        sql`insert into content.concept_nodes (node_id, kind, parent_id, seq, introduced_in) values ('earth.late', 'topic', 'earth', 902, 1)`,
      );
      await refused(
        sql`insert into content.concept_node_revisions (node_id, revision, introduced_in, label, meaning, meaning_sha256)
          values ('earth', 2, 1, 'Earth', 'A second revision of the earth system.', ${'a'.repeat(64)})`,
      );
      await refused(
        sql`update content.concept_nodes set status = 'retired', retired_in = 1 where node_id = 'earth.tides'`,
      );
      expect(await readCatalogueIn(db())).toMatchObject({ releaseId: 1 });
      expect((await readCatalogueIn(db())).has('earth.late')).toBe(false);
    });

    it('refuses a node that breaks the shape of an id or a facet with no topic, in the release that is next', async () => {
      const inNextRelease = async (insertNode: RawBuilder<unknown>, constraint: string) => {
        await expect(
          db()
            .transaction()
            .execute(async (trx) => {
              await sql`insert into content.concept_releases (release_id, digest, source)
                select max(release_id) + 1, ${'b'.repeat(64)}, 'operator' from content.concept_releases`.execute(trx);
              await insertNode.execute(trx);
            }),
        ).rejects.toMatchObject({ message: expect.stringContaining(constraint) as string });
      };
      await inNextRelease(
        sql`insert into content.concept_nodes (node_id, kind, parent_id, seq, introduced_in)
          values ('Bad Id', 'topic', 'earth', 900, (select max(release_id) from content.concept_releases))`,
        'concept_nodes_id_check',
      );
      await inNextRelease(
        sql`insert into content.concept_nodes (node_id, kind, parent_id, seq, introduced_in)
          values ('lonely', 'facet', null, 901, (select max(release_id) from content.concept_releases))`,
        'concept_nodes_parent_check',
      );
    });
  });

  describe('a topic is added with a release and no deploy', () => {
    let person: Awaited<ReturnType<typeof seedPerson>>;
    let placesBefore: unknown;
    let mappingBefore: unknown;
    const recipeKeys = ['gen-volcano-a-00000001', 'gen-volcano-b-00000002', 'gen-volcano-c-00000003'] as const;
    const facets = ['earth.volcanoes.magma', 'earth.volcanoes.plates', 'earth.volcanoes.magma'] as const;
    const production = () => fixtureProduction(db(), () => answerWith(plainOrrin()), orrinResearchFor);

    beforeAll(async () => {
      person = await seedPerson(db());
      await seedAuthoredGeography(db(), person, authoredWorld);
      const read = await withScope()(person.authority, (scope) => geographyReader(db())(scope));
      placesBefore = read.kind === 'entered' ? read.value : undefined;
    });

    it('appends release 2 in one step; the places and ids that existed read exactly as before', async () => {
      const outcome = await appendRelease(
        db(),
        VOLCANOES.map((node) => ({ kind: 'add' as const, draft: node })),
        'operator',
      );
      expect(outcome).toMatchObject({ kind: 'appended', releaseId: 2, summary: { addedTopics: 1, addedFacets: 2 } });
      const after = await readCatalogueIn(db());
      expect(after.releaseId).toBe(2);
      expect(after.concept('earth.volcanoes')).toMatchObject({ parent: 'earth', servable: false, introducedIn: 2 });
      // What existed keeps its ids, its order, its facets' sites and the identity of every pinned meaning.
      const first = releaseOne();
      expect(after.topics()).toEqual(first.topics());
      expect(after.systems()).toEqual(first.systems());
      for (const topic of first.topics())
        for (const facet of topic.facets)
          expect(after.meaningSha256(topic.id, facet.id)).toBe(first.meaningSha256(topic.id, facet.id));
      // The service that holds an earlier release still reads it, and one that checks the pointer reads the new one.
      expect((await live().release(1))!.digest).toBe(first.digest);
      expect((await live().current()).releaseId).toBe(2);
      // A person's places are untouched by the release: the same map reads exactly as it did.
      const read = await withScope()(person.authority, (scope) => geographyReader(db())(scope));
      expect(read.kind === 'entered' ? read.value : undefined).toEqual(placesBefore);
    });

    it('is invisible: not listed, not shortlisted, no room, no choice, until the library has released supply for it', async () => {
      const catalogue = await live().current();
      expect(catalogue.topics().some((topic) => topic.id === 'earth.volcanoes')).toBe(false);
      expect(catalogue.children('earth').some((topic) => topic.id === 'earth.volcanoes')).toBe(false);
      expect(catalogue.allTopics().some((topic) => topic.id === 'earth.volcanoes')).toBe(true);
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      expect(await catalogueStatus(db())).toMatchObject({ topics: 18, servableTopics: 17, waitingTopics: 1 });
    });

    it('can be written for at once: production reads the new topic from the database, so its Scrolls are attributed and mapped to it', async () => {
      for (const [at, key] of recipeKeys.entries()) {
        await db()
          .insertInto('content.recipes')
          .values({
            key,
            origin: 'proposal',
            status: 'checked',
            title: `CI fixture recipe about volcano ${String(at + 1)}`,
            topic_id: 'earth.volcanoes',
            facet_id: facets[at]!,
            asset_id: stableUuid(`content.recipe-asset:${key}`),
            explanation_unit_id: `${key}-v1`,
            brief:
              'Explain how the invented volcano Orrin Mons builds its cone from layers of ash and lava. Ask only for what the pages say about the layers. Do not claim a date for the next eruption.',
            pages: ['https://en.wikipedia.org/wiki/Volcano'],
            proposing_run_id: randomUUID(),
          })
          .execute();
        expect(await production().produce(key, false, signal(), true, 1)).toMatchObject({
          outcome: 'published',
          held: true,
        });
        const stored = await db()
          .selectFrom('content.encounter_topics')
          .select(['topic_id', 'role'])
          .where('asset_id', '=', stableUuid(`content.recipe-asset:${key}`))
          .execute();
        expect(stored).toEqual([{ topic_id: 'earth.volcanoes', role: 'primary' }]);
      }
      // Held for an operator's read: still no supply, so the topic still waits.
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
    });

    it('becomes servable in a release of its own once three explanations over two facets are released, and not before', async () => {
      const gate = makeReviewGate(db());
      for (const key of recipeKeys.slice(0, 2))
        expect(
          await gate.release({
            assetId: stableUuid(`content.recipe-asset:${key}`),
            revision: 1,
            decidedBy: 'cli:ci-reviewer',
          }),
        ).toMatchObject({ kind: 'released' });
      expect(
        (await readReleasedCoverage(db())).planets.find((planet) => planet.topicId === 'earth.volcanoes'),
      ).toMatchObject({ units: 2 });
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      await gate.release({
        assetId: stableUuid(`content.recipe-asset:${recipeKeys[2]}`),
        revision: 1,
        decidedBy: 'cli:ci-reviewer',
      });
      const shown = await showServableTopics(db());
      expect(shown).toMatchObject({ kind: 'appended', releaseId: 3, summary: { shown: 1 } });
      const catalogue = await live().current();
      expect(catalogue.concept('earth.volcanoes')).toMatchObject({ servable: true });
      expect(catalogue.children('earth').map((topic) => topic.id)).toEqual([
        'earth.seasons',
        'earth.tides',
        'earth.greenhouse-effect',
        'earth.volcanoes',
      ]);
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      const row = await db()
        .selectFrom('content.concept_releases')
        .select('source')
        .where('release_id', '=', 3)
        .executeTakeFirstOrThrow();
      expect(row.source).toBe('visibility');
    });

    it('leaves the certificates of Scrolls decided before the release as they were, and the new Scrolls’ certificates are readable', async () => {
      const asset = stableUuid(`content.recipe-asset:${recipeKeys[0]}`);
      const read = await withScope()(person.authority, (scope) =>
        makeReadAdmittedCoverageMapping()(scope, { assetId: asset, assetRevision: 1 }),
      );
      if (read.kind !== 'entered' || read.value.kind !== 'mapped') throw new Error('mapping not readable');
      mappingBefore = read.value.head;
      expect(read.value.head.mapping.bindings.map((binding) => binding.facetId)).toEqual(['earth.volcanoes.magma']);
      // The mapping recorded the digest of the release it was decided against (release 2); two releases later it is still read in full.
      expect(read.value.head.mapping.catalogueSha256).toBe((await live().release(2))!.digest);
    });

    it('keeps a certificate valid across a wording-only revision, and drops it across a semantic one', async () => {
      const current = await live().current();
      const magma = nodeOf(current, 'earth.volcanoes', 'earth.volcanoes.magma');
      const plates = nodeOf(current, 'earth.volcanoes', 'earth.volcanoes.plates');
      const reworded = { ...magma, meaning: 'Rising magma erupts through the crust.', sameMeaningAs: [magma.meaning] };
      expect(await appendRelease(db(), [{ kind: 'revise', draft: reworded }], 'operator')).toMatchObject({
        kind: 'appended',
        summary: { revised: 1, rewordedOnly: 1 },
      });
      const readOf = async (key: string) => {
        const read = await withScope()(person.authority, (scope) =>
          makeReadAdmittedCoverageMapping()(scope, {
            assetId: stableUuid(`content.recipe-asset:${key}`),
            assetRevision: 1,
          }),
        );
        if (read.kind !== 'entered' || read.value.kind !== 'mapped') throw new Error('mapping not readable');
        return read.value.head;
      };
      // The certificate decided against the old wording stands, and its authority is exactly the head it was.
      const afterWording = await readOf(recipeKeys[0]);
      expect(afterWording.mapping.bindings.map((binding) => binding.facetId)).toEqual(['earth.volcanoes.magma']);
      expect(afterWording.authority).toEqual((mappingBefore as { authority: unknown }).authority);
      // `content readmit-coverage` decides every Scroll again. A reworded facet is the same decision, so it appends no head: the head a
      // certificate names stays the head, binding for binding, and the facet still counts as released supply.
      expect(await readmitCoverageUseCase(db())({ dryRun: false })).toMatchObject({ appended: 0 });
      expect((await readOf(recipeKeys[0])).authority).toEqual(afterWording.authority);
      expect(
        await db()
          .selectFrom('content.coverage_revisions')
          .select('revision')
          .where('asset_id', '=', stableUuid(`content.recipe-asset:${recipeKeys[0]}`))
          .execute(),
      ).toHaveLength(1);
      const supplied = () =>
        readReleasedCoverage(db()).then((coverage) => coverage.planets.find((p) => p.topicId === 'earth.volcanoes'));
      expect(await supplied()).toMatchObject({
        units: 3,
        facets: [
          { facetId: 'earth.volcanoes.magma', units: 2 },
          { facetId: 'earth.volcanoes.plates', units: 1 },
        ],
      });
      // A semantic change: the meaning is something else, so the binding to the old meaning is dropped, never thrown on.
      const changed = { ...plates, meaning: 'Hotspots under a plate feed islands far from any boundary.' };
      expect(await appendRelease(db(), [{ kind: 'revise', draft: changed }], 'operator')).toMatchObject({
        kind: 'appended',
        summary: { revised: 1, rewordedOnly: 0 },
      });
      const afterMeaning = await readOf(recipeKeys[1]);
      expect(afterMeaning.mapping.bindings).toEqual([]);
      expect((await readOf(recipeKeys[0])).mapping.bindings).toHaveLength(1);
      // Released supply counts only the bindings that still stand: the Scroll mapped to the old meaning no longer supplies that facet.
      expect(await supplied()).toMatchObject({ units: 2, facets: [{ facetId: 'earth.volcanoes.magma', units: 2 }] });
      // Deciding coverage again corrects it: the head for the changed facet is replaced, history kept, and the facet counts again.
      expect(await readmitCoverageUseCase(db())({ dryRun: false })).toMatchObject({ appended: 1 });
      expect(await supplied()).toMatchObject({ units: 3 });
    });

    it('refuses a change by code, writes nothing, and never reuses a retired id', async () => {
      const before = (await live().current()).releaseId;
      const duplicate = await appendRelease(
        db(),
        [
          {
            kind: 'add',
            draft: draft('earth.tides', 'topic', 'earth', 'Tides again', 'Again, with the same id but other words.'),
          },
        ],
        'operator',
      );
      expect(duplicate).toMatchObject({ kind: 'refused', refusals: [{ code: 'id_taken' }] });
      expect(
        await appendRelease(
          db(),
          [
            {
              kind: 'add',
              draft: draft('nowhere.topic', 'topic', 'nowhere', 'Nowhere', 'A topic under a system that is not there.'),
            },
          ],
          'operator',
        ),
      ).toMatchObject({ kind: 'refused' });
      expect((await live().current()).releaseId).toBe(before);
      const retired = await appendRelease(db(), [{ kind: 'retire', nodeId: 'earth.volcanoes' }], 'operator');
      expect(retired).toMatchObject({ kind: 'appended', summary: { retired: 3 } });
      const after = await live().current();
      expect(after.concept('earth.volcanoes')).toMatchObject({ retired: true });
      expect(after.topics().some((topic) => topic.id === 'earth.volcanoes')).toBe(false);
      expect(
        await appendRelease(
          db(),
          [
            {
              kind: 'add',
              draft: draft(
                'earth.volcanoes',
                'topic',
                'earth',
                'Volcanoes',
                'A second topic that tries to take the old id.',
              ),
            },
          ],
          'operator',
        ),
      ).toMatchObject({ kind: 'refused', refusals: [{ code: 'id_taken' }] });
    });
  });

  describe('a release read inside a personal transaction (#674)', () => {
    /** A handle on the same database that counts every query it is asked to run: a second connection taken would show here. */
    const counting = () => {
      const seen = { queries: 0 };
      const handle = db().withPlugin({
        transformQuery: (args) => {
          seen.queries += 1;
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      return { seen, handle };
    };

    it('is answered from memory once it has been read: no query on the pool, so no second connection is held with the first', async () => {
      const { seen, handle } = counting();
      const catalogue = makeCatalogue(handle, { revalidateMs: 60_000, background: true });
      const current = await catalogue.current();
      const pinned = await catalogue.release(1);
      expect(pinned).toMatchObject({ releaseId: 1 });
      const person = await seedPerson(db());
      const before = seen.queries;
      await withScope()(person.authority, async () => {
        expect(await catalogue.release(1)).toBe(pinned);
        expect(await catalogue.release(current.releaseId)).toBe(current);
        expect(await catalogue.current()).toBe(current);
        return undefined;
      });
      expect(seen.queries).toBe(before);
    });

    it('reads a release it has never read once, and says there is none for a number that was never released', async () => {
      const { seen, handle } = counting();
      const catalogue = makeCatalogue(handle, { revalidateMs: 60_000, background: true });
      await catalogue.current();
      const before = seen.queries;
      const second = await catalogue.release(2);
      expect(second).toMatchObject({ releaseId: 2 });
      const afterFirstRead = seen.queries;
      expect(afterFirstRead).toBeGreaterThan(before);
      expect(await catalogue.release(2)).toBe(second);
      expect(seen.queries).toBe(afterFirstRead);
      expect(await catalogue.release(9999)).toBeUndefined();
    });
  });

  it('keeps the seeded release’s coverage catalogue as the fixtures use it: the digest of release 1', () => {
    expect(planCoverageCatalogue().sha256).toBe(RELEASE_1_DIGEST);
  });
});
