import { catalogueOf } from '../support/catalogue.js';
import { CATALOGUE } from '@knowscroll/backend/modules/content';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  PREPARE_COMPOSER_BUFFER,
  composeEncounter,
  policyOf,
  prepareBufferQueue,
  readUnseenFirst,
  type ComposerDecision,
  type PrepareBuffer,
  type PrepareBufferJob,
} from '@knowscroll/backend/modules/composer';
import { composerBufferWorkerProviders, composerProviders } from '@knowscroll/backend/modules/composer/nest-providers';
import {
  admitLibraryContinuityUseCase,
  contentProviders,
  readDiscoveryCandidates,
} from '@knowscroll/backend/modules/content/nest-providers';
import { experienceBufferSourceProviders, readMetUnitIds } from '@knowscroll/backend/modules/experience/nest-providers';
import { READ_COMPOSER_CONTEXT, READ_INTEREST_CONTEXT } from '@knowscroll/backend/modules/personal-context';
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
  function worker(policy?: 'v2' | 'v3'): PrepareBuffer {
    const { harness } = fixtureRecordingHarness(database.db, { model: undefined });
    const values = new Map<symbol, unknown>([
      [CATALOGUE, catalogueOf(database.db)],
      [WITH_SCOPE, withScope()],
      [WORKER_CONFIG, { jevEnabled: false, reasoning: {} }],
      [RECORDING_REASONING_HARNESS, harness],
      [READ_COMPOSER_CONTEXT, cases.readComposerContext],
      [READ_INTEREST_CONTEXT, cases.readInterestContext],
      ...[
        ...experienceBufferSourceProviders(),
        ...composerProviders({ isOperator: () => false }, policy),
        ...contentProviders(),
      ].map((provider) => [provider.provide, provider.useValue] as const),
    ]);
    return buildFromProviders(
      composerBufferWorkerProviders({ withPersonalScope: WITH_SCOPE, workerConfig: WORKER_CONFIG }),
      PREPARE_COMPOSER_BUFFER,
      values,
    ) as PrepareBuffer;
  }
  const prepareFor = async (universeId: string, policy?: 'v2' | 'v3') => {
    const [job] = (
      await sql<{
        data: PrepareBufferJob;
      }>`select data from pgboss.job where name=${prepareBufferQueue.name} and data->>'universeId'=${universeId} order by created_on`.execute(
        database.db,
      )
    ).rows;
    const result = await worker(policy)(job!.data, { jobId: randomUUID(), signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: 'prepared' });
    return (
      await sql<{
        decision_id: string;
        selection: { assetId: string; assetRevision: number }[];
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
      v2 = await scrollUseCases(database, { composerPolicy: 'v2', buffers: true });
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

    describe('what the person met after a ranking is never offered (serve time, D-408)', () => {
      const bufferExists = async (decisionId: string) =>
        (await sql`select 1 from composer.buffers where decision_id=${decisionId}::uuid`.execute(database.db)).rows
          .length > 0;

      it('serves a buffer whose offers are all still unseen, as before', async () => {
        const person = await seedPerson(database.db);
        const stand = await standOnV2(person, own[0]!);
        const buffer = await prepareFor(person.universeId, 'v2');
        expect((await decisionOf(buffer.decision_id)).unseenLadder).toMatchObject({ outcome: 'unseen' });
        const next = ready(await nextV2(person, stand, 'scroll'));
        expect(next.decisionId).toBe(buffer.decision_id);
        expect(offers(next).map((offer) => offer.assetId)).toEqual(buffer.selection.map((s) => s.assetId));
      });

      it('discards a buffer when an offer in it was met meanwhile (another device or tab), and ranks the move again', async () => {
        const person = await seedPerson(database.db);
        const stand = await standOnV2(person, own[0]!);
        const buffer = await prepareFor(person.universeId, 'v2');
        const metMeanwhile = buffer.selection[0]!;
        // The person opens that very explanation somewhere else inside the buffer's ten minutes.
        await standOnV2(person, metMeanwhile);
        const next = ready(await nextV2(person, stand, 'scroll'));
        expect(next.decisionId).not.toBe(buffer.decision_id);
        expect(offers(next).map((offer) => offer.assetId)).not.toContain(metMeanwhile.assetId);
        expect(offers(next).length).toBeGreaterThan(0);
        expect(await bufferExists(buffer.decision_id)).toBe(false);
        expect((await decisionOf(next.decisionId)).policyVersion).toBe('composer-policy.v2');
      });

      it('rechecks a ranking made moments before too: an activation between the two navigation transactions', async () => {
        const person = await seedPerson(database.db);
        // Every explanation but the source's and one is met in the gap, so only the one is left to offer.
        const keeper = own[1]!;
        let afterRanking: (() => Promise<void>) | undefined;
        const raced = await scrollUseCases(database, {
          composerPolicy: 'v2',
          wrapScope: (scope) => async (authority, work) => {
            const result = await scope(authority, work);
            const hook = afterRanking;
            afterRanking = undefined;
            if (hook) await hook();
            return result;
          },
        });
        try {
          const stand = await standOn(person, own[0]!, raced);
          afterRanking = async () => {
            // Everything but the source's explanation and the keeper's, whichever format it is in (a Reel twin shares its unit).
            const keep = [await unitOf(own[0]!.assetId), await unitOf(keeper.assetId)];
            const everything = (
              await sql<{
                id: string;
                revision: number;
              }>`select a.id,a.revision from content.assets a join content.asset_revisions r on r.asset_id=a.id and r.revision=a.revision
                where a.status='admitted' and not (r.explanation_unit_id = any(${keep}::text[])) order by a.id`.execute(
                database.db,
              )
            ).rows;
            for (const asset of everything)
              await standOnV2(person, { assetId: asset.id, assetRevision: asset.revision });
          };
          const next = ready(await nextSubject(person, stand, 'scroll', 'next', raced));
          // The stale ranking was refused under the lock and the move ranked again: only what is still unseen is offered.
          expect(offers(next).map((offer) => offer.assetId)).toEqual([keeper.assetId]);
          expect((await decisionOf(next.decisionId)).unseenLadder).toMatchObject({ outcome: 'unseen' });
        } finally {
          await raced.close();
        }
      });
    });

    it('retrieval, with the met units read through Experience, reads the explanations the person has not met before the ones they have', async () => {
      const person = await seedPerson(database.db);
      await standOnV2(person, own[0]!);
      await standOnV2(person, own[1]!);
      const read = await withScope()(person.authority, async (scope) =>
        readDiscoveryCandidates(scope, {
          languages: ['en'],
          formats: ['scroll'],
          capabilities: bothFormats,
          limit: 100,
          unseenFirst: await readUnseenFirst(readMetUnitIds, scope),
          alwaysUnits: [],
        }),
      );
      if (read.kind !== 'entered') throw new Error('CI scope refused');
      const units = read.value.map((candidate) => candidate.explanationUnitId);
      const metUnits = new Set([await unitOf(own[0]!.assetId), await unitOf(own[1]!.assetId)]);
      const firstMet = units.findIndex((unit) => metUnits.has(unit));
      expect(firstMet).toBeGreaterThan(0);
      // Every unseen explanation precedes the first met one, and the met ones are still there as the last resort's material.
      expect(units.slice(0, firstMet).some((unit) => metUnits.has(unit))).toBe(false);
      expect(units.slice(firstMet).filter((unit) => metUnits.has(unit))).toHaveLength(2);
      // For a person who has met nothing the order is the plain one.
      const fresh = await seedPerson(database.db);
      const plain = await withScope()(fresh.authority, (scope) =>
        readDiscoveryCandidates(scope, {
          languages: ['en'],
          formats: ['scroll'],
          capabilities: bothFormats,
          limit: 100,
        }),
      );
      const conditional = await withScope()(fresh.authority, async (scope) =>
        readDiscoveryCandidates(scope, {
          languages: ['en'],
          formats: ['scroll'],
          capabilities: bothFormats,
          limit: 100,
          unseenFirst: await readUnseenFirst(readMetUnitIds, scope),
        }),
      );
      if (plain.kind !== 'entered' || conditional.kind !== 'entered') throw new Error('CI scope refused');
      expect(conditional.value.map((c) => c.assetId)).toEqual(plain.value.map((c) => c.assetId));
    });

    describe('the met units port (Experience, newest first, bounded)', () => {
      const metOf = (person: FixturePerson, limit: number) =>
        withScope()(person.authority, (scope) => readMetUnitIds(scope, { limit }));

      it('reports the explanations the person has met, newest first, once each, and nobody else’s', async () => {
        const person = await seedPerson(database.db);
        const stranger = await seedPerson(database.db);
        await standOnV2(person, own[0]!);
        await standOnV2(person, own[1]!);
        await standOnV2(stranger, own[2]!);
        const met = await metOf(person, 50);
        if (met.kind !== 'entered') throw new Error('CI scope refused');
        expect(met.value).toEqual({
          unitIds: [await unitOf(own[1]!.assetId), await unitOf(own[0]!.assetId)],
          truncated: false,
        });
        const fresh = await metOf(await seedPerson(database.db), 50);
        if (fresh.kind !== 'entered') throw new Error('CI scope refused');
        expect(fresh.value).toEqual({ unitIds: [], truncated: false });
      });

      it('reports the explanation unit of a Reel too: the unit, never the asset', async () => {
        const person = await seedPerson(database.db);
        await standOnV2(person, ownReel);
        const met = await metOf(person, 50);
        if (met.kind !== 'entered') throw new Error('CI scope refused');
        expect(met.value.unitIds).toEqual([await unitOf(ownReel.assetId)]);
      });

      it('keeps the newest units and says so when the bound cuts, and not when it does not', async () => {
        const person = await seedPerson(database.db);
        await standOnV2(person, own[0]!);
        await standOnV2(person, own[1]!);
        await standOnV2(person, own[2]!);
        const cut = await metOf(person, 2);
        if (cut.kind !== 'entered') throw new Error('CI scope refused');
        expect(cut.value).toEqual({
          unitIds: [await unitOf(own[2]!.assetId), await unitOf(own[1]!.assetId)],
          truncated: true,
        });
        const exact = await metOf(person, 3);
        if (exact.kind !== 'entered') throw new Error('CI scope refused');
        expect(exact.value.truncated).toBe(false);
        expect(exact.value.unitIds).toHaveLength(3);
      });

      it('refuses a bound that is not a positive whole number within the most it will read', async () => {
        const person = await seedPerson(database.db);
        for (const limit of [0, -1, 1.5, 5001, Number.NaN])
          await expect(metOf(person, limit)).rejects.toThrow('MET_UNITS_LIMIT');
      });
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

  // Policy v3 (#674, slices 4.2 and 5.2, D-420): retrieval lanes, long-term interest with roll-ups, and a logged format exploration.
  describe('policy v3: lanes, long-term interest and format exploration (real PostgreSQL, labelled CI fixtures)', () => {
    let v3: Cases;
    const own: Awaited<ReturnType<typeof admitScroll>>[] = [];
    const holes: Awaited<ReturnType<typeof admitScroll>>[] = [];
    const v3Reels: Awaited<ReturnType<typeof admitReel>>[] = [];

    beforeAll(async () => {
      v3 = await scrollUseCases(database, { composerPolicy: 'v3', buffers: true });
      for (let n = 0; n < 3; n += 1) own.push(await admitScroll('computing.algorithms'));
      for (let n = 0; n < 3; n += 1) holes.push(await admitScroll('space.black-holes'));
      for (let n = 0; n < 4; n += 1) v3Reels.push(await admitReel('history.industrial-revolution'));
    });
    afterAll(async () => {
      await v3.close();
    });

    const standOnV3 = (person: FixturePerson, target: { assetId: string; assetRevision: number }) =>
      standOn(person, target, v3);
    const nextV3 = (person: FixturePerson, stand: Awaited<ReturnType<typeof standOn>>, format?: Format) =>
      nextSubject(person, stand, format, 'next', v3);
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : v,
      );
    /** A deterministic command id, so the seed (and so every draw) of each navigation is the same on every run. */
    const commandId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

    it('stores the decision under composer-policy.v3 with the lane of every candidate and the system of every topic, and replays it', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOnV3(person, own[0]!);
      const next = ready(await nextV3(person, stand, 'scroll'));
      const row = (
        await sql<{
          policy_version: string;
        }>`select policy_version from composer.decisions where id=${next.decisionId}::uuid`.execute(database.db)
      ).rows[0]!;
      expect(row.policy_version).toBe('composer-policy.v3');
      const decision = await decisionOf(next.decisionId);
      expect(decision.input.candidates.length).toBeGreaterThan(5);
      expect(decision.input.candidates.every((c) => c.encounter.lane !== undefined)).toBe(true);
      const lanes = new Set(decision.input.candidates.map((c) => c.encounter.lane));
      expect(lanes.has('source')).toBe(true);
      expect(lanes.has('explore')).toBe(true);
      // The catalogue systems of the candidates' topics are frozen into the snapshot.
      const systems = new Map((decision.input.evidence?.topicSystems ?? []).map((t) => [t.topicId, t.systemId]));
      expect(systems.get('space.black-holes')).toBe('space');
      expect(systems.get('computing.algorithms')).toBe('computing');
      // A person with no history has no roll-up: absence is not zero.
      expect(decision.input.evidence?.person).toBeUndefined();
      expect(decision.input.evidence?.systems).toBeUndefined();
      // The unseen-first guarantee of v2 stands under v3.
      expect(decision.unseenLadder).toMatchObject({ outcome: 'unseen' });
      expect(canonical(composeEncounter(decision.input, policyOf(decision.policyVersion)))).toBe(canonical(decision));
    });

    it('logs the format exploration of a system-chosen move with its propensity, and the draws take an unseen Reel first, about 5% of the time', async () => {
      const N = 160;
      let drawn = 0;
      let considered = 0;
      for (let n = 0; n < N; n += 1) {
        const person = await seedPerson(database.db);
        const stand = await standOnV3(person, own[n % own.length]!);
        const next = ready(
          await v3.navigate(person.authority, {
            commandId: commandId(n + 1),
            sessionId: stand.open.sessionId,
            expectedIntentRevision: stand.open.intentRevision,
            from: stand.from,
            intent: { mode: 'vertical', direction: 'next', format: 'scroll' },
          }),
        );
        const decision = await decisionOf(next.decisionId);
        expect(decision.formatExploration).toMatchObject({ fraction: 0.05, personFormat: 'scroll' });
        considered += 1;
        if (decision.formatExploration?.branch === 'other_format') {
          drawn += 1;
          expect(decision.formatExploration.propensity).toBe(0.05);
          expect(decision.exploration.selectedProbability).toBe(0.05);
          expect(offers(next)[0]!.metadata.kind).toBe('reel');
          expect(decision.unseenLadder).toMatchObject({ outcome: 'unseen' });
        } else {
          expect(decision.formatExploration?.propensity).toBe(0.95);
          expect(offers(next)[0]!.metadata.kind).toBe('scroll');
        }
        // Every stored decision replays under its own label, drawn or not.
        if (n < 20)
          expect(canonical(composeEncounter(decision.input, policyOf(decision.policyVersion)))).toBe(
            canonical(decision),
          );
      }
      expect(considered).toBe(N);
      expect(drawn / N).toBeGreaterThan(0.01);
      expect(drawn / N).toBeLessThan(0.12);
    }, 90_000);

    it('does not draw against an explicit format request: a variant move names its format', async () => {
      const person = await seedPerson(database.db);
      const twinned = own[0]!;
      const unit = (
        await sql<{
          explanation_unit_id: string;
        }>`select explanation_unit_id from content.asset_revisions where asset_id=${twinned.assetId}::uuid`.execute(
          database.db,
        )
      ).rows[0]!.explanation_unit_id;
      const twin = await admitReel('computing.algorithms', unit);
      const onScroll = await standOnV3(person, twinned);
      const variant = await v3.navigate(person.authority, {
        commandId: randomUUID(),
        sessionId: onScroll.open.sessionId,
        expectedIntentRevision: onScroll.open.intentRevision,
        from: onScroll.from,
        intent: { mode: 'variant', to: 'reel' },
      });
      expect(ready(variant).offer).toMatchObject({ assetId: twin.assetId, relation: { kind: 'format_variant' } });
      expect((await decisionOf(ready(variant).decisionId)).formatExploration).toBeUndefined();
    });

    it('reads the person’s top interest topics into the continue lane, and scores their system and the person’s level into the interest feature', async () => {
      const person = await seedPerson(database.db);
      // A person who has read about black holes: authored rows in the shape the projection writes (a fixture, not an encounter).
      const at = new Date();
      const logWeight = (activity: number) => Math.log(activity) + (Math.LN2 * at.getTime()) / 1_209_600_000;
      const channels = JSON.stringify({ q: 0, L: 0, B: 0, S: 0, H: 0, R: 0 });
      await sql`insert into evidence.topic_context(universe_id,privacy_epoch,topic_id,channel_values,activity,evaluated_at,scroll_measured,scroll_qualified,log_weight)
        values(${person.universeId}::uuid,1,'space.black-holes',${channels}::jsonb,2.4,${at.toISOString()}::timestamptz,3,3,${logWeight(2.4)})`.execute(
        database.db,
      );
      for (const [level, subject] of [
        ['system', 'space'],
        ['person', ''],
      ] as const)
        await sql`insert into evidence.interest_rollups(universe_id,privacy_epoch,level,subject_id,channel_values,activity,evaluated_at,scroll_measured,scroll_qualified,log_weight)
          values(${person.universeId}::uuid,1,${level},${subject},${channels}::jsonb,2.4,${at.toISOString()}::timestamptz,3,3,${logWeight(2.4)})`.execute(
          database.db,
        );
      const stand = await standOnV3(person, own[0]!);
      // The worker prepares the next move under v3 on activation; the navigation that follows serves that very ranking.
      const buffer = await prepareFor(person.universeId, 'v3');
      const next = ready(await nextV3(person, stand, 'scroll'));
      expect(next.decisionId).toBe(buffer.decision_id);
      const decision = await decisionOf(next.decisionId);
      expect(decision.policyVersion).toBe('composer-policy.v3');
      const holeIds = holes.map((h) => h.assetId);
      const continued = decision.input.candidates
        .filter((c) => c.encounter.lane === 'continue')
        .map((c) => c.encounter.assetId);
      expect(continued.sort()).toEqual([...holeIds].sort());
      // The snapshot holds the topic row, the space system and the person's level, all frozen.
      expect(decision.input.evidence?.topics.map((t) => t.topicId)).toContain('space.black-holes');
      expect(decision.input.evidence?.systems?.map((s) => s.systemId)).toEqual(['space']);
      expect(decision.input.evidence?.person?.activity).toBeGreaterThan(2);
      // Interest: the candidate on the topic the person has read outscores a candidate on one they have not met.
      const featureOf = (assetId: string) => decision.evaluations.find((e) => e.assetId === assetId)!.features.interest;
      const unknown = decision.input.candidates.find(
        (c) => c.encounter.lane === 'explore' && c.encounter.topics.every((t) => !t.topicId.startsWith('space.')),
      );
      expect(featureOf(holes[0]!.assetId)).toBeGreaterThan(0.5);
      expect(unknown).toBeDefined();
      expect(featureOf(holes[0]!.assetId)).toBeGreaterThan(featureOf(unknown!.encounter.assetId));
      expect(decision.formatExploration).toBeDefined();
      expect(canonical(composeEncounter(decision.input, policyOf(decision.policyVersion)))).toBe(canonical(decision));
    });

    it('is not asked of a person with a buffer from v2: v2 and v3 decisions of one world each keep their own label', async () => {
      const person = await seedPerson(database.db);
      const stand = await standOnV3(person, own[1]!);
      const next = ready(await nextV3(person, stand, 'scroll'));
      expect((await decisionOf(next.decisionId)).policyVersion).toBe('composer-policy.v3');
      // The v0 composition of the same world still ranks under v0 and its candidates name no lane.
      const other = await seedPerson(database.db);
      const earlier = ready(await nextSubject(other, await standOn(other, own[2]!), 'scroll'));
      const old = await decisionOf(earlier.decisionId);
      expect(old.policyVersion).toBe('composer-policy.v0');
      expect(old.input.candidates.every((c) => c.encounter.lane === undefined)).toBe(true);
    });
  });
});
