import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  PREPARE_COMPOSER_BUFFER,
  prepareBufferQueue,
  type ComposerDecision,
  type PrepareBuffer,
  type PrepareBufferJob,
} from '@knowscroll/backend/modules/composer';
import { composerBufferWorkerProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import { admitLibraryContinuityUseCase, contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { experienceBufferSourceProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import { READ_COMPOSER_CONTEXT } from '@knowscroll/backend/modules/personal-context';
import { RECORDING_REASONING_HARNESS } from '@knowscroll/backend/reasoning';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { RECIPES, type RecipeKey } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureRecordingHarness } from '../support/recording-harness.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

/**
 * Next is a new topic in the same format (v3 S-1d, D-131, D-132). Labelled CI fixtures on real
 * PostgreSQL: the Scrolls are the starter document under a recipe's identity (the Seasons series is
 * admitted by the real `admit-continuity`), the Reels are rows with a valid Reel document and no
 * media. Nothing here is generated content.
 */
type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;
type Format = 'reel' | 'scroll';

const bothFormats = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
const WITH_SCOPE = Symbol('test.withPersonalScope');
const WORKER_CONFIG = Symbol('test.workerConfig');
const SEASONS_TOPIC = 'earth.seasons';

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  expect(result).toMatchObject({ kind: 'accepted', outcome: { status: 'ready' } });
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready') throw new Error('CI fixture expected ready');
  return result.outcome;
}

describe('a vertical move is a new topic in the same format (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let cases: Cases;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('composer_vertical');
    cases = await scrollUseCases(database, { buffers: true });
  });
  afterAll(async () => {
    await cases.close();
    await database.drop();
  });

  async function attribute(assetId: string, topicId: string) {
    await database.db
      .insertInto('content.encounter_topics')
      .values({ asset_id: assetId, asset_revision: 1, topic_id: topicId, role: 'primary', weight: 1 })
      .execute();
  }

  /** The Scroll the generator would publish for this recipe, on the Seasons topic. */
  async function publishRecipe(key: RecipeKey) {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = RECIPES[key].assetId;
    source.publication.explanationUnitId = `ci-vertical-${key}`;
    const imported = await cases.importScroll(source);
    if (imported.kind !== 'imported') throw new Error(`fixture admission refused for ${key}`);
    await attribute(imported.assetId, SEASONS_TOPIC);
    return { assetId: imported.assetId, assetRevision: imported.revision };
  }

  async function admitScroll(topicId: string) {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `ci-vertical-scroll-${randomUUID()}`;
    const imported = await cases.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    await attribute(imported.assetId, topicId);
    return { assetId: imported.assetId, assetRevision: imported.revision };
  }

  /**
   * An admitted Reel row with a valid document and no media: enough for Explore to rank and offer it. With
   * `unit` it is the format twin of the Scroll that has that explanation unit.
   */
  async function admitReel(topicId: string, unit?: string) {
    const assetId = randomUUID();
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId,
      revision: 1,
      title: '[Fixture] a Reel',
      summary: 'CI fixture',
      language: 'en',
      truthLabel: 'generated',
      fixture: true,
      captions: 'burned_in',
      mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
      durationMs: 20_000,
      width: 1080,
      height: 1920,
    };
    await sql`insert into content.assets (id, revision, kind, status) values (${assetId}::uuid, 1, 'reel', 'admitted')`.execute(
      database.db,
    );
    await sql`insert into content.asset_revisions
        (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
      values (${assetId}::uuid, 1, 'generated', 'reel-document.v1', ${JSON.stringify(document)}::jsonb,
        ${'0'.repeat(64)}, ${unit ?? `ci-vertical-reel-${assetId}`}, 'en', ${document.title}, '{}'::jsonb)`.execute(
      database.db,
    );
    await attribute(assetId, topicId);
    return { assetId, assetRevision: 1 };
  }

  /** Opens the exact encounter, as a revisit does, and activates it: the person is on it. */
  async function standOn(
    person: FixturePerson,
    target: { assetId: string; assetRevision: number },
    use: Cases = cases,
  ) {
    const open = ready(
      await use.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'return', ...target },
        capabilities: bothFormats,
      }),
    );
    const activated = await use.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: open.sessionId,
        offerId: open.offer.offerId,
        expectedIntentRevision: open.intentRevision,
      },
    });
    if (activated.kind !== 'accepted') throw new Error('fixture activation refused');
    return { open, from: { offerId: open.offer.offerId, exposureId: activated.outcome.exposureId } };
  }

  const nextSubject = (
    person: FixturePerson,
    stand: Awaited<ReturnType<typeof standOn>>,
    format?: Format,
    direction: 'next' | 'previous' = 'next',
    use: Cases = cases,
  ) =>
    use.navigate(person.authority, {
      commandId: randomUUID(),
      sessionId: stand.open.sessionId,
      expectedIntentRevision: stand.open.intentRevision,
      from: stand.from,
      intent: { mode: 'vertical', direction, ...(format ? { format } : {}) },
    });

  const offers = (outcome: Ready) => [outcome.offer, ...outcome.bufferedOffers];
  const decisionOf = async (decisionId: string) =>
    (
      await sql<{
        payload: ComposerDecision;
      }>`select payload from composer.decisions where id=${decisionId}::uuid`.execute(database.db)
    ).rows[0]!.payload;
  const exclusionsIn = (decision: ComposerDecision, assetId: string) =>
    decision.evaluations.find((evaluation) => evaluation.assetId === assetId)?.exclusions;

  /** The worker side over the real providers; Jev is off, so no model is involved. */
  function worker(): PrepareBuffer {
    const { harness } = fixtureRecordingHarness(database.db, { model: undefined });
    const values = new Map<symbol, unknown>([
      [WITH_SCOPE, withScope()],
      [WORKER_CONFIG, { jevEnabled: false, reasoning: {} }],
      [RECORDING_REASONING_HARNESS, harness],
      [READ_COMPOSER_CONTEXT, cases.readComposerContext],
      ...[
        ...experienceBufferSourceProviders(),
        ...composerProviders({ isOperator: () => false }),
        ...contentProviders(),
      ].map((provider) => [provider.provide, provider.useValue] as const),
    ]);
    return buildFromProviders(
      composerBufferWorkerProviders({ withPersonalScope: WITH_SCOPE, workerConfig: WORKER_CONFIG }),
      PREPARE_COMPOSER_BUFFER,
      values,
    ) as PrepareBuffer;
  }
  const prepareFor = async (universeId: string) => {
    const [job] = (
      await sql<{
        data: PrepareBufferJob;
      }>`select data from pgboss.job where name=${prepareBufferQueue.name} and data->>'universeId'=${universeId} order by created_on`.execute(
        database.db,
      )
    ).rows;
    const result = await worker()(job!.data, { jobId: randomUUID(), signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: 'prepared' });
    return (
      await sql<{
        decision_id: string;
        selection: { assetId: string }[];
      }>`select decision_id,selection from composer.buffers where universe_id=${universeId}::uuid`.execute(database.db)
    ).rows[0]!;
  };

  let seasons: Awaited<ReturnType<typeof publishRecipe>>;
  let hemispheres: Awaited<ReturnType<typeof publishRecipe>>;
  let part3: Awaited<ReturnType<typeof publishRecipe>>;
  /** seasons-limits: the related move of Part 3 (D-125), on the Seasons planet but not in the series. */
  let limits: Awaited<ReturnType<typeof publishRecipe>>;
  const elsewhere: Awaited<ReturnType<typeof admitScroll>>[] = [];
  const reels: Awaited<ReturnType<typeof admitReel>>[] = [];

  beforeAll(async () => {
    seasons = await publishRecipe('seasons');
    hemispheres = await publishRecipe('seasons-hemispheres');
    part3 = await publishRecipe('seasons-elsewhere');
    limits = await publishRecipe('seasons-limits');
    const admitted = await admitLibraryContinuityUseCase(database.db)({ dryRun: false });
    // Four series steps and Part 3's related move to seasons-limits.
    expect(admitted).toMatchObject({ seriesRevisionsAdmitted: 1, linksAdmitted: 5 });
    elsewhere.push(await admitScroll('earth.tides'), await admitScroll('space.stars'));
    // A Reel on the Seasons topic: if format were free it would rank beside the Seasons parts.
    reels.push(await admitReel(SEASONS_TOPIC), await admitReel('earth.tides'));
  });

  describe('from Seasons Part 1, a Scroll', () => {
    it('next offers a different topic as a Scroll, never Part 2, Part 3 or the related move, and says why in the decision', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      const next = ready(await nextSubject(person, stand, 'scroll'));
      const offered = offers(next);
      expect(offered.length).toBeGreaterThan(0);
      const ids = offered.map((offer) => offer.assetId);
      expect(ids).not.toContain(hemispheres.assetId);
      expect(ids).not.toContain(part3.assetId);
      expect(ids).not.toContain(limits.assetId);
      expect(ids).not.toContain(seasons.assetId);
      expect(ids.sort()).toEqual(elsewhere.map((scroll) => scroll.assetId).sort());
      expect(offered.every((offer) => offer.metadata.kind === 'scroll')).toBe(true);
      expect(offered.every((offer) => offer.relation.kind === 'discovery')).toBe(true);

      const decision = await decisionOf(next.decisionId);
      expect(exclusionsIn(decision, hemispheres.assetId)).toEqual(['same_series']);
      expect(exclusionsIn(decision, part3.assetId)).toEqual(['same_series']);
      // seasons-limits is on the planet but is the thread's other perspective, reached by its own tab.
      expect(exclusionsIn(decision, limits.assetId)).toEqual(['related_target']);
      expect(decision.relatedTarget).toEqual({ outcome: 'applied', matched: 1 });
      expect(decision.input.intent.relatedAssetIds).toEqual([limits.assetId]);
      expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'kept' });
      for (const reel of reels) expect(exclusionsIn(decision, reel.assetId)).toEqual(['format_sticky']);
      expect(decision.input.intent).toMatchObject({ stickyFormat: 'scroll', currentSeriesId: 'library.earth.seasons' });
    });

    it('the series is left in both directions and for a client that names no format; the Part move still reaches it', async () => {
      const moves = [
        ['next', undefined],
        ['previous', 'scroll'],
      ] as const;
      for (const [direction, format] of moves) {
        const person = await seedPerson(database.db);
        const stand = await standOn(person, seasons);
        const ids = offers(ready(await nextSubject(person, stand, format, direction))).map((offer) => offer.assetId);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).not.toContain(hemispheres.assetId);
        expect(ids).not.toContain(part3.assetId);
        expect(ids).not.toContain(limits.assetId);
      }

      // The stored decision of a move that names no format has no format preference: today's ranking, minus the series.
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      const decision = await decisionOf(ready(await nextSubject(person, stand)).decisionId);
      expect(decision.stickyFormat).toBeUndefined();
      expect(decision.input.intent.stickyFormat).toBeUndefined();
      expect(decision.input.intent.currentSeriesId).toBe('library.earth.seasons');

      // The Part move is how the series is reached.
      const reader = await seedPerson(database.db);
      const reading = await standOn(reader, seasons);
      const part = await cases.navigate(reader.authority, {
        commandId: randomUUID(),
        sessionId: reading.open.sessionId,
        expectedIntentRevision: reading.open.intentRevision,
        from: reading.from,
        intent: { mode: 'series', direction: 'next' },
      });
      expect(ready(part).offer).toMatchObject({
        assetId: hemispheres.assetId,
        relation: { kind: 'series_step', part: 2 },
      });
    });

    it('a Scroll that is the only one left falls back to a Reel, and says so', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      // Hide the other Scrolls for this person alone, as the person's own Hide would.
      for (const scroll of elsewhere)
        await cases.applyEncounterAction(person.authority, {
          commandId: randomUUID(),
          kind: 'hide',
          target: scroll,
        });
      const next = ready(await nextSubject(person, stand, 'scroll'));
      expect(offers(next).every((offer) => offer.metadata.kind === 'reel')).toBe(true);
      expect((await decisionOf(next.decisionId)).stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
    });
  });

  describe('the related move of the thread (D-136)', () => {
    it('is not offered from the Part that owns the Related tab either', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, part3);
      const next = ready(await nextSubject(person, stand, 'scroll'));
      const ids = offers(next).map((offer) => offer.assetId);
      expect(ids).not.toContain(limits.assetId);
      expect(ids).not.toContain(seasons.assetId);
      expect(ids).not.toContain(hemispheres.assetId);
      const decision = await decisionOf(next.decisionId);
      expect(decision.relatedTarget).toEqual({ outcome: 'applied', matched: 1 });
      expect(exclusionsIn(decision, limits.assetId)).toEqual(['related_target']);
    });

    it('is reached by the Related tab, which still opens it', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, part3);
      const related = await cases.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: stand.open.sessionId,
        expectedIntentRevision: stand.open.intentRevision,
        from: stand.from,
        intent: { mode: 'related' },
      });
      expect(ready(related).offer).toMatchObject({
        assetId: limits.assetId,
        relation: { kind: 'related_move' },
      });
    });

    it('is offered when it is all there is, and the decision says the rule stepped aside', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      for (const other of [...elsewhere, ...reels])
        await cases.applyEncounterAction(person.authority, { commandId: randomUUID(), kind: 'hide', target: other });
      const next = ready(await nextSubject(person, stand, 'scroll'));
      expect(offers(next).map((offer) => offer.assetId)).toEqual([limits.assetId]);
      const decision = await decisionOf(next.decisionId);
      expect(decision.relatedTarget).toEqual({ outcome: 'fell_back', matched: 1 });
      // The series stays out even then.
      expect(exclusionsIn(decision, hemispheres.assetId)).toEqual(['same_series']);
    });
  });

  describe('from a Reel', () => {
    it('next offers a Reel when one is eligible, although the Scrolls of its topic rank higher', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, reels[0]!);
      const next = ready(await nextSubject(person, stand, 'reel'));
      expect(offers(next).map((offer) => offer.assetId)).toEqual([reels[1]!.assetId]);
      expect(offers(next).every((offer) => offer.metadata.kind === 'reel')).toBe(true);
      const decision = await decisionOf(next.decisionId);
      expect(decision.stickyFormat).toEqual({ preferred: 'reel', outcome: 'kept' });
      // The Seasons Scrolls match the Reel's topic, so without the format rule they would lead.
      for (const scroll of [seasons, hemispheres, part3]) {
        expect(exclusionsIn(decision, scroll.assetId)).toEqual(['format_sticky']);
        expect(decision.evaluations.find((e) => e.assetId === scroll.assetId)?.features.intent).toBe(1);
      }
    });

    it('offers the other format only when no Reel is left, and the decision says it fell back', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, reels[0]!);
      await cases.applyEncounterAction(person.authority, { commandId: randomUUID(), kind: 'hide', target: reels[1]! });
      const next = ready(await nextSubject(person, stand, 'reel'));
      expect(offers(next).length).toBeGreaterThan(0);
      expect(offers(next).every((offer) => offer.metadata.kind === 'scroll')).toBe(true);
      expect((await decisionOf(next.decisionId)).stickyFormat).toEqual({ preferred: 'reel', outcome: 'fell_back' });
    });

    it('a client that names no format is ranked as before: no format rule, and the Scrolls of its topic lead', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, reels[0]!);
      const next = ready(await nextSubject(person, stand));
      const decision = await decisionOf(next.decisionId);
      expect(decision.stickyFormat).toBeUndefined();
      expect(decision.input.intent.stickyFormat).toBeUndefined();
      expect(decision.evaluations.some((evaluation) => evaluation.exclusions.includes('format_sticky'))).toBe(false);
      // Both formats are in play. The first slot is the ranked winner nine times in ten and an exploration pick
      // otherwise, so the ranking is what this asserts, not the first offer.
      const kindOf = (assetId: string | undefined) =>
        decision.input.candidates.find((candidate) => candidate.encounter.assetId === assetId)?.encounter.kind;
      const eligible = decision.evaluations.filter((evaluation) => evaluation.eligible);
      expect(new Set(eligible.map((evaluation) => kindOf(evaluation.assetId)))).toEqual(new Set(['scroll', 'reel']));
      expect(kindOf(decision.exploration.rankedWinner?.assetId)).toBe('scroll');
    });
  });

  describe('a worker-prepared buffer', () => {
    it('is ranked without the series and served to a move in the format it was ranked for', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      const buffer = await prepareFor(person.universeId);
      expect(buffer.selection.map((s) => s.assetId)).not.toContain(hemispheres.assetId);
      expect(buffer.selection.map((s) => s.assetId)).not.toContain(part3.assetId);
      expect(buffer.selection.map((s) => s.assetId)).not.toContain(limits.assetId);
      const decision = await decisionOf(buffer.decision_id);
      expect(decision.relatedTarget).toEqual({ outcome: 'applied', matched: 1 });
      expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'kept' });

      const next = ready(await nextSubject(person, stand, 'scroll'));
      expect(next.decisionId).toBe(buffer.decision_id);
      expect(offers(next).map((offer) => offer.assetId)).toEqual(buffer.selection.map((s) => s.assetId));
    });

    it.each([
      ['a move to the other format', 'reel' as const],
      ['a client that names no format', undefined],
    ])('is not served to %s, which is ranked afresh', async (_name, format) => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      const buffer = await prepareFor(person.universeId);
      const next = ready(await nextSubject(person, stand, format));
      expect(next.decisionId).not.toBe(buffer.decision_id);
      const kinds = new Set(offers(next).map((offer) => offer.metadata.kind));
      if (format === 'reel') expect([...kinds]).toEqual(['reel']);
      const ids = offers(next).map((offer) => offer.assetId);
      expect(ids).not.toContain(hemispheres.assetId);
      expect(ids).not.toContain(part3.assetId);
      expect(ids).not.toContain(limits.assetId);
    });
  });

  // Last on purpose: these Reels are format twins of Seasons parts, and the groups above would rank them.
  describe('format twins of the series (D-131)', () => {
    let reelOfPart1: Awaited<ReturnType<typeof admitReel>>;
    let reelOfPart2: Awaited<ReturnType<typeof admitReel>>;

    beforeAll(async () => {
      reelOfPart1 = await admitReel(SEASONS_TOPIC, 'ci-vertical-seasons');
      reelOfPart2 = await admitReel(SEASONS_TOPIC, 'ci-vertical-seasons-hemispheres');
    });

    it('from Part 1, the Reel of Part 2 is not offered even when no Scroll is left', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, seasons);
      for (const scroll of elsewhere)
        await cases.applyEncounterAction(person.authority, { commandId: randomUUID(), kind: 'hide', target: scroll });
      const next = ready(await nextSubject(person, stand, 'scroll'));
      const ids = offers(next).map((offer) => offer.assetId);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(reelOfPart2.assetId);
      expect(ids).not.toContain(reelOfPart1.assetId);
      const decision = await decisionOf(next.decisionId);
      expect(exclusionsIn(decision, reelOfPart2.assetId)).toContain('same_series');
      // No Scroll was eligible, so the other format was offered, and only Reels of other topics.
      expect(decision.stickyFormat).toEqual({ preferred: 'scroll', outcome: 'fell_back' });
      expect(ids.sort()).toEqual(reels.map((reel) => reel.assetId).sort());
    });

    it('from the Reel of Part 1, next leaves the series: the series is the one of its Scroll twin', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, reelOfPart1);
      const next = ready(await nextSubject(person, stand, 'reel'));
      const ids = offers(next).map((offer) => offer.assetId);
      expect(ids.sort()).toEqual(reels.map((reel) => reel.assetId).sort());
      const decision = await decisionOf(next.decisionId);
      expect(decision.input.intent).toMatchObject({
        currentSeriesId: 'library.earth.seasons',
        stickyFormat: 'reel',
        relatedAssetIds: [limits.assetId],
      });
      expect(exclusionsIn(decision, reelOfPart2.assetId)).toContain('same_series');
      expect(exclusionsIn(decision, hemispheres.assetId)).toContain('same_series');
      expect(decision.stickyFormat).toEqual({ preferred: 'reel', outcome: 'kept' });
    });
  });

  // Last of all: policy v2 (#674). A person always gets new content; what they asked for is never a repeat.
  describe('policy v2: a person always gets new content (real PostgreSQL, labelled CI fixtures)', () => {
    let v2: Cases;
    const topic = 'ci.newcontent.topic';
    const own: Awaited<ReturnType<typeof admitScroll>>[] = [];
    let ownReel: Awaited<ReturnType<typeof admitReel>>;

    beforeAll(async () => {
      v2 = await scrollUseCases(database, { composerPolicy: 'v2' });
      for (let n = 0; n < 3; n += 1) own.push(await admitScroll(topic));
      ownReel = await admitReel(topic);
    });
    afterAll(async () => {
      await v2.close();
    });

    const unitOf = async (assetId: string) =>
      (
        await sql<{
          explanation_unit_id: string;
        }>`select explanation_unit_id from content.asset_revisions where asset_id=${assetId}::uuid`.execute(database.db)
      ).rows[0]!.explanation_unit_id;
    const standOnV2 = (person: FixturePerson, target: { assetId: string; assetRevision: number }) =>
      standOn(person, target, v2);
    const nextV2 = (
      person: FixturePerson,
      stand: Awaited<ReturnType<typeof standOn>>,
      format?: Format,
      direction: 'next' | 'previous' = 'next',
    ) => nextSubject(person, stand, format, direction, v2);

    /** Every admitted asset of the kind, in a fixed order: the person meets each by standing on it. */
    async function meetEvery(person: FixturePerson, kind: Format, except: readonly string[] = []) {
      const assets = (
        await sql<{
          id: string;
          revision: number;
        }>`select id,revision from content.assets where status='admitted' and kind=${kind} order by id`.execute(
          database.db,
        )
      ).rows.filter((asset) => !except.includes(asset.id));
      const stands: Awaited<ReturnType<typeof standOn>>[] = [];
      for (const asset of assets)
        stands.push(await standOnV2(person, { assetId: asset.id, assetRevision: asset.revision }));
      return { assets, stands };
    }

    const metUnits = async (offered: readonly { assetId: string }[], met: readonly string[]) => {
      const units = new Set(await Promise.all(met.map(unitOf)));
      return (await Promise.all(offered.map((offer) => unitOf(offer.assetId)))).filter((unit) => units.has(unit));
    };

    it('stores the decision under composer-policy.v2 and records its tier and where the offer sits', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOnV2(person, own[0]!);
      const next = ready(await nextV2(person, stand, 'scroll'));
      const row = (
        await sql<{
          policy_version: string;
        }>`select policy_version from composer.decisions where id=${next.decisionId}::uuid`.execute(database.db)
      ).rows[0]!;
      expect(row.policy_version).toBe('composer-policy.v2');
      const decision = await decisionOf(next.decisionId);
      expect(decision.unseenLadder).toMatchObject({ outcome: 'unseen' });
      // The two other Scrolls of the topic are unseen and eligible beside the rest of the library: where an offer sits is
      // recorded, and the ranking does not read it.
      expect(decision.unseenLadder?.eligible.source_topic).toBe(2);
      expect(decision.unseenLadder?.eligible.elsewhere).toBeGreaterThan(0);
      expect(decision.unseenLadder?.offerPlaces).toHaveLength(offers(next).length);
    });

    it('a person who has met everything in a topic gets something unseen from elsewhere', async () => {
      const person = await seedPerson(database.db);
      await standOnV2(person, own[0]!);
      await standOnV2(person, own[1]!);
      const stand = await standOnV2(person, own[2]!);
      const next = ready(await nextV2(person, stand, 'scroll'));
      const offered = offers(next);
      expect(offered.length).toBeGreaterThan(0);
      expect(
        await metUnits(
          offered,
          own.map((scroll) => scroll.assetId),
        ),
      ).toEqual([]);
      const decision = await decisionOf(next.decisionId);
      for (const scroll of own.slice(0, 2))
        expect(exclusionsIn(decision, scroll.assetId)).toEqual(['already_encountered']);
      // Nothing unseen is left in the topic, so what is offered sits elsewhere, and the decision did not fall back to a repeat.
      expect(decision.unseenLadder).toMatchObject({ outcome: 'unseen', eligible: { source_topic: 0 } });
      expect(decision.unseenLadder?.offerPlaces.every((place) => place !== 'source_topic')).toBe(true);
    });

    it('a Reel watcher who has met every Reel gets an unseen Scroll', async () => {
      const person = await seedPerson(database.db);
      const { stands } = await meetEvery(person, 'reel');
      const next = ready(await nextV2(person, stands.at(-1)!, 'reel'));
      expect(offers(next).length).toBeGreaterThan(0);
      expect(offers(next).every((offer) => offer.metadata.kind === 'scroll')).toBe(true);
      const decision = await decisionOf(next.decisionId);
      expect(decision.stickyFormat).toEqual({ preferred: 'reel', outcome: 'fell_back' });
      expect(decision.unseenLadder).toMatchObject({ outcome: 'unseen' });
    });

    it('only when nothing unseen exists in either format is a met one offered, the least recently met first, and it is counted', async () => {
      const person = await seedPerson(database.db);
      const scrolls = (
        await sql<{
          id: string;
        }>`select id from content.assets where status='admitted' and kind='scroll' order by id`.execute(database.db)
      ).rows.map((row) => row.id);
      // Meet every Reel, then every Scroll, ending on the Scroll with no series and no links.
      const last = own[2]!;
      await meetEvery(person, 'reel');
      const { assets, stands } = await meetEvery(person, 'scroll', [last.assetId]);
      stands.push(await standOnV2(person, last));
      const first = assets[0]!;
      expect(scrolls).toContain(first.id);
      const next = ready(await nextV2(person, stands.at(-1)!, 'scroll'));
      expect(offers(next).length).toBeGreaterThan(0);
      // The Scroll the person met first of all comes first, whatever the ranking would have said.
      expect(offers(next)[0]!.assetId).toBe(first.id);
      const decision = await decisionOf(next.decisionId);
      expect(decision.unseenLadder).toMatchObject({ outcome: 'fell_back' });
      expect(decision.unseenLadder!.offerPlaces).toHaveLength(offers(next).length);
      // Every eligible candidate is one the person has met: the counts by place add up to the eligible ones.
      const eligibleCount = decision.evaluations.filter((evaluation) => evaluation.eligible).length;
      expect(Object.values(decision.unseenLadder!.eligible).reduce((sum, n) => sum + n, 0)).toBe(eligibleCount);
      expect(eligibleCount).toBeGreaterThan(0);
      expect(decision.exploration).toMatchObject({ branch: 'ranked', pool: [] });
    });

    it('what the person asks for is never a repeat: a return, a part, the related move and the other format all still open what they met', async () => {
      const person = await seedPerson(database.db);
      // Return: standing on something already met works as ever.
      await standOnV2(person, own[0]!);
      const again = await standOnV2(person, own[0]!);
      expect(again.open.offer).toMatchObject({ assetId: own[0]!.assetId, relation: { kind: 'return' } });

      // The other format of what the person is on: the Reel twin of a Scroll they have met.
      const twin = await admitReel(topic, await unitOf(own[1]!.assetId));
      const onScroll = await standOnV2(person, own[1]!);
      const variant = await v2.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: onScroll.open.sessionId,
        expectedIntentRevision: onScroll.open.intentRevision,
        from: onScroll.from,
        intent: { mode: 'variant', to: 'reel' },
      });
      expect(ready(variant).offer).toMatchObject({ assetId: twin.assetId, relation: { kind: 'format_variant' } });
      expect(ownReel.assetId).not.toBe(twin.assetId);

      // A series part and a related move, after the person has met both ends.
      await standOnV2(person, hemispheres);
      const onPart1 = await standOnV2(person, seasons);
      const part = await v2.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: onPart1.open.sessionId,
        expectedIntentRevision: onPart1.open.intentRevision,
        from: onPart1.from,
        intent: { mode: 'series', direction: 'next' },
      });
      expect(ready(part).offer).toMatchObject({
        assetId: hemispheres.assetId,
        relation: { kind: 'series_step', part: 2 },
      });
      await standOnV2(person, limits);
      const onPart3 = await standOnV2(person, part3);
      const related = await v2.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: onPart3.open.sessionId,
        expectedIntentRevision: onPart3.open.intentRevision,
        from: onPart3.from,
        intent: { mode: 'related' },
      });
      expect(ready(related).offer).toMatchObject({ assetId: limits.assetId, relation: { kind: 'related_move' } });
      // None of those decisions records a tier: they are the person's own moves.
      for (const outcome of [variant, part, related]) {
        const decisionId = ready(outcome).decisionId;
        expect((await decisionOf(decisionId)).unseenLadder).toBeUndefined();
      }
    });

    it('the same history ranked under v0 still offers what was met: v0 decisions are untouched and keep replaying', async () => {
      const person = await seedPerson(database.db);
      await standOnV2(person, own[0]!);
      await standOnV2(person, own[1]!);
      const stand = await standOnV2(person, own[2]!);
      // The v0 composition ranks the same person: the met Scrolls of the topic match it and are only softly penalised.
      const next = ready(await nextSubject(person, stand, 'scroll'));
      const decision = await decisionOf(next.decisionId);
      expect(decision.policyVersion).toBe('composer-policy.v0');
      expect(decision.unseenLadder).toBeUndefined();
      expect(exclusionsIn(decision, own[0]!.assetId)).toEqual([]);
      expect(
        (
          await sql`select id from composer.decisions where id=${next.decisionId}::uuid and policy_version='composer-policy.v0'`.execute(
            database.db,
          )
        ).rows,
      ).toHaveLength(1);
    });
  });
});
