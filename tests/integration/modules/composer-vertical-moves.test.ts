import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  COMPOSER_POLICY_V0,
  composeEncounter,
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
import { REASONING_HARNESS } from '@knowscroll/backend/reasoning';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { RECIPES, type RecipeKey } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureHarness } from '../support/fixture-model.js';
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
  async function standOn(person: FixturePerson, target: { assetId: string; assetRevision: number }) {
    const open = ready(
      await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'return', ...target },
        capabilities: bothFormats,
      }),
    );
    const activated = await cases.activateOffer(person.authority, {
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
  ) =>
    cases.navigate(person.authority, {
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
    const { harness } = fixtureHarness(database.db, { model: undefined });
    const values = new Map<symbol, unknown>([
      [WITH_SCOPE, withScope()],
      [WORKER_CONFIG, { jevEnabled: false, reasoning: {} }],
      [REASONING_HARNESS, harness],
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

    it('a client that names no format is ranked with no format rule, and the Scrolls of its topic lead under policy v0', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOn(person, reels[0]!);
      const next = ready(await nextSubject(person, stand));
      const decision = await decisionOf(next.decisionId);
      expect(decision.stickyFormat).toBeUndefined();
      expect(decision.input.intent.stickyFormat).toBeUndefined();
      expect(decision.evaluations.some((evaluation) => evaluation.exclusions.includes('format_sticky'))).toBe(false);
      // Both formats are in play. The first slot is the ranked winner nine times in ten and an exploration pick
      // otherwise, so the ranking is what this asserts, not the first offer.
      const candidateOf = (assetId: string | undefined) =>
        decision.input.candidates.find((candidate) => candidate.encounter.assetId === assetId)?.encounter;
      const eligible = decision.evaluations.filter((evaluation) => evaluation.eligible);
      expect(new Set(eligible.map((evaluation) => candidateOf(evaluation.assetId)?.kind))).toEqual(
        new Set(['scroll', 'reel']),
      );
      const onSeasons = (assetId: string | undefined) =>
        candidateOf(assetId)?.topics.some((topic) => topic.topicId === SEASONS_TOPIC) === true;
      expect(decision.policyVersion).toBe('composer-policy.v1');
      // The same input under the policy it replaced ranks a Scroll of the Reel's own topic first, as it did.
      const before = composeEncounter(decision.input, COMPOSER_POLICY_V0);
      expect(candidateOf(before.exploration.rankedWinner?.assetId)?.kind).toBe('scroll');
      expect(onSeasons(before.exploration.rankedWinner?.assetId)).toBe(true);
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
});
