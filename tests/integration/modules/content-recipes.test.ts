import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import { stableUuid } from '@knowscroll/backend/infrastructure/ids';
import {
  makeWithPersonalScope,
  makeWithProductionScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  guardedModelPort,
} from '@knowscroll/backend/reasoning/nest-providers';
import { CONCEPTS, planLibraryProduction } from '@knowscroll/backend/modules/content';
import type { WithProductionScope } from '@knowscroll/backend/reasoning';
import {
  makeProposeRecipes,
  makeReviewGate,
  readDiscoveryCandidates,
  readLibraryStatus,
  previewRecipeProposal,
  listStoredRecipes,
} from '@knowscroll/backend/modules/content/nest-providers';
import type { PlannedDemandInput } from '@knowscroll/backend/modules/supply';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { lockPlanetRecipes } from '../../../packages/backend/src/modules/content/adapters/recipe-proposals.js';
import { overlapOf } from '../../../packages/backend/src/modules/content/domain/library/recipe-draft.js';
import {
  chooseScrollRecipe,
  readScrollProduction,
} from '../../../packages/backend/src/modules/content/adapters/production-state.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { evidencePassageCount } from '../../../packages/backend/src/modules/content/production/evidence.js';
import {
  SCROLL_PRODUCTION_V2_VERSION,
  SCROLL_PRODUCTION_VERSION,
} from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, silent, signal } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { seedPerson } from '../support/fixtures.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { plannedIntent, realSupply } from '../support/planned-demand.js';
import { scrollUseCases } from '../support/scroll.js';
import { orrinResearchFor, plainOrrin, v2Capabilities } from '../support/scroll-v2.js';

/**
 * Recipes stored in the database (#674, slice 2.2, D-412): proposed by the brief role, checked by code, chosen by Create and the
 * Planner's demand, produced through the real production job and held for an operator's read. The model is a labelled CI
 * fixture and every page and Scroll is an authored fixture about an invented planet: nothing here is provider output.
 */
