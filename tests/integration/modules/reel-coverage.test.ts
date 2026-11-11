import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { checkErasureInventory, eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import {
  admitReelCoverage,
  coverageCatalogue,
  coverageHeadPorts,
  makeAdmissionStore,
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
  postgresReelPublisher,
  readmitCoverageUseCase,
  type PublishReel,
} from '@knowscroll/backend/modules/content/nest-providers';
import { REEL_COVERAGE_POLICY, type CoverageCommand } from '@knowscroll/backend/modules/content';
import { ObservedCoverageSchema } from '@knowscroll/backend/modules/evidence';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';
import { activatedAgo, event } from '../support/observations.js';
import { textCapabilities } from '../support/scroll.js';

/**
 * Reels count toward formation (#674, slice 5.1, D-421). A Reel's coverage is decided by code at publication from
 * the script it was made from; qualified watching of it makes a certificate that binds only the facets whose required
 * segments were watched; Personal Context accepts it beside a Scroll's, and a Reel and its Scroll twin are one unit.
 * Scripts, Reels and media are labelled CI fixtures: no Cutroom, no provider and no spend.
 */
const DURATION = 30_000;
/** Six sentences of 4, 6, 2, 3, 5 and 8 words, so the segments of a 30 s Reel are 0-4.3, 4.3-10.7, 10.7-12.9, 12.9-16.1, 16.1-21.4 and 21.4-30 s. */
const SENTENCES = [
  'One two three four.',
  'One two three four five six.',
  'One two.',
  'One two three.',
  'One two three four five.',
  'One two three four five six seven eight.',
];
const capabilities = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('Reels count toward formation (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('reel_coverage');
  });
  afterAll(() => world.close());

  type Twin = Awaited<ReturnType<GeographyWorld['fixture']>>;
  interface Reel {
    readonly assetId: string;
    readonly revision: number;
    readonly unit: string;
    readonly twin: Twin;
    readonly coverage: string | undefined;
  }
  interface RecipeOptions {
    readonly facetId?: string;
    readonly supportingFacetId?: string;
    readonly sentences?: readonly string[];
    /** Claims that rest on another revision of the twin: the script cannot be bound. */
    readonly unsourced?: boolean;
    readonly recipeKey?: string;
  }

  const briefOf = (twin: Twin, options: RecipeOptions) => {
    const sentences = options.sentences ?? SENTENCES;
    return {
      version: 1 as const,
      worldId: 'ci-reel-coverage',
      narration: sentences.map((text, index) => ({ text, claimIds: [`c${String(index + 1)}`] })),
      claims: sentences.map((_, index) => ({
        id: `c${String(index + 1)}`,
        role: index === 0 ? ('main' as const) : ('supporting' as const),
      })),
      claimSources: sentences.map((_, index) => ({
        claimId: `c${String(index + 1)}`,
        assetId: twin.assetId,
        assetRevision: options.unsourced ? 7 : twin.revision,
      })),
      criteria: { mustShow: [], mustNotShow: [], depictionPolicyVersion: 'policy-3' },
      style: { id: 'ci', version: 1, text: 'CI fixture' },
      title: '[CI] Reel',
      summary: 'CI fixture',
    };
  };

  /** Publishes a Reel of `twin` through the real publisher, whose transaction decides its coverage. */
  async function publishReel(twin: Twin, options: RecipeOptions = {}, topicId = topic): Promise<Reel> {
    const assetId = randomUUID();
    const brief = briefOf(twin, options);
    const digest = sha(assetId);
    const recipe = {
      explanationUnitId: twin.unit,
      topicId,
      facetId: options.facetId ?? facet,
      ...(options.supportingFacetId ? { supportingFacetId: options.supportingFacetId } : {}),
    };
    const approval = { ref: 'ci fixture', approvedBy: 'ci', approvedAt: '2026-11-11' };
    const reel: PublishReel = {
      scriptName: `ci-${assetId.slice(0, 8)}`,
      script: { id: assetId, authoredBy: 'ci', approval, recipe: options.recipeKey ?? 'ci-recipe', brief },
      twin: { assetId: twin.assetId, revision: twin.revision, explanationUnitId: twin.unit },
      topicId,
      recipe,
      media: {
        key: `sha256/${digest.slice(0, 2)}/${digest}.mp4`,
        sha256: digest,
        size: 4096,
        probe: { durationMs: DURATION, width: 1080, height: 1920 },
      },
      provenance: {
        schemaVersion: 'reel-provenance.v1',
        kind: 'cutroom_import',
        script: assetId,
        approval,
        brief,
        recipe: options.recipeKey ?? 'ci-recipe',
        twin: { assetId: twin.assetId, assetRevision: twin.revision, explanationUnitId: twin.unit },
        runId: randomUUID(),
        mediaSha256: digest,
        probe: { durationMs: DURATION, width: 1080, height: 1920 },
        fixture: false,
      },
      orderId: undefined,
      runId: randomUUID(),
    };
    const published = await postgresReelPublisher(world.database.db).publish(reel);
    if (published.kind !== 'published') throw new Error(`CI Reel refused: ${published.code}`);
    return { assetId, revision: 1, unit: twin.unit, twin, coverage: published.coverage };
  }
  /** A new unit of one planet: its twin Scroll (with its own coverage of `facetId`) and a Reel of it. */
  async function reelOfUnit(options: RecipeOptions = {}, topicId = topic) {
    const twin = await world.fixture(undefined, topicId, [options.facetId ?? facet]);
    return publishReel(twin, options, topicId);
  }

  /** The person watches `windows` of the Reel (media milliseconds) and the evidence and activity projections run. */
  async function watch(
    p: FixturePerson,
    reel: Reel,
    windows: readonly (readonly [number, number])[] = [[0, DURATION]],
  ) {
    const { c, database } = world;
    const opened = await c.openExposure(p.authority, {
      commandId: randomUUID(),
      target: { kind: 'reel', assetId: reel.assetId },
      origin: { kind: 'direct' },
      capabilities,
    });
    if (opened.kind !== 'opened') throw new Error(`CI Reel open refused: ${JSON.stringify(opened)}`);
    const activated = await c.activateExposure(p.authority, {
      commandId: randomUUID(),
      exposureId: opened.outcome.exposureId,
    });
    if (activated.kind !== 'activated') throw new Error('CI Reel activation refused');
    const exposure = { exposureId: opened.outcome.exposureId, assetId: reel.assetId, assetRevision: reel.revision };
    await activatedAgo(database.db, exposure.exposureId, 20);
    const samples = windows.flatMap(([from, to]) => {
      const pieces: { activeMs: [number, number]; mediaMs: [number, number] }[] = [];
      for (let at = from; at < to; at += 1000) {
        const end = Math.min(to, at + 1000);
        pieces.push({ activeMs: [at, end], mediaMs: [at, end] });
      }
      return pieces;
    });
    const events = [];
    for (let start = 0; start < samples.length; start += 64)
      events.push(event(exposure, { kind: 'reel.playback', payload: { samples: samples.slice(start, start + 64) } }));
    await c.ingestObservations(p.authority, { instrumentationVersion: 1, events });
    const job = { v: 1 as const, universeId: p.universeId, privacyEpoch: 1, exposureId: exposure.exposureId };
    const qualification = await c.projectScrollReading(job);
    await c.projectActivity(job);
    return { exposure, qualification };
  }
  const watched = async (p: FixturePerson, reel: Reel, windows?: readonly (readonly [number, number])[]) => {
    const result = await watch(p, reel, windows);
    expect(result.qualification).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    return result.exposure;
  };

  /** The facets a person's exposures reference, from the recording projection or the legacy one. */
  async function references(p: FixturePerson) {
    const { db } = world.database;
    const recording = await db
      .selectFrom('personal_context.recording_coverage_references')
      .select(['facet_id', 'explanation_unit_id', 'exposure_id'])
      .where('universe_id', '=', p.universeId)
      .execute();
    const legacy = await db
      .selectFrom('personal_context.coverage_references')
      .select(['facet_id', 'explanation_unit_id', 'exposure_id'])
      .where('universe_id', '=', p.universeId)
      .execute();
    return [...recording, ...legacy].sort((a, b) => a.facet_id.localeCompare(b.facet_id));
  }
  const supports = (p: FixturePerson) =>
    world.database.db
      .selectFrom('personal_context.coverage_supports')
      .select(['topic_id', 'facet_id', 'explanation_unit_id', 'reference_count'])
      .where('universe_id', '=', p.universeId)
      .orderBy('explanation_unit_id')
      .orderBy('facet_id')
      .execute();
  async function trusted(p: FixturePerson, reel: Pick<Reel, 'unit'>) {
    const result = await makeWithPersonalScope(world.database.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
      world.c.readTrustedCoverage(scope, {
        probes: [
          { topicId: topic, facetId: facet, explanationUnitId: reel.unit },
          { topicId: topic, facetId: otherFacet, explanationUnitId: reel.unit },
        ],
      }),
    );
    if (result.kind !== 'entered') throw new Error('CI scope refused');
    return result.value;
  }
  async function cartograph(p: FixturePerson) {
    const runId = (await world.state(p)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    const run = world.runner(p, () => ({ kind: 'malformed' }));
    await run.run(await world.job(p, runId), signal());
    return { runId, model: run.model };
  }
  async function placeKinds(p: FixturePerson) {
    const snapshot = await world.snapshot(p);
    return 'page' in snapshot ? snapshot.page.objects.map((place) => place.kind).sort() : [];
  }
  const run = (runId: string) =>
    world.database.db
      .selectFrom('geography.runs')
      .select(['status', 'outcome'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();

  describe('what a Reel’s coverage is', () => {
    it('is decided by code at publication from the script, as a head of the Reel with the Reel’s own policy', async () => {
      const reel = await reelOfUnit({ supportingFacetId: otherFacet });
      expect(reel.coverage).toBe('admitted');
      const head = await world.database.db
        .selectFrom('content.coverage_revisions')
        .select(['revision', 'status', 'semantic_review_reference', 'mapping'])
        .where('asset_id', '=', reel.assetId)
        .execute();
      expect(head).toHaveLength(1);
      expect(head[0]).toMatchObject({
        revision: 1,
        status: 'active',
        semantic_review_reference: `reel-recipe-coverage.v1:${reel.unit}`,
        mapping: {
          version: REEL_COVERAGE_POLICY,
          explanationUnitId: reel.unit,
          framing: 'factual',
          framingSha256: canonicalSha256({ kind: 'factual' }),
          bindings: [
            { facetId: facet, requiredBlockIds: ['s1', 's3', 's6'] },
            { facetId: otherFacet, requiredBlockIds: ['s5', 's6'] },
          ],
        },
      });
    });

    it('is never a place of its own: the derived region lookup lists no Reel, and the data refuses a mapping of the other kind', async () => {
      const reel = await reelOfUnit();
      const { db } = world.database;
      expect(
        await db
          .selectFrom('content.region_bindings')
          .select('asset_id')
          .where('asset_id', '=', reel.assetId)
          .execute(),
      ).toEqual([]);
      // The twin Scroll, which has the same unit and facet, is the one the region lists.
      expect(
        (
          await db
            .selectFrom('content.region_bindings')
            .select('asset_id')
            .where('asset_id', '=', reel.twin.assetId)
            .execute()
        ).length,
      ).toBe(1);
      const head = await db
        .selectFrom('content.coverage_revisions')
        .select('mapping')
        .where('asset_id', '=', reel.assetId)
        .executeTakeFirstOrThrow();
      const scrollMapping = { ...(head.mapping as object), version: 'scroll-static-coverage.v1' };
      await expect(
        sql`insert into content.coverage_revisions(asset_id,asset_revision,revision,status,mapping_sha256,command_sha256,semantic_review_reference,mapping)
          values(${reel.assetId}::uuid,1,2,'active',${'0'.repeat(64)},${'1'.repeat(64)},'ci',${JSON.stringify(scrollMapping)}::jsonb)`.execute(
          db,
        ),
      ).rejects.toThrow('CONTENT_COVERAGE_KIND_MISMATCH');
      const twinHead = await db
        .selectFrom('content.coverage_revisions')
        .select('mapping')
        .where('asset_id', '=', reel.twin.assetId)
        .executeTakeFirstOrThrow();
      await expect(
        sql`insert into content.coverage_revisions(asset_id,asset_revision,revision,status,mapping_sha256,command_sha256,semantic_review_reference,mapping)
          values(${reel.twin.assetId}::uuid,1,2,'active',${'0'.repeat(64)},${'1'.repeat(64)},'ci',${JSON.stringify({ ...(twinHead.mapping as object), version: REEL_COVERAGE_POLICY })}::jsonb)`.execute(
          db,
        ),
      ).rejects.toThrow('CONTENT_COVERAGE_KIND_MISMATCH');
    });

    it('leaves a Reel whose claims do not rest on its twin published and unmapped, and says so', async () => {
      const twin = await world.fixture(undefined, topic, [facet]);
      const reel = await publishReel(twin, { unsourced: true });
      expect(reel.coverage).toBe('too_few_segments');
      expect(
        await world.database.db
          .selectFrom('content.coverage_revisions')
          .select('revision')
          .where('asset_id', '=', reel.assetId)
          .execute(),
      ).toEqual([]);
      const p = await seedPerson(world.database.db);
      await watch(p, reel);
      expect(await references(p)).toEqual([]);
    });

    it('is decided again for a Reel with no head by `content readmit-coverage`, which names the unit so readers are judged again', async () => {
      const recipe = RECIPES['seasons-hemispheres'];
      const twin = await world.fixture(recipe.explanationUnitId, recipe.topicId, [recipe.facetId]);
      // Published when its facet was not in the plan: the Reel is stored with its script and no head.
      const reel = await publishReel(twin, {
        facetId: 'earth.seasons.no-such-facet',
        recipeKey: 'seasons-hemispheres',
      });
      expect(reel.coverage).toBe('facet_not_in_catalogue');
      const headsOf = () =>
        world.database.db
          .selectFrom('content.coverage_revisions')
          .select('revision')
          .where('asset_id', '=', reel.assetId)
          .execute();
      expect(await headsOf()).toEqual([]);

      const dry = await readmitCoverageUseCase(world.database.db)({ dryRun: true });
      // The Reels of the other tests name a recipe that is not in the plan: left alone.
      expect(dry).toMatchObject({ dryRun: true, considered: 1, appended: 1, unchanged: 0, changedUnits: [] });
      expect(await headsOf()).toEqual([]);

      const summary = await readmitCoverageUseCase(world.database.db)({ dryRun: false });
      expect(summary).toMatchObject({
        considered: 1,
        appended: 1,
        unchanged: 0,
        changedUnits: [recipe.explanationUnitId],
      });
      expect(await headsOf()).toEqual([{ revision: 1 }]);
      expect(await readmitCoverageUseCase(world.database.db)({ dryRun: false })).toMatchObject({
        considered: 1,
        appended: 0,
        unchanged: 1,
        changedUnits: [],
      });
      // It is the recipe's facet, decided by code from the stored script.
      const head = await world.database.db
        .selectFrom('content.coverage_revisions')
        .select('mapping')
        .where('asset_id', '=', reel.assetId)
        .executeTakeFirstOrThrow();
      expect(head.mapping).toMatchObject({
        bindings: [{ facetId: recipe.facetId, requiredBlockIds: ['s1', 's3', 's6'] }],
      });
    });
  });

  describe('forming from Reels', () => {
    it('forms a system from two Reels and the planet from three, for a reader who has only watched Reels', async () => {
      const p = await seedPerson(world.database.db);
      expect(await placeKinds(p)).toEqual([]);

      await watched(p, await reelOfUnit({ facetId: facet }));
      const first = await cartograph(p);
      expect(await placeKinds(p)).toEqual([]);
      expect(await run(first.runId)).toMatchObject({ status: 'insufficient', outcome: 'no_changes' });

      await watched(p, await reelOfUnit({ facetId: otherFacet }));
      const second = await cartograph(p);
      expect(await placeKinds(p)).toEqual(['star', 'system']);
      expect(await run(second.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });

      await watched(p, await reelOfUnit({ facetId: facet }));
      const third = await cartograph(p);
      expect(await placeKinds(p)).toEqual(['planet', 'region', 'region', 'star', 'system']);
      expect(await run(third.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
      expect(await supports(p)).toHaveLength(3);
    });

    it('counts a Reel and its Scroll twin once: they hold one support key, and are one unit', async () => {
      const p = await seedPerson(world.database.db);
      const reel = await reelOfUnit({ facetId: facet });
      await world.observe(p, reel.twin);
      await watched(p, reel);
      // One key (the same unit, facet, meaning and truth), held by the Scroll's exposure and the Reel's.
      expect(await supports(p)).toEqual([
        { topic_id: topic, facet_id: facet, explanation_unit_id: reel.unit, reference_count: 2 },
      ]);
      const proof = await trusted(p, reel);
      expect(proof).toMatchObject({ availability: 'available', supportedFormats: ['scroll', 'reel'] });
      expect(proof.supports).toHaveLength(1);
      expect(proof.witnesses).toHaveLength(1);
      // Two exposures of one unit are one unit: nothing forms, and a second unit makes the system.
      const first = await cartograph(p);
      expect(await placeKinds(p)).toEqual([]);
      expect(await run(first.runId)).toMatchObject({ outcome: 'no_changes' });
      await watched(p, await reelOfUnit({ facetId: otherFacet }));
      await cartograph(p);
      expect(await placeKinds(p)).toEqual(['star', 'system']);
    });

    it('binds nothing for segments that were not watched, and credits a facet only from the segments it covered', async () => {
      const p = await seedPerson(world.database.db);
      const reel = await reelOfUnit({ facetId: facet, supportingFacetId: otherFacet });
      // Watched through 26 s: qualified, but neither the last segment nor the closing pair was met.
      await watched(p, reel, [[0, 26_000]]);
      expect(await references(p)).toEqual([]);
      expect(await supports(p)).toEqual([]);

      // Watched from 8 s to the end: the closing segments bind the supporting facet; the opening one was not met.
      const q = await seedPerson(world.database.db);
      await watched(q, reel, [[8000, DURATION]]);
      expect((await references(q)).map((row) => row.facet_id)).toEqual([otherFacet]);

      // Watched all of it: both facets.
      const r = await seedPerson(world.database.db);
      await watched(r, reel);
      expect((await references(r)).map((row) => row.facet_id)).toEqual([facet, otherFacet]);

      // A reader who watched too little is not qualified and has no support at all.
      const s = await seedPerson(world.database.db);
      const short = await watch(s, reel, [[0, 9000]]);
      expect(short.qualification).toMatchObject({ kind: 'applied', qualification: 'not_qualified' });
      expect(await references(s)).toEqual([]);
    });

    it('marks the topic dirty for Geography, as a Scroll’s coverage does: a new reference to a trusted support key', async () => {
      const p = await seedPerson(world.database.db);
      const dirty = () =>
        world.database.db
          .selectFrom('personal_context.coverage_dirty_topics')
          .select('topic_id')
          .where('universe_id', '=', p.universeId)
          .execute();
      expect(await dirty()).toEqual([]);
      // Watching too little for any segment binds nothing, so nothing trusted changed and nothing is marked.
      await watched(p, await reelOfUnit({ facetId: facet, supportingFacetId: otherFacet }), [[0, 26_000]]);
      expect(await dirty()).toEqual([]);
      await watched(p, await reelOfUnit({ facetId: facet }));
      expect(await dirty()).toEqual([{ topic_id: topic }]);
    });

    it('gives a support only to the reader who watched the Reel: another reader, another place', async () => {
      const reel = await reelOfUnit({ facetId: facet });
      const watcher = await seedPerson(world.database.db);
      const other = await seedPerson(world.database.db);
      await watched(watcher, reel);
      expect(await references(other)).toEqual([]);
      expect(await references(watcher)).toHaveLength(1);
    });
  });

  describe('the exact-evidence check', () => {
    const certificateOf = async (p: FixturePerson, exposureId: string) => {
      const head = await world.database.db
        .selectFrom('personal_context.recording_segment_heads')
        .select('coverage')
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', exposureId)
        .executeTakeFirstOrThrow();
      return ObservedCoverageSchema.parse(head.coverage);
    };
    const check = async (p: FixturePerson, certificate: Awaited<ReturnType<typeof certificateOf>>) => {
      const result = await makeWithPersonalScope(world.database.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
        world.c.checkCoverageEvidence(scope, [certificate]),
      );
      return result.kind === 'entered' ? result.value : [];
    };

    it('accepts a Reel certificate by its own policy, and refuses a claim of a segment the stored summary does not show watched', async () => {
      const reel = await reelOfUnit({ facetId: facet });
      const full = await seedPerson(world.database.db);
      const fullExposure = await watched(full, reel);
      const certificate = await certificateOf(full, fullExposure.exposureId);
      expect(certificate.bindings).toMatchObject([{ requiredBlockIds: ['s1', 's3', 's6'] }]);
      expect(await check(full, certificate)).toEqual([fullExposure.exposureId]);

      // Another reader stopped at 26 s: qualified, with no binding. Claiming the full reading's bindings is refused.
      const partial = await seedPerson(world.database.db);
      const partialExposure = await watched(partial, reel, [[0, 26_000]]);
      const own = await certificateOf(partial, partialExposure.exposureId);
      expect(own.bindings).toEqual([]);
      expect(await check(partial, own)).toEqual([partialExposure.exposureId]);
      expect(await check(partial, { ...own, bindings: certificate.bindings })).toEqual([]);
    });
  });

  describe('a Reel cut again', () => {
    /** A new revision of the Reel's asset, as a re-cut would store it, with its coverage decided by the same code. */
    async function recut(reel: Reel, options: RecipeOptions & { readonly durationMs?: number }) {
      const { db } = world.database;
      const revision = reel.revision + 1;
      const durationMs = options.durationMs ?? DURATION;
      const brief = briefOf(reel.twin, options);
      const document = {
        schemaVersion: 'reel-document.v1',
        assetId: reel.assetId,
        revision,
        title: '[CI] Reel (re-cut)',
        summary: 'CI fixture',
        language: 'en',
        truthLabel: 'generated',
        fixture: false,
        captions: 'burned_in',
        mediaKey: `sha256/${sha(String(revision)).slice(0, 2)}/${sha(String(revision))}.mp4`,
        durationMs,
        width: 1080,
        height: 1920,
      };
      const first = await db
        .selectFrom('content.asset_provenance')
        .select('provenance')
        .where('asset_id', '=', reel.assetId)
        .where('revision', '=', reel.revision)
        .executeTakeFirstOrThrow();
      await sql`insert into content.asset_revisions
          (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
        values (${reel.assetId}::uuid, ${revision}, 'cutroom_import', 'reel-document.v1', ${JSON.stringify(document)}::jsonb, ${sha(JSON.stringify(document))},
          ${reel.unit}, 'en', ${document.title}, ${JSON.stringify({ v: 2, measuresVersion: 'reel-duration.v1', totalWeight: 0, estimatedReadingMs: durationMs, blocks: [], nested: [], reelDurationMs: durationMs })}::jsonb)`.execute(
        db,
      );
      await sql`insert into content.asset_provenance (asset_id, revision, provenance_version, provenance)
        values (${reel.assetId}::uuid, ${revision}, 'reel-provenance.v1', ${JSON.stringify({ ...(first.provenance as object), brief })}::jsonb)`.execute(
        db,
      );
      await sql`insert into content.encounter_topics (asset_id, asset_revision, topic_id, role, weight) values (${reel.assetId}::uuid, ${revision}, ${topic}, 'primary', 1)`.execute(
        db,
      );
      await sql`update content.discovery_revisions set facets = ${[topic]}::text[], attribution_version = 'reel-twin-taxonomy.v1' where asset_id = ${reel.assetId}::uuid and asset_revision = ${revision}`.execute(
        db,
      );
      await sql`update content.assets set revision = ${revision} where id = ${reel.assetId}::uuid`.execute(db);
      const outcome = await makeAdmissionStore(db).inAdmission((tx) =>
        admitReelCoverage(
          coverageHeadPorts,
          tx,
          { explanationUnitId: reel.unit, topicId: topic, facetId: options.facetId ?? facet },
          { assetId: reel.assetId, assetRevision: revision },
        ),
      );
      expect(outcome).toMatchObject({ kind: 'admitted', change: 'appended' });
      return { ...reel, revision };
    }
    const approvals = new Map<string, string>();
    /** A reviewed command that retracts a revision's head: withdrawing what a Reel is trusted for. */
    const retract = async (reel: Reel, revision: number) => {
      const head = await makeAdmissionStore(world.database.db).inAdmission((tx) =>
        coverageHeadPorts.readHead(tx, { assetId: reel.assetId, assetRevision: revision }),
      );
      const command: CoverageCommand = {
        version: 'content-coverage-command.v1',
        assetId: reel.assetId,
        assetRevision: revision,
        expectedHeadRevision: head!.authority.headRevision,
        semanticReviewReference: 'ci-retract-fixture-review',
        change: { kind: 'retract' },
      };
      approvals.set(canonicalSha256(command), command.semanticReviewReference);
      await makeAdmitCoverage(
        makeCoverageAdmissionPorts(world.database.db, (digest, ref) => approvals.get(digest) === ref),
      )(command);
    };

    it('is read as another revision of one unit: the key is shared, the newest valid revision proves it, and a retracted one leaves the other', async () => {
      const p = await seedPerson(world.database.db);
      const first = await reelOfUnit({ facetId: facet });
      const e1 = await watched(p, first);
      // The cut is longer and its sentences are other, so its windows are other: it is its own revision with its own head.
      const second = await recut(first, { durationMs: 40_000, sentences: [...SENTENCES, 'One two three.'] });
      expect(second.revision).toBe(2);
      const heads = await world.database.db
        .selectFrom('content.coverage_revisions')
        .select(['asset_revision', 'mapping'])
        .where('asset_id', '=', first.assetId)
        .orderBy('asset_revision')
        .execute();
      expect(heads.map((head) => head.asset_revision)).toEqual([1, 2]);
      expect(
        (heads[1]!.mapping as { bindings: { requiredSpans: number[][] }[] }).bindings[0]!.requiredSpans,
      ).not.toEqual((heads[0]!.mapping as { bindings: { requiredSpans: number[][] }[] }).bindings[0]!.requiredSpans);

      // The reading of revision 1 stands: exact historical content proves what was watched.
      expect((await trusted(p, first)).witnesses.map((w) => w.exposureId)).toEqual([e1.exposureId]);

      // Watching the re-cut adds a reference to the same key and never a unit.
      const e2 = await watched(p, second, [[0, 40_000]]);
      expect(await supports(p)).toEqual([
        { topic_id: topic, facet_id: facet, explanation_unit_id: first.unit, reference_count: 2 },
      ]);
      const both = await trusted(p, first);
      expect(both.witnesses).toHaveLength(1);
      expect(both.witnesses[0]!.exposureId).toBe(e2.exposureId);

      // Retracting the re-cut's head leaves the older revision's reading proving the key.
      await retract(second, 2);
      const afterRetraction = await trusted(p, first);
      expect(afterRetraction).toMatchObject({ availability: 'available' });
      expect(afterRetraction.witnesses).toHaveLength(1);
      expect(afterRetraction.witnesses[0]!.exposureId).toBe(e1.exposureId);
    });

    it('judges a viewer of the re-cut against the re-cut’s windows, not the earlier ones', async () => {
      const first = await reelOfUnit({ facetId: facet });
      const second = await recut(first, { durationMs: 40_000, sentences: [...SENTENCES, 'One two three.'] });
      const p = await seedPerson(world.database.db);
      // 30 s of a 40 s re-cut covers the first 30 s: the last segment of the re-cut was not met.
      await watched(p, second, [[0, 30_000]]);
      expect(await references(p)).toEqual([]);
      const q = await seedPerson(world.database.db);
      await watched(q, second, [[0, 40_000]]);
      expect(await references(q)).toHaveLength(1);
    });
  });

  describe('a head that changed only in the catalogue digest (D-406)', () => {
    const grown = { ...coverageCatalogue, sha256: canonicalSha256({ fixturePlan: 'ci-grown-concept-plan' }) };
    const readmitWithGrownPlan = (reel: Reel, facetId: string) =>
      makeAdmissionStore(world.database.db).inAdmission((tx) =>
        admitReelCoverage(
          { ...coverageHeadPorts, catalogue: grown },
          tx,
          { explanationUnitId: reel.unit, topicId: topic, facetId },
          { assetId: reel.assetId, assetRevision: 1 },
        ),
      );

    it('keeps a Reel reading valid and its support counts unchanged, and formation proceeds', async () => {
      const p = await seedPerson(world.database.db);
      const one = await reelOfUnit({ facetId: facet });
      const two = await reelOfUnit({ facetId: otherFacet });
      await watched(p, one);
      await watched(p, two);
      const before = await supports(p);
      const original = await trusted(p, one);
      expect(original.witnesses).toHaveLength(1);

      // `content readmit-coverage` after the plan grew: the same mapping, a new digest and head number.
      expect(await readmitWithGrownPlan(one, facet)).toMatchObject({
        kind: 'admitted',
        change: 'appended',
        head: { authority: { headRevision: 2 } },
      });
      expect(await readmitWithGrownPlan(two, otherFacet)).toMatchObject({
        kind: 'admitted',
        change: 'appended',
        head: { authority: { headRevision: 2 } },
      });
      const after = await trusted(p, one);
      expect(after).toMatchObject({ availability: 'available', reason: 'current' });
      expect(after.witnesses).toEqual(original.witnesses);
      expect(await supports(p)).toEqual(before);

      const run1 = await cartograph(p);
      expect(await placeKinds(p)).toEqual(['star', 'system']);
      expect(await run(run1.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    });
  });

  describe('personal data', () => {
    it('erases the Reel’s certificates, references and supports with everything else the person holds', async () => {
      const p = await seedPerson(world.database.db);
      await watched(p, await reelOfUnit({ facetId: facet }));
      await watched(p, await reelOfUnit({ facetId: otherFacet }));
      expect((await references(p)).length).toBeGreaterThan(0);
      expect(await checkErasureInventory(world.database.db, personalStores)).toEqual([]);
      const erased = await makeWithPersonalScope(world.database.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
        eraseUniverse(scope, personalStores),
      );
      expect(erased.kind).toBe('entered');
      for (const table of [
        'coverage_references',
        'coverage_dirty_topics',
        'coverage_supports',
        'coverage_contributions',
        'recording_coverage_references',
        'recording_coverage_contributions',
        'recording_segment_heads',
      ] as const)
        expect(
          await world.database.db
            .selectFrom(`personal_context.${table}`)
            .selectAll()
            .where('universe_id', '=', p.universeId)
            .execute(),
        ).toEqual([]);
      expect(
        await world.database.db
          .selectFrom('evidence.encounter_evidence')
          .select('id')
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
    });
  });
});