describe('Stored recipes (labelled CI fixtures, real PostgreSQL and pg-boss)', () => {
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const capabilities = { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };

  const PLANET = 'earth.tides';
  const planet = CONCEPTS.find((concept) => concept.id === PLANET)!;
  const [FACET_A, FACET_B] = planet.facets.map((facet) => facet.id) as [string, string];
  const PAGE_A = 'https://en.wikipedia.org/wiki/Tide';
  const PAGE_B = 'https://en.wikipedia.org/wiki/Tidal_force';
  const PAGE_C = 'https://en.wikipedia.org/wiki/Spring_tide';

  /** A frozen research page of `paragraphs` authored fixture paragraphs about an invented moon, each its own passage. */
  const researchPage = (url: string, paragraphs: number) =>
    extractResearch(
      `<html><title>CI fixture page</title><main>${Array.from(
        { length: paragraphs },
        (_, index) =>
          `<p>Fixture paragraph ${String(index + 1)} for ${url.split('/').pop()} states one invented fact about the moon Orrin and its two small seas.</p>`,
      ).join('')}</main></html>`,
      url,
      '2026-11-01T00:00:00.000Z',
    );

  /** Briefs that are each their own explanation: two to four sentences, no block named, nothing a page would not say. */
  const BRIEFS = [
    'Explain how the invented moon Orrin raises two bulges in its seas and why they follow it round. Ask only for what the pages say about the bulges and their timing. Do not claim the sea is pulled flat.',
    'Describe why the sea level on Orrin rises twice a lunar day instead of once, using the near and far bulges. Ask only for what the pages say about the two high waters. Do not name any other cause for the far bulge.',
    'Show why a spring tide on Orrin is the strongest of its month, when the two moons line up. Ask only for what the pages say about alignment and range. Do not offer a forecast.',
    'Explain tidal locking and why Orrin always shows one face to its planet. Ask only for what the pages say about locking. Do not describe how long it takes.',
    'Explain how the invented moon Orrin locks one face toward its planet over long ages, and why the locked face never changes. Ask only for what the pages say about locking and the face. Do not describe how fast it happens.',
    // The one before, reworded: the same facet and pages, and a little over a third of its words.
    'Describe why Orrin always shows the same face to its planet, which tidal locking brings about over long ages. Ask only for what the pages say about locking. Do not say how long it took.',
    'Explain how the invented moon Orrin gets two small seas from the pull of its planet, and why one of them stays near the planet. Ask only for what the pages say about the two seas. Do not give their depth.',
    'Explain why the water of the Orrin seas moves most in narrow bays, where the rising tide is squeezed into a smaller space. Ask only for what the pages say about bays and tidal range. Do not give any heights.',
    'Explain why the water of the Orrin seas rises highest in narrow bays, where the incoming tide is squeezed into less room. Ask only for what the pages say about bays and tidal range. Do not give any heights or times.',
    'Describe why a tide climbs higher in a narrow bay on Orrin, because the incoming water is squeezed into less room. Ask only for what the pages say about bays and tide range. Do not give any figure.',
  ] as const;
  const goodDraft = (
    title: string,
    facetId: string,
    pages: string[] = [PAGE_A, PAGE_B],
    brief: string = BRIEFS[0],
  ) => ({
    title,
    facetId,
    brief,
    pages,
  });

  let calls: () => number;
  let propose: ReturnType<typeof makeProposeRecipes>;
  let script: (sequence: number) => FixtureScenario;

  /** The brief role's own harness over the test database, with a labelled fixture model carrying a MiniMax identity. */
  function proposing(day = 0, options: { readonly storeScope?: WithProductionScope } = {}) {
    const fixture = fixtureModel((sequence) => script(sequence), { label: 'recipe-brief-CI-fixture' });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    const production = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: production,
        enabled: true,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    calls = () => fixture.calls.length;
    propose = makeProposeRecipes({
      db: database.db,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      // A scope that refuses stands for a crash between the answer and the storing: the answer is kept and nothing is stored.
      withScope: options.storeScope ?? production,
      harness,
      // A request is the same request on the same UTC day: each test that is not about a redelivery asks on a day of its own.
      now: () => new Date(Date.UTC(2026, 10, 1 + day, 12)),
    });
  }

  /** Freezes research on an earlier, finished job of a code recipe: the pages code "already holds" for the planet. */
  async function holdPages() {
    await sql`insert into content.scroll_production_runs
      (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, research, completed_at)
      values (${randomUUID()}, 'tides', ${SCROLL_PRODUCTION_VERSION}, 1, 1, 1, 'rejected', ${randomUUID()},
        ${JSON.stringify([researchPage(PAGE_A, 12), researchPage(PAGE_B, 6), researchPage(PAGE_C, 5)])}::jsonb, now())`.execute(
      database.db,
    );
  }

  /** Stores a checked recipe directly, for the tests that are about choosing and capping and not about proposing. */
  async function storeRecipe(
    label: string,
    topicId: string,
    facetId: string,
    angle: { readonly brief?: string; readonly pages?: string[] } = {},
  ) {
    const key = `gen-${label}-0000${label.length.toString().padStart(4, '0')}`;
    await database.db
      .insertInto('content.recipes')
      .values({
        key,
        origin: 'proposal',
        status: 'checked',
        title: `CI fixture recipe ${label}`,
        topic_id: topicId,
        facet_id: facetId,
        asset_id: stableUuid(`content.recipe-asset:${key}`),
        explanation_unit_id: `${key}-v1`,
        brief: angle.brief ?? goodDraft('x', facetId).brief,
        pages: angle.pages ?? [PAGE_A],
        proposing_run_id: randomUUID(),
      })
      .execute();
    return key;
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_recipes');
    await enableProductionScope(database.db);
    content = await scrollUseCases(database);
    await holdPages();
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });

  const recipeRows = () =>
    database.db.selectFrom('content.recipes').selectAll().orderBy('created_at').orderBy('key').execute();
  const attemptsOf = async (runId: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*) as n from reasoning.production_attempts where run_id = ${runId}::uuid`.execute(database.db)
      ).rows[0]!.n,
    );

  describe('proposing', () => {
    it('stores a draft code accepts as a checked recipe with an identity derived from its key, and refuses the rest by code', async () => {
      const accepted = goodDraft('How the moon Orrin raises two bulges in its seas', FACET_A);
      script = () =>
        answerWith({
          drafts: [
            accepted,
            // A page code does not hold, then a facet the planet lacks.
            goodDraft(
              'Another view of the same tide on Orrin',
              FACET_B,
              [PAGE_A, 'https://en.wikipedia.org/wiki/Moon'],
              BRIEFS[1],
            ),
            goodDraft('Tides of an invented kind on Orrin sea', 'earth.tides.invented', [PAGE_A, PAGE_B], BRIEFS[2]),
          ],
        });
      proposing(0);
      const result = await propose({ topicId: PLANET, dryRun: false }, signal());
      expect(result).toMatchObject({
        kind: 'proposed',
        drafts: 3,
        repaired: false,
        refused: { page_not_candidate: 1, facet_unknown: 1 },
        requestBound: 2,
      });
      expect(calls()).toBe(1);
      const rows = await recipeRows();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        origin: 'proposal',
        status: 'checked',
        topic_id: PLANET,
        facet_id: FACET_A,
        pages: [PAGE_A, PAGE_B],
        scroll_v2: { variant: 'plain', misconception: { kind: 'none' } },
        proposing_run_id: result.kind === 'proposed' ? result.runId : '',
        check_results: { pool: 18 },
      });
      // Derived by code, never chosen: the key's prefix, the unit from the key and the asset from the key.
      expect(row!.key.startsWith('gen-')).toBe(true);
      expect(row!.explanation_unit_id).toBe(`${row!.key}-v1`);
      expect(row!.asset_id).toBe(stableUuid(`content.recipe-asset:${row!.key}`));
      // The pool is what the writer would be offered from the two pages.
      expect(evidencePassageCount(researchPage(PAGE_A, 12)) + evidencePassageCount(researchPage(PAGE_B, 6))).toBe(18);
    });

    it('refuses a duplicate of an existing recipe by its brief or its title, and a page pool out of range', async () => {
      script = () =>
        answerWith({
          drafts: [
            // The brief of the recipe stored a moment ago, under a new title.
            goodDraft('A restatement for the tide fixture', FACET_B, [PAGE_A, PAGE_B], BRIEFS[0]),
            // The title of the recipe stored a moment ago.
            goodDraft('How the moon Orrin raises two bulges in its seas', FACET_B, [PAGE_A, PAGE_B], BRIEFS[2]),
            // One short page: a pool of five, below the checker's six.
            goodDraft('A tide explained from one small page', FACET_B, [PAGE_C], BRIEFS[3]),
          ],
        });
      proposing(1);
      const before = (await recipeRows()).length;
      const result = await propose({ topicId: PLANET, facetId: FACET_B, dryRun: false }, signal());
      expect(result).toMatchObject({
        kind: 'proposed',
        accepted: [],
        refused: { near_duplicate: 2, pool_out_of_range: 1 },
      });
      expect((await recipeRows()).length).toBe(before);
    });

    it('accepts a different explanation of the same facet beside the first', async () => {
      script = () =>
        answerWith({
          drafts: [goodDraft('Why Orrin sea rises twice each lunar day', FACET_A, [PAGE_A, PAGE_B], BRIEFS[1])],
        });
      proposing(2);
      const before = (await recipeRows()).length;
      expect(await propose({ topicId: PLANET, facetId: FACET_A, dryRun: false }, signal())).toMatchObject({
        kind: 'proposed',
        accepted: [{ facetId: FACET_A, pool: 18 }],
      });
      expect((await recipeRows()).length).toBe(before + 1);
    });

    it('is answered from the ledger when the same request comes again: a redelivery never pays twice', async () => {
      script = () =>
        answerWith({
          drafts: [goodDraft('Why a spring tide on Orrin is the strongest', FACET_A, [PAGE_A, PAGE_B], BRIEFS[2])],
        });
      proposing(3);
      const first = await propose({ topicId: PLANET, facetId: FACET_A, dryRun: false }, signal());
      expect(first.kind).toBe('proposed');
      if (first.kind !== 'proposed') return;
      expect(first.accepted).toHaveLength(1);
      expect(calls()).toBe(1);
      expect(await attemptsOf(first.runId)).toBe(1);
      // The same request on the same day, in a new process with a model that would answer differently: nothing is sent.
      script = () => answerWith({ drafts: [] });
      proposing(3);
      const again = await propose({ topicId: PLANET, facetId: FACET_A, dryRun: false }, signal());
      expect(again).toMatchObject({ kind: 'already_proposed', runId: first.runId });
      expect(again.kind === 'already_proposed' ? again.recipes : []).toHaveLength(1);
      expect(calls()).toBe(0);
      expect(await attemptsOf(first.runId)).toBe(1);
      // Another day is another request.
      script = () => answerWith({ drafts: [] });
      proposing(4);
      expect((await propose({ topicId: PLANET, facetId: FACET_A, dryRun: false }, signal())).kind).toBe('proposed');
      expect(calls()).toBe(1);
    });

    it('does not pay again for a run that stored nothing either: its run is closed', async () => {
      script = () => answerWith({ drafts: [] });
      proposing(5);
      const request = { topicId: PLANET, facetId: FACET_B, dryRun: false };
      expect(await propose(request, signal())).toMatchObject({ kind: 'proposed', drafts: 0, accepted: [] });
      expect(calls()).toBe(1);
      proposing(5);
      // A closed run that stored nothing is not "already proposed": it says so, and says how to ask again.
      const again = await propose(request, signal());
      expect(again).toMatchObject({ kind: 'closed_failed', reason: 'nothing_accepted', retry: 0, nextRetry: 1 });
      expect(calls()).toBe(0);
    });

    it('sends one repair for an answer that is not valid JSON of the shape, and no more', async () => {
      script = (sequence) =>
        sequence === 1
          ? { kind: 'malformed' }
          : answerWith({
              drafts: [goodDraft('Tidal locking and the near side of Orrin', FACET_B, [PAGE_A, PAGE_B], BRIEFS[3])],
            });
      proposing(6);
      expect(await propose({ topicId: PLANET, facetId: FACET_B, dryRun: false }, signal())).toMatchObject({
        kind: 'proposed',
        repaired: true,
        accepted: [{ facetId: FACET_B }],
      });
      expect(calls()).toBe(2);
    });

    it('reports a model that gives no usable answer as failed, with a code and no recipes', async () => {
      script = () => ({ kind: 'malformed' });
      proposing(7);
      const before = (await recipeRows()).length;
      expect(await propose({ topicId: PLANET, dryRun: false }, signal())).toMatchObject({
        kind: 'failed',
        code: 'invalid_output',
        unknown: false,
        closed: true,
        nextRetry: 1,
      });
      expect(calls()).toBe(2);
      expect((await recipeRows()).length).toBe(before);
      // The same request again reports the closed run and sends nothing.
      proposing(7);
      expect(await propose({ topicId: PLANET, dryRun: false }, signal())).toMatchObject({
        kind: 'closed_failed',
        reason: 'failed',
        retry: 0,
        nextRetry: 1,
      });
      expect(calls()).toBe(0);
    });

    it('allows the same request again the same day after a conclusive failure, with the next retry number, at most twice', async () => {
      const request = { topicId: PLANET, facetId: FACET_A, dryRun: false };
      script = () => ({ kind: 'malformed' });
      proposing(14);
      const runs: string[] = [];
      for (const retry of [0, 1, 2]) {
        const failed = await propose({ ...request, retry }, signal());
        expect(failed).toMatchObject({ kind: 'failed', closed: true, code: 'invalid_output' });
        runs.push(failed.kind === 'failed' ? failed.runId : '');
        expect(failed.kind === 'failed' ? failed.nextRetry : 'x').toBe(retry < 2 ? retry + 1 : undefined);
      }
      // Three requests, three runs of their own, two requests each.
      expect(new Set(runs).size).toBe(3);
      expect(calls()).toBe(6);
      // A fourth is refused before anything is sent.
      expect(await propose({ ...request, retry: 3 }, signal())).toEqual({
        kind: 'refused',
        reason: 'retry_out_of_range',
      });
      // And a retry that the model answers well is stored.
      script = () =>
        answerWith({
          drafts: [goodDraft('Why a spring tide on Orrin repeats each month', FACET_A, [PAGE_A, PAGE_B], BRIEFS[2])],
        });
      proposing(15);
      expect((await propose({ ...request, retry: 0 }, signal())).kind).toBe('proposed');
    });

    it('closes the run as failed when the provider conclusively refuses, and offers the next retry', async () => {
      script = () => ({ kind: 'rate_limited' });
      proposing(16);
      const failed = await propose({ topicId: PLANET, facetId: FACET_B, dryRun: false }, signal());
      expect(failed).toMatchObject({ kind: 'failed', unknown: false, closed: true, nextRetry: 1 });
      expect(calls()).toBe(1);
    });

    it('refuses a draft whose title or brief carries an address or markup, before anything else', async () => {
      script = () =>
        answerWith({
          drafts: [
            goodDraft('Where to read about tides on wikipedia.org', FACET_B, [PAGE_A, PAGE_B], BRIEFS[4]),
            {
              ...goodDraft('A tide explained with a link', FACET_B, [PAGE_A, PAGE_B], BRIEFS[5]),
              brief: `${BRIEFS[5]} [more](here)`,
            },
          ],
        });
      proposing(17);
      expect(await propose({ topicId: PLANET, facetId: FACET_B, dryRun: false }, signal())).toMatchObject({
        kind: 'proposed',
        accepted: [],
        refused: { text_has_address: 1, text_has_markup: 1 },
      });
    });

    it('keeps the run open and does not resend when the outcome of the request is unknown', async () => {
      script = () => ({ kind: 'timeout_after_dispatch' });
      proposing(8);
      expect(await propose({ topicId: PLANET, dryRun: false }, signal())).toMatchObject({
        kind: 'failed',
        unknown: true,
      });
      expect(calls()).toBe(1);
      script = () => answerWith({ drafts: [] });
      proposing(8);
      expect((await propose({ topicId: PLANET, dryRun: false }, signal())).kind).toBe('failed');
      expect(calls()).toBe(0);
    });

    /** A scope that refuses: what the use case meets when the process dies, or the production root is switched off, after the answer is kept. */
    const refusingScope: WithProductionScope = () =>
      Promise.resolve({ kind: 'refused', refusal: { kind: 'production_disabled' } });

    it('does not throw a paid answer away when the context changed after it was kept: the redelivery stores what still passes', async () => {
      script = () =>
        answerWith({
          drafts: [goodDraft('Why the tide runs highest in narrow bays', FACET_A, [PAGE_A, PAGE_B], BRIEFS[7])],
        });
      proposing(10, { storeScope: refusingScope });
      const request = { topicId: PLANET, facetId: FACET_A, dryRun: false };
      expect(await propose(request, signal())).toMatchObject({ kind: 'failed', code: 'scope_refused', closed: false });
      expect(calls()).toBe(1);
      // Meanwhile another recipe of the planet is stored, so the context a fresh request would send is not the one that was sent.
      await storeRecipe('changed-meanwhile', PLANET, FACET_B);
      script = () => answerWith({ drafts: [] });
      proposing(10);
      const redelivered = await propose(request, signal());
      // The kept answer came back from the ledger (no second paid call) and what still passed was stored.
      expect(calls()).toBe(0);
      expect(redelivered).toMatchObject({ kind: 'proposed', drafts: 1, accepted: [{ facetId: FACET_A }] });
      // Once is enough: the run is closed and says what came of it.
      proposing(10);
      expect(await propose(request, signal())).toMatchObject({ kind: 'already_proposed' });
      expect(calls()).toBe(0);
    });

    it('checks the kept answer against the recipes of today, so what another run stored in the meantime is refused', async () => {
      script = () =>
        answerWith({ drafts: [goodDraft('Two seas for the moon Orrin', FACET_B, [PAGE_A, PAGE_B], BRIEFS[6])] });
      proposing(11, { storeScope: refusingScope });
      const request = { topicId: PLANET, facetId: FACET_B, dryRun: false };
      expect(await propose(request, signal())).toMatchObject({ kind: 'failed', code: 'scope_refused' });
      // The same explanation reaches the library by another way while the answer waits.
      await storeRecipe('stored-meanwhile', PLANET, FACET_B, { brief: BRIEFS[6], pages: [PAGE_B] });
      const before = (await recipeRows()).length;
      proposing(11);
      const redelivered = await propose(request, signal());
      expect(calls()).toBe(0);
      // The same brief is stored on this facet and on one of these pages now: the answer is refused, not stored twice.
      expect(redelivered).toMatchObject({ kind: 'proposed', accepted: [], refused: { near_duplicate: 1 } });
      expect((await recipeRows()).length).toBe(before);
      proposing(11);
      expect(await propose(request, signal())).toMatchObject({ kind: 'closed_failed', reason: 'nothing_accepted' });
    });

    it('cannot store the same angle twice when two runs answer at once: the planet lock makes the second see the first', async () => {
      const first = goodDraft('How Orrin locks one face toward its planet', FACET_A, [PAGE_A, PAGE_B], BRIEFS[4]);
      const reworded = goodDraft('Why Orrin shows its planet the same face', FACET_A, [PAGE_A, PAGE_B], BRIEFS[5]);
      expect(overlapOf(BRIEFS[4], BRIEFS[5])).toBeGreaterThanOrEqual(0.3);
      expect(overlapOf(BRIEFS[4], BRIEFS[5])).toBeLessThan(0.55);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      script = (sequence) => ({
        kind: 'hold',
        until: held.then(() => answerWith({ drafts: [sequence === 1 ? first : reworded] })),
      });
      proposing(12);
      const before = (await recipeRows()).length;
      // Two requests for the same planet, so two runs, both waiting at the model until both have asked.
      const both = Promise.all([
        propose({ topicId: PLANET, facetId: FACET_A, dryRun: false }, signal()),
        propose({ topicId: PLANET, dryRun: false }, signal()),
      ]);
      await vi.waitFor(() => expect(calls()).toBe(2));
      release();
      const results = await both;
      const kinds = results.map((result) => (result.kind === 'proposed' ? result.accepted.length : result.kind));
      expect(kinds.sort()).toEqual([0, 1]);
      expect(results.find((result) => result.kind === 'proposed' && result.accepted.length === 0)).toMatchObject({
        refused: { near_duplicate: 1 },
      });
      expect((await recipeRows()).length).toBe(before + 1);
    });

    it('stores nothing while another transaction holds the planet lock, and then judges its drafts against what that transaction stored', async () => {
      // Another operator's storing is in flight: it holds the planet's lock and has stored one angle, not yet committed.
      const holder = await database.db.startTransaction().execute();
      let committed = false;
      try {
        await lockPlanetRecipes(holder, PLANET);
        const key = 'gen-lock-holder-00000000';
        await holder
          .insertInto('content.recipes')
          .values({
            key,
            origin: 'proposal',
            status: 'checked',
            title: 'Holder of the planet lock fixture',
            topic_id: PLANET,
            facet_id: FACET_B,
            asset_id: stableUuid(`content.recipe-asset:${key}`),
            explanation_unit_id: `${key}-v1`,
            brief: BRIEFS[8],
            pages: [PAGE_A, PAGE_B],
            proposing_run_id: randomUUID(),
          })
          .execute();
        // The same angle in other words arrives from the model meanwhile.
        script = () =>
          answerWith({
            drafts: [goodDraft('Why bays raise the tide higher on Orrin', FACET_B, [PAGE_A, PAGE_B], BRIEFS[9])],
          });
        proposing(18);
        expect(overlapOf(BRIEFS[8], BRIEFS[9])).toBeGreaterThanOrEqual(0.3);
        expect(overlapOf(BRIEFS[8], BRIEFS[9])).toBeLessThan(0.55);
        // Only the held recipe can refuse it: no recipe already stored on this facet is close enough, and none anywhere passes the general limit.
        for (const [index, other] of BRIEFS.slice(0, 8).entries())
          expect(overlapOf(other, BRIEFS[9]), String(index)).toBeLessThan([0, 3, 6].includes(index) ? 0.3 : 0.55);
        const waiting = propose({ topicId: PLANET, facetId: FACET_B, dryRun: false }, signal());
        await vi.waitFor(() => expect(calls()).toBe(1));
        const early = await Promise.race([
          waiting.then(() => 'finished'),
          new Promise((resolve) => setTimeout(() => resolve('waiting'), 600)),
        ]);
        expect(early).toBe('waiting');
        await holder.commit().execute();
        committed = true;
        expect(await waiting).toMatchObject({ kind: 'proposed', accepted: [], refused: { near_duplicate: 1 } });
      } finally {
        if (!committed) await holder.rollback().execute();
      }
    });

    it('refuses before any request, at no cost, for a planet or facet that does not exist and a planet with no page held', async () => {
      script = () => answerWith({ drafts: [] });
      proposing(9);
      expect(await propose({ topicId: 'earth.invented', dryRun: false }, signal())).toEqual({
        kind: 'refused',
        reason: 'topic_unknown',
      });
      expect(await propose({ topicId: PLANET, facetId: 'earth.tides.invented', dryRun: false }, signal())).toEqual({
        kind: 'refused',
        reason: 'facet_unknown',
      });
      expect(await propose({ topicId: 'history.industrial-revolution', dryRun: false }, signal())).toEqual({
        kind: 'refused',
        reason: 'no_candidate_pages',
      });
      expect(calls()).toBe(0);
    });

    it('previews a request in counts: nothing is sent, nothing is stored', async () => {
      const before = (await recipeRows()).length;
      const preview = await previewRecipeProposal(database.db, { topicId: PLANET, facetId: FACET_A });
      expect(preview).toMatchObject({ kind: 'dry_run', candidatePages: 3, requestBound: 2 });
      expect((await recipeRows()).length).toBe(before);
    });

    it('lists the stored recipes by status with no body text', async () => {
      const listed = await listStoredRecipes(database.db, { status: 'checked' });
      expect(listed.length).toBeGreaterThan(0);
      for (const entry of listed) {
        expect(Object.keys(entry).sort()).toEqual(
          ['assetId', 'createdAt', 'facetId', 'key', 'origin', 'pages', 'pool', 'status', 'title', 'topicId'].sort(),
        );
      }
      expect(await listStoredRecipes(database.db, { status: 'retired' })).toEqual([]);
    });
  });

  describe('choosing a stored recipe', () => {
    const inScope = async <T>(work: (scope: Parameters<typeof chooseScrollRecipe>[0]) => Promise<T>) => {
      const person = await seedPerson(database.db);
      const entered = await withScope()(person.authority, work);
      if (entered.kind !== 'entered') throw new Error('CI scope refused');
      return entered.value;
    };

    it('picks a checked stored recipe for the facet it teaches, where every code recipe of the planet waits for a read', async () => {
      const choice = await inScope((scope) =>
        chooseScrollRecipe(scope, { topicId: PLANET, facetId: FACET_A }, { allow: { code: true, generated: true } }),
      );
      expect(choice).toMatchObject({ kind: 'recipe', take: 1 });
      const stored = (await recipeRows()).find((row) => row.facet_id === FACET_A)!;
      expect(choice.kind === 'recipe' ? choice.recipe : undefined).toMatch(/^gen-/u);
      expect(stored.status).toBe('checked');
    });

    it('answers none, and says the cap held it back, when only stored recipes could serve and growth is closed', async () => {
      const closed = await inScope((scope) =>
        chooseScrollRecipe(scope, { topicId: PLANET, facetId: FACET_A }, { allow: { code: true, generated: false } }),
      );
      expect(closed).toEqual({ kind: 'none', capped: true });
    });

    it('is exactly the old answer for a planet with no stored recipe: v2 code recipes are skipped, a v1 code recipe is chosen', async () => {
      expect(await inScope((scope) => chooseScrollRecipe(scope, { topicId: 'earth.seasons' }))).toEqual({
        kind: 'none',
      });
      expect(
        await inScope((scope) =>
          chooseScrollRecipe(scope, { topicId: 'space.exoplanets', facetId: RECIPES['exoplanet-kinds'].facetId }),
        ),
      ).toEqual({ kind: 'recipe', recipe: 'exoplanet-kinds', take: 1 });
    });

    it('lets the unit a Planner opportunity aimed at choose the facet to try first', async () => {
      const [facetOne, facetTwo] = CONCEPTS.find((concept) => concept.id === 'earth.greenhouse-effect')!.facets;
      const other = await storeRecipe('second-facet', 'earth.greenhouse-effect', facetOne!.id);
      const first = await storeRecipe('first-facet', 'earth.greenhouse-effect', facetTwo!.id);
      // Without a hint the first stored recipe in order is chosen; with the unit of the other, its facet comes first.
      const plain = await inScope((scope) => chooseScrollRecipe(scope, { topicId: 'earth.greenhouse-effect' }));
      expect(plain).toMatchObject({ kind: 'recipe', recipe: other });
      const aimed = await inScope((scope) =>
        chooseScrollRecipe(
          scope,
          { topicId: 'earth.greenhouse-effect' },
          { allow: { code: true, generated: true }, plannedUnit: `${first}-v1` },
        ),
      );
      expect(aimed).toMatchObject({ kind: 'recipe', recipe: first });
    });
  });

  describe('Create and the Planner commission a stored recipe, and its Scroll is held', () => {
    const planned = (topicIds: string[], overrides: Partial<PlannedDemandInput> = {}): PlannedDemandInput => ({
      plannerRunId: randomUUID(),
      slot: 0,
      topicIds,
      format: 'scroll',
      language: 'en',
      capabilities: v2Capabilities,
      alreadyMet: [],
      intent: plannedIntent(),
      ...overrides,
    });
    const workOf = async (requestId: string) =>
      database.db
        .selectFrom('supply.requests as r')
        .innerJoin('supply.work as w', 'w.id', 'r.work_id')
        .select(['w.production_recipe', 'w.commissioned_by', 'r.state'])
        .where('r.id', '=', requestId)
        .executeTakeFirstOrThrow();

    it("commissions a stored recipe for a person's ask and for the Planner's demand, and starts one production job each", async () => {
      const supply = realSupply(database, content.boss, {
        createDailyCap: 10,
        growthDailyCap: 10,
        readExploration: content.readExploration,
      });
      const person = await seedPerson(database.db);
      const asked = await supply.create(person.authority, {
        version: 'content-request.v1',
        commandId: randomUUID(),
        intent: {
          kind: 'topic',
          subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: PLANET, facetId: FACET_A },
          format: 'scroll',
        },
        language: 'en',
        capabilities: v2Capabilities,
      });
      if (asked.kind !== 'ok') throw new Error('CI ask refused');
      const work = await workOf(asked.value.requestId);
      expect(work.production_recipe).toMatch(/^gen-/u);
      expect(work.commissioned_by).toBe('person');
      const jobs = await database.pool.query("select data from pgboss.job where name='content.produce-scroll'");
      expect(jobs.rows.map((row: { data: { recipe: string; policyVersion: string } }) => row.data)).toContainEqual({
        v: 1,
        recipe: work.production_recipe,
        policyVersion: SCROLL_PRODUCTION_V2_VERSION,
        take: 1,
      });

      const planner = await seedPerson(database.db);
      const outcome = await withScope()(planner.authority, (scope) =>
        supply.record(scope, planned(['earth.greenhouse-effect'])),
      );
      expect(outcome.kind === 'entered' ? outcome.value : undefined).toMatchObject({ kind: 'deferred', joined: false });
      const row = await database.db
        .selectFrom('supply.requests as r')
        .innerJoin('supply.work as w', 'w.id', 'r.work_id')
        .select(['w.production_recipe', 'w.commissioned_by'])
        .where('r.universe_id', '=', planner.universeId)
        .executeTakeFirstOrThrow();
      expect(row.production_recipe).toMatch(/^gen-/u);
      expect(row.commissioned_by).toBe('planner');
    });

    it('produces the recipe through the real job, holds its Scroll for the operator and serves it only once released', async () => {
      const key = (await recipeRows()).find((row) => row.facet_id === FACET_A)!.key as `gen-${string}`;
      const asset = (await recipeRows()).find((row) => row.key === key)!.asset_id;
      const waiter = await seedPerson(database.db);
      const readingOf = async () => {
        const entered = await withScope()(waiter.authority, (scope) => readScrollProduction(scope, key));
        if (entered.kind !== 'entered') throw new Error('CI scope refused');
        return entered.value;
      };
      // A waiter on Create's own work keeps waiting while the job is queued or running (a code v2 recipe would read as stopped).
      expect(await readingOf()).toEqual({ state: 'not_started', take: 1 });
      const run = fixtureProduction(database.db, () => answerWith(plainOrrin()), orrinResearchFor);
      expect(await run.produce(key, false, signal(), true, 1)).toMatchObject({ outcome: 'published', held: true });
      // Held for the operator: nothing is coming that a waiter could be served, so it stops waiting.
      expect(await readingOf()).toEqual({ state: 'held' });

      // Held: standing, asset status and the review gate agree, and the recipe moved from checked to produced.
      const [standing] = await readLibraryStatus(database.db, [key]);
      expect(standing).toMatchObject({ recipe: key, state: 'held', heldRevision: 1 });
      expect(
        await database.db.selectFrom('content.assets').select('status').where('id', '=', asset).executeTakeFirst(),
      ).toEqual({ status: 'held' });
      expect(
        await database.db.selectFrom('content.recipes').select('status').where('key', '=', key).executeTakeFirst(),
      ).toEqual({ status: 'produced' });
      const stored = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', asset)
        .executeTakeFirstOrThrow();
      expect((stored.document as { misconception: unknown; stage?: unknown }).misconception).toEqual({ kind: 'none' });
      expect((stored.document as { stage?: unknown }).stage).toBeUndefined();
      // Attributed to its planet and given coverage, as a library Scroll is, so the operator sees it would form.
      const topics = await database.db
        .selectFrom('content.encounter_topics')
        .select('topic_id')
        .where('asset_id', '=', asset)
        .execute();
      expect(topics).toEqual([{ topic_id: PLANET }]);

      // Not served: a reader's discovery offers nothing of it.
      const reader = await seedPerson(database.db);
      const offered = async () => {
        const entered = await withScope()(reader.authority, (scope) =>
          readDiscoveryCandidates(scope, {
            languages: ['en'],
            formats: ['scroll'],
            capabilities: v2Capabilities,
            limit: 100,
          }),
        );
        if (entered.kind !== 'entered') throw new Error('CI scope refused');
        return entered.value.filter((encounter) => encounter.assetId === asset);
      };
      expect(await offered()).toEqual([]);
      const gate = makeReviewGate(database.db);
      expect((await gate.list({ all: false })).find((listing) => listing.assetId === asset)).toMatchObject({
        recipe: key,
        state: 'held',
        servedRevision: null,
      });

      // The operator releases it, and only then is it offered.
      expect(await gate.release({ assetId: asset, revision: 1, decidedBy: 'cli:ci-reviewer' })).toMatchObject({
        kind: 'released',
      });
      expect((await offered()).map((encounter) => encounter.assetRevision)).toEqual([1]);
      expect(await gate.recipeKeyOf(asset)).toBe(key);
    });

    it('leaves the standing of a recipe it never produced untouched, and a retired recipe is never chosen', async () => {
      const retired = await storeRecipe('retired-one', 'computing.browsers', 'computing.browsers.mechanism');
      await sql`update content.recipes set status='retired' where key=${retired}`.execute(database.db);
      const person = await seedPerson(database.db);
      const entered = await withScope()(person.authority, (scope) =>
        chooseScrollRecipe(scope, { topicId: 'computing.browsers' }),
      );
      expect(entered.kind === 'entered' ? entered.value : undefined).toEqual({ kind: 'none' });
      expect((await readLibraryStatus(database.db, [retired as `gen-${string}`]))[0]).toMatchObject({
        state: 'stopped',
      });
    });
  });

  describe('the daily growth cap', () => {
    it('stops the eleventh new Scroll of the day, counts growth apart from the Planner and the people, and leaves a code recipe open', async () => {
      const gen = async (op: 'like' | 'not like') =>
        Number(
          (
            await sql<{
              n: string;
            }>`select count(*) as n from supply.work where production_recipe is not null and production_recipe ${sql.raw(op)} 'gen-%' and created_at >= date_trunc('day', now() at time zone 'utc')`.execute(
              database.db,
            )
          ).rows[0]!.n,
        );
      // The tests above already commissioned a person's and the Planner's stored recipe today: growth counts every one of them.
      const used = await gen('like');
      expect(used).toBe(2);
      const topics = CONCEPTS.filter(
        (concept) =>
          concept.parent !== null &&
          !['earth.tides', 'earth.greenhouse-effect', 'computing.browsers', 'space.exoplanets'].includes(concept.id),
      ).slice(0, 11);
      expect(topics).toHaveLength(11);
      for (const [index, topic] of topics.entries())
        await storeRecipe(`cap-${String(index)}`, topic.id, topic.facets[0]!.id);
      const supply = realSupply(database, content.boss, {
        // The people's and the Planner's own caps are small: growth is limited by its own cap alone, and uses none of theirs.
        createDailyCap: 3,
        plannerCreateDailyCap: 3,
        growthDailyCap: 10,
        readExploration: content.readExploration,
      });
      const demand = (topicId: string, person: Awaited<ReturnType<typeof seedPerson>>) =>
        withScope()(person.authority, (scope) =>
          supply.record(scope, {
            plannerRunId: randomUUID(),
            slot: 0,
            topicIds: [topicId],
            format: 'scroll',
            language: 'en',
            capabilities,
            alreadyMet: [],
            intent: plannedIntent(),
          }),
        );
      const outcomes: string[] = [];
      for (const topic of topics) {
        const result = await demand(topic.id, await seedPerson(database.db));
        if (result.kind !== 'entered') throw new Error('CI scope refused');
        outcomes.push(result.value.kind === 'not_commissioned' ? `no:${result.value.reason}` : result.value.kind);
      }
      // Ten a day in all: eight more were open, and the ninth to eleventh of these are refused.
      expect(outcomes).toEqual([
        ...Array<string>(10 - used).fill('deferred'),
        ...Array<string>(topics.length - (10 - used)).fill('no:cap_reached'),
      ]);
      expect(await gen('like')).toBe(10);
      expect(await gen('not like')).toBe(0);

      // A code recipe is still open to the same Planner: growth never used what the Planner's own cap leaves.
      const code = await demand('space.exoplanets', await seedPerson(database.db));
      expect(code.kind === 'entered' ? code.value : undefined).toMatchObject({ kind: 'deferred' });
      expect(await gen('not like')).toBe(1);
      expect(await gen('like')).toBe(10);
    });

    it('produces nothing for growth when the cap is 0, and Create off still turns every kind off', async () => {
      // A planet no earlier test used, so no group of its own is already waiting to be joined.
      const topic = CONCEPTS.find((concept) => concept.id === 'history.industrial-revolution')!;
      await storeRecipe('zero-cap', topic.id, topic.facets[0]!.id);
      const person = await seedPerson(database.db);
      const input = {
        plannerRunId: randomUUID(),
        slot: 0,
        topicIds: [topic.id],
        format: 'scroll' as const,
        language: 'en',
        capabilities,
        alreadyMet: [],
        intent: plannedIntent(),
      };
      const closed = realSupply(database, content.boss, {
        createDailyCap: 50,
        growthDailyCap: 0,
        readExploration: content.readExploration,
      });
      const none = await withScope()(person.authority, (scope) => closed.record(scope, input));
      expect(none.kind === 'entered' ? none.value : undefined).toEqual({
        kind: 'not_commissioned',
        reason: 'cap_reached',
      });
      const off = realSupply(database, content.boss, {
        createDailyCap: 0,
        growthDailyCap: 10,
        readExploration: content.readExploration,
      });
      const stopped = await withScope()(person.authority, (scope) => off.record(scope, input));
      expect(stopped.kind === 'entered' ? stopped.value : undefined).toEqual({
        kind: 'not_commissioned',
        reason: 'create_off',
      });
    });
  });

  describe('the library plan is unchanged', () => {
    it('queues a stored recipe for an operator run beside the plan, and reports every code recipe as before', async () => {
      const [stored] = await listStoredRecipes(database.db, { status: 'checked' });
      const key = stored!.key as `gen-${string}`;
      const standing = await readLibraryStatus(database.db, ['tides', key]);
      expect(standing.map((row) => row.recipe)).toEqual(['tides', key]);
      expect(standing[0]).toMatchObject({ state: 'not_started', takes: 0 });
      expect(planLibraryProduction(standing, { interactiveFirst: false }).queue).toEqual([
        { recipe: 'tides', take: 1 },
        { recipe: key, take: 1 },
      ]);
      // A key the database does not hold has no standing to report.
      expect(await readLibraryStatus(database.db, ['gen-nothing-here-0000abcd'])).toEqual([]);
    });
  });
});
