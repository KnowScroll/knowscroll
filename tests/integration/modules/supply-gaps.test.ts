import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeWithPersonalScope,
  makeWithProductionScope,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { planSnapshot } from '@knowscroll/backend/modules/content';
import type { WithProductionScope } from '@knowscroll/backend/reasoning';
import {
  chooseScrollRecipeIn,
  makeEnqueueScrollProduction,
  makeProposeRecipes,
  makeReviewGate,
  readGapRecipes,
  readRecipeStates,
  readReleasedCoverage,
} from '@knowscroll/backend/modules/content/nest-providers';
import { COMPOSER_POLICY_V2, composeEncounter, type ComposerSnapshot } from '@knowscroll/backend/modules/composer';
import { makeComposerStore, withGapSignals } from '@knowscroll/backend/modules/composer/nest-providers';
import type { PlannedDemandInput } from '@knowscroll/backend/modules/supply';
import {
  catalogueTopics,
  gapBriefLock,
  gapBriefStore,
  gapScanStore,
  growthStore,
  makeBriefGaps,
  makeScanGaps,
  proposalOf,
  readGapSummary,
  settleBlockedGap,
} from '@knowscroll/backend/modules/supply/nest-providers';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { gapKeyOf } from '../../../packages/backend/src/modules/supply/adapters/postgres-gaps.js';
import { SCROLL_PRODUCTION_VERSION } from '../../../packages/backend/src/modules/content/production/topics.js';
import { catalogueOf } from '../support/catalogue.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, gate, silent, signal } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { seedPerson } from '../support/fixtures.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { plannedIntent, realSupply } from '../support/planned-demand.js';
import { scrollUseCases } from '../support/scroll.js';
import { orrinResearchFor, plainOrrin, v2Capabilities } from '../support/scroll-v2.js';

/** The catalogue of the library plan (release 1), which the migrated database seeds: the topics these journeys use. */
const CONCEPTS = planSnapshot().all();

/**
 * The gap loop (#674, slice 3.1, D-414): where content runs out is noticed by code and new recipes are proposed within budget,
 * still held for an operator's read. The model is a labelled CI fixture, and every page, Scroll and reader is an authored fixture
 * about an invented moon: nothing here is provider output, a real reader or product data.
 */
describe('The gap loop (labelled CI fixtures, real PostgreSQL and pg-boss)', () => {
  let database: TestDatabase<Database>;
  let content: Awaited<ReturnType<typeof scrollUseCases>>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  const db = () => database.db;

  const PLANET = 'earth.tides';
  const planet = CONCEPTS.find((concept) => concept.id === PLANET)!;
  const [FACET_A, FACET_B] = planet.facets.map((facet) => facet.id) as [string, string];
  const PAGE_A = 'https://en.wikipedia.org/wiki/Tide';
  const PAGE_B = 'https://en.wikipedia.org/wiki/Tidal_force';
  const PAGE_C = 'https://en.wikipedia.org/wiki/Spring_tide';

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
  const BRIEFS = [
    'Explain how the invented moon Orrin raises two bulges in its seas and why they follow it round. Ask only for what the pages say about the bulges and their timing. Do not claim the sea is pulled flat.',
    'Show why a spring tide on Orrin is the strongest of its month, when the two moons line up. Ask only for what the pages say about alignment and range. Do not offer a forecast.',
    'Explain tidal locking and why Orrin always shows one face to its planet. Ask only for what the pages say about locking. Do not describe how long it takes.',
  ] as const;
  const draft = (title: string, facetId: string, brief: string) => ({ title, facetId, brief, pages: [PAGE_A, PAGE_B] });

  /** Frozen research on an earlier, finished job of a code recipe: the pages code "already holds" for the planet. */
  async function holdPages() {
    await sql`insert into content.scroll_production_runs
      (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, research, completed_at)
      values (${randomUUID()}, 'tides', ${SCROLL_PRODUCTION_VERSION}, 1, 1, 1, 'rejected', ${randomUUID()},
        ${JSON.stringify([researchPage(PAGE_A, 12), researchPage(PAGE_B, 6), researchPage(PAGE_C, 5)])}::jsonb, now())`.execute(
      db(),
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase<Database>('supply_gaps');
    await enableProductionScope(db());
    content = await scrollUseCases(database);
    await holdPages();
  });
  afterAll(async () => {
    await content.close();
    await database.drop();
  });

  /** Every gap, newest first; the table is small in a test. */
  const gaps = () => db().selectFrom('supply.gaps').selectAll().orderBy('first_seen_at').orderBy('id').execute();
  const gapOf = async (planetId: string, kind?: string) =>
    (await gaps()).filter((gap) => gap.planet === planetId && (kind === undefined || gap.kind === kind));
  const count = async (query: RawBuilder<{ n: string }>): Promise<number> =>
    Number((await query.execute(db())).rows[0]!.n);
  const jobsFor = (recipe: string) =>
    count(
      sql<{
        n: string;
      }>`select count(*) as n from pgboss.job where name = 'content.produce-scroll' and data->>'recipe' = ${recipe}`,
    );
  /** The loop's own tables and what it commissioned, so one test never meets another's work. */
  const resetGaps = async () => {
    await sql`delete from supply.gaps`.execute(db());
    await sql`delete from supply.gap_signals`.execute(db());
    await sql`delete from supply.gap_signal_marks`.execute(db());
    await sql`delete from supply.work where production_recipe like 'gen-%'`.execute(db());
    await sql`delete from content.recipes`.execute(db());
    await sql`delete from pgboss.job where name = 'content.produce-scroll'`.execute(db());
  };

  /** A scope that refuses: what the use case meets when the process dies, or the production root is switched off, after the answer is kept. */
  const refusingScope: WithProductionScope = () =>
    Promise.resolve({ kind: 'refused', refusal: { kind: 'production_disabled' } });

  /** A scan and a brief pass over the real stores, with a labelled fixture model carrying a MiniMax identity. */
  function loop(
    options: {
      enabled?: boolean;
      cap?: number;
      /** Pins the clock to noon UTC this many days before 10 November 2026, so each test asks its own request (a request is the same on the same UTC day). */
      day?: number;
      script?: (sequence: number) => FixtureScenario | Promise<FixtureScenario>;
      /** How many failed production rounds reject a gap. */
      maxRounds?: number;
      /** Wraps the brief store, for a crash between a paid answer and its record. */
      wrapStore?: (store: ReturnType<typeof gapBriefStore>) => ReturnType<typeof gapBriefStore>;
      /** A production scope that refuses where the answer would be stored: the model was paid and its answer is kept, but nothing is stored. */
      refuseStore?: boolean;
    } = {},
  ) {
    const enabled = options.enabled ?? true;
    const fixture = fixtureModel((sequence) => (options.script ?? (() => answerWith({ drafts: [] })))(sequence), {
      label: 'recipe-brief-CI-fixture',
    });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    const production = makeWithProductionScope(db(), { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: db(),
        withProductionScope: production,
        enabled: true,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    const propose = makeProposeRecipes({
      db: db(),
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope: options.refuseStore ? refusingScope : production,
      harness,
    });
    const enqueue = makeEnqueueScrollProduction(content.boss);
    const now = () => (options.day === undefined ? new Date() : new Date(Date.UTC(2026, 10, 10 - options.day, 12)));
    const store = gapBriefStore(db());
    const brief = makeBriefGaps({
      enabled,
      growthDailyCap: options.cap ?? 10,
      lock: gapBriefLock(db()),
      store: options.wrapStore ? options.wrapStore(store) : store,
      growth: growthStore(db(), { readRecipes: readGapRecipes, chooseRecipe: chooseScrollRecipeIn }),
      readGapRecipes: (target) => readGapRecipes(db(), target),
      propose: async (request, abort) => proposalOf(await propose({ ...request, dryRun: false }, abort)),
      enqueueProduction: async (recipe, take) => {
        await enqueue(recipe, take);
      },
      now,
      newId: randomUUID,
    });
    const scan = makeScanGaps({
      readCatalogue: async () => catalogueTopics(await catalogueOf(db()).current()),
      enabled,
      depthTarget: 6,
      maxRounds: options.maxRounds ?? 3,
      store: gapScanStore(db()),
      readCoverage: () => readReleasedCoverage(db()),
      readRecipeStates: (keys) => readRecipeStates(db(), keys),
      now,
      newId: randomUUID,
    });
    return { brief: () => brief(signal()), scan, calls: () => fixture.calls.length };
  }

  /** A vertical move for one person whose topic has one unseen explanation left, which the first offer is. */
  function lastUnseen(person: { universeId: string }, topic: string): ComposerSnapshot {
    const evaluatedAt = '2026-11-11T12:00:00.000Z';
    const candidate = (name: string) => ({
      admitted: true,
      accessible: true,
      renderable: true,
      encounter: {
        assetId: name,
        assetRevision: 1,
        kind: 'scroll' as const,
        explanationUnitId: `unit-${name}`,
        metadata: { kind: 'scroll' as const, title: `Fixture ${name}`, summary: '', language: 'en' },
        topics: [{ topicId: topic, role: 'primary' as const, weight: 1 }],
        facets: [],
        siblings: [],
        catalogWatermark: 'fixture-catalog',
        attributionVersion: 'fixture-taxonomy',
      },
    });
    const candidates = [candidate(`a-${topic}`), candidate(`b-${topic}`)];
    return {
      universeId: person.universeId,
      privacyEpoch: 1,
      evaluatedAt,
      seed: `seed-${randomUUID()}`,
      mode: 'vertical',
      intent: { language: 'en', topicIds: [topic], text: '', explanationUnitId: 'unit-source' },
      source: { assetId: 'source', assetRevision: 1 },
      candidates,
      explorationPool: [],
      evidence: {
        universeId: person.universeId,
        privacyEpoch: 1,
        evaluatedAt,
        watermark: 'x',
        policyVersion: 'fixture-actual-activity',
        topics: [],
        recent: [],
        established: {
          policyVersion: 'retained-activated-history.v0',
          watermark: 'x',
          units: candidates.map((c, n) => ({
            explanationUnitId: c.encounter.explanationUnitId,
            // The person has met the first one; the second is the last unseen explanation of the topic.
            encountered: n === 0,
            facets: [],
          })),
        },
        hiddenAssetIds: [],
      },
      watermarks: { catalog: 'c', continuity: 'none', taxonomy: 't', context: 'x' },
    };
  }

  const marks = () =>
    db()
      .selectFrom('supply.gap_signal_marks')
      .select(['universe_id', 'day', 'key', 'source', 'planet', 'facet', 'counted'])
      .orderBy('planet')
      .orderBy('source')
      .execute();

  describe('signals: where the system already knows content runs out', () => {
    it('records a Composer decision near the end of a topic as the person’s own mark, once a day, and never changes the decision', async () => {
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const record = withGapSignals(
        makeComposerStore({ isOperator: () => false }).persistComposerDecision,
        supply.gapSignals,
      );
      const person = await seedPerson(db());
      const decide = (snapshot: ComposerSnapshot) =>
        composeEncounter(snapshot, { ...COMPOSER_POLICY_V2, explorationFraction: 0 });
      const first = decide(lastUnseen(person, PLANET));
      expect(first.unseenLadder?.outcome).toBe('unseen');
      const persist = (decision: typeof first) =>
        withScope()(person.authority, (scope) =>
          record(scope, { decisionId: randomUUID(), commandId: randomUUID() }, decision),
        );
      expect((await persist(first)).kind).toBe('entered');
      expect(await marks()).toEqual([
        {
          universe_id: person.universeId,
          day: expect.any(Date) as Date,
          key: gapKeyOf('demand', { planet: PLANET }),
          source: 'low_headroom',
          planet: PLANET,
          facet: null,
          counted: false,
        },
      ]);
      // The same person again the same day, for another decision about the same planet: still one mark.
      await persist(decide(lastUnseen(person, PLANET)));
      expect(await marks()).toHaveLength(1);
      // The decision itself is stored as it always was: nothing of the signal is in it.
      const stored = await sql<{
        n: string;
      }>`select count(*) as n from composer.decisions where payload::text like '%low_headroom%'`.execute(db());
      expect(Number(stored.rows[0]!.n)).toBe(0);
      // Another person is another reader.
      const other = await seedPerson(db());
      await withScope()(other.authority, (scope) =>
        record(scope, { decisionId: randomUUID(), commandId: randomUUID() }, decide(lastUnseen(other, PLANET))),
      );
      expect(await marks()).toHaveLength(2);
    });

    it('does not count a decision that is replayed, because only a decision newly stored records', async () => {
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const record = withGapSignals(
        makeComposerStore({ isOperator: () => false }).persistComposerDecision,
        supply.gapSignals,
      );
      const person = await seedPerson(db());
      const decision = composeEncounter(lastUnseen(person, 'earth.seasons'), {
        ...COMPOSER_POLICY_V2,
        explorationFraction: 0,
      });
      const binding = { decisionId: randomUUID(), commandId: randomUUID() };
      const persist = () => withScope()(person.authority, (scope) => record(scope, binding, decision));
      await persist();
      const before = (await marks()).filter((mark) => mark.universe_id === person.universeId);
      expect(before).toHaveLength(1);
      await sql`delete from supply.gap_signal_marks where universe_id = ${person.universeId}::uuid`.execute(db());
      const replayed = await persist();
      expect(replayed).toMatchObject({ kind: 'entered', value: 'replayed' });
      expect((await marks()).filter((mark) => mark.universe_id === person.universeId)).toEqual([]);
    });

    it('records a planned demand and an ask that found no recipe left, by planet and facet, and nothing where the loop is off', async () => {
      const on = realSupply(database, content.boss, {
        createDailyCap: 10,
        growthDailyCap: 10,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const asker = await seedPerson(db());
      const asked = await on.create(asker.authority, {
        version: 'content-request.v1',
        commandId: randomUUID(),
        intent: {
          kind: 'topic',
          subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: PLANET, facetId: FACET_B },
          format: 'scroll',
        },
        language: 'en',
        capabilities: v2Capabilities,
      });
      if (asked.kind !== 'ok') throw new Error('CI ask refused');
      expect(await on.read(asker.authority, { requestId: asked.value.requestId })).toMatchObject({
        kind: 'ok',
        value: { status: 'unavailable', reason: 'no_recipe_left' },
      });
      const planner = await seedPerson(db());
      const planned: PlannedDemandInput = {
        plannerRunId: randomUUID(),
        slot: 0,
        topicIds: [PLANET],
        format: 'scroll',
        language: 'en',
        capabilities: v2Capabilities,
        alreadyMet: [],
        intent: plannedIntent(),
      };
      const outcome = await withScope()(planner.authority, (scope) => on.record(scope, planned));
      expect(outcome.kind === 'entered' ? outcome.value : undefined).toMatchObject({
        kind: 'not_commissioned',
        reason: 'no_recipe_left',
      });
      const found = (await marks()).filter((mark) => [asker.universeId, planner.universeId].includes(mark.universe_id));
      expect(found.map(({ source, planet, facet }) => ({ source, planet, facet }))).toEqual([
        { source: 'ask', planet: PLANET, facet: FACET_B },
        { source: 'planned_demand', planet: PLANET, facet: null },
      ]);
      // Never the ask's words: a mark holds catalogue ids and codes only.
      expect(JSON.stringify(found)).not.toContain('CI-PLANNED-BRIEF');

      // The same asks where the loop is off write nothing.
      const off = realSupply(database, content.boss, {
        createDailyCap: 10,
        growthDailyCap: 10,
        readExploration: content.readExploration,
      });
      const quiet = await seedPerson(db());
      await withScope()(quiet.authority, (scope) => off.record(scope, { ...planned, plannerRunId: randomUUID() }));
      expect((await marks()).filter((mark) => mark.universe_id === quiet.universeId)).toEqual([]);
    });

    it('erases a person’s marks with them, and with their Clear, and no other person’s', async () => {
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const mine = await seedPerson(db());
      const theirs = await seedPerson(db());
      for (const person of [mine, theirs])
        await withScope()(person.authority, (scope) =>
          supply.gapSignals(scope, [{ source: 'ask', planet: 'earth.seasons' }]),
        );
      expect(await marks()).toEqual(
        expect.arrayContaining([expect.objectContaining({ universe_id: mine.universeId })]),
      );
      const { supplyErasure } = await import('../../../packages/backend/src/modules/supply/adapters/erasure.js');
      expect(supplyErasure.tables.map((table) => `${table.schema}.${table.table}`)).toContain(
        'supply.gap_signal_marks',
      );
      await withScope()(mine.authority, async (scope) => {
        await supplyErasure.erase(scope);
      });
      const left = (await marks()).map((mark) => mark.universe_id);
      expect(left).not.toContain(mine.universeId);
      expect(left).toContain(theirs.universeId);
    });
  });

  describe('signals can never fail or delay a navigation, and a test account never feeds shared supply', () => {
    const decisionOf = (person: { universeId: string }) =>
      composeEncounter(lastUnseen(person, PLANET), { ...COMPOSER_POLICY_V2, explorationFraction: 0 });
    const storedFor = (universeId: string) =>
      count(sql<{ n: string }>`select count(*) as n from composer.decisions where universe_id = ${universeId}::uuid`);
    const marksOf = (universeId: string) =>
      db().selectFrom('supply.gap_signal_marks').select('planet').where('universe_id', '=', universeId).execute();
    const persistWith = (
      person: Awaited<ReturnType<typeof seedPerson>>,
      record: Parameters<typeof withGapSignals>[1],
      failures: string[] = [],
    ) =>
      withScope()(person.authority, (scope) =>
        withGapSignals(makeComposerStore({ isOperator: () => false }).persistComposerDecision, record, {
          onFailure: (code) => failures.push(code),
        })(scope, { decisionId: randomUUID(), commandId: randomUUID() }, decisionOf(person)),
      );

    it('stores the decision and goes on when the recorder fails: its writes are rolled back to a savepoint and the failure is only reported by its code', async () => {
      const person = await seedPerson(db());
      const failures: string[] = [];
      const outcome = await persistWith(
        person,
        async (scope) => {
          // A valid mark first, then a statement the table refuses: the mark must not survive the failure.
          await sql`insert into supply.gap_signal_marks (universe_id, privacy_epoch, day, key, source, planet)
            values (${person.universeId}::uuid, 1, current_date, ${'f'.repeat(64)}, 'ask', ${PLANET})`.execute(
            transactionOf(scope),
          );
          await sql`insert into supply.gap_signal_marks (universe_id, privacy_epoch, day, key, source, planet)
            values (${person.universeId}::uuid, 1, current_date, ${'e'.repeat(64)}, 'not-a-source', ${PLANET})`.execute(
            transactionOf(scope),
          );
        },
        failures,
      );
      // The navigation committed with its decision: the transaction was never poisoned.
      expect(outcome).toMatchObject({ kind: 'entered', value: 'stored' });
      expect(await storedFor(person.universeId)).toBe(1);
      expect(await marksOf(person.universeId)).toEqual([]);
      expect(failures).toEqual(['23514']);
    });

    it('stores the decision and goes on when the recorder throws before it touches anything', async () => {
      const person = await seedPerson(db());
      const failures: string[] = [];
      const outcome = await persistWith(person, () => Promise.reject(new Error('the recorder is down')), failures);
      expect(outcome).toMatchObject({ kind: 'entered', value: 'stored' });
      expect(await storedFor(person.universeId)).toBe(1);
      expect(failures).toEqual(['error']);
    });

    it('never waits on a row another transaction holds: it gives up at once and the navigation commits', async () => {
      const person = await seedPerson(db());
      const holder = await database.pool.connect();
      const lockedId = randomUUID();
      await sql`insert into supply.gaps (id, key, kind, planet, priority) values (${lockedId}::uuid, ${'9'.repeat(64)}, 'thin_planet', ${PLANET}, 500)`.execute(
        db(),
      );
      await holder.query('begin');
      await holder.query('select id from supply.gaps where id = $1 for update', [lockedId]);
      try {
        const failures: string[] = [];
        const started = Date.now();
        const outcome = await persistWith(
          person,
          async (scope) => {
            await sql`select id from supply.gaps where id = ${lockedId}::uuid for update`.execute(transactionOf(scope));
          },
          failures,
        );
        expect(Date.now() - started).toBeLessThan(3000);
        expect(outcome).toMatchObject({ kind: 'entered', value: 'stored' });
        expect(failures).toEqual(['55p03']);
        expect(await storedFor(person.universeId)).toBe(1);
      } finally {
        await holder.query('rollback');
        holder.release();
        await sql`delete from supply.gaps where id = ${lockedId}::uuid`.execute(db());
      }
    });

    it('records a mark without waiting on the same mark while the scan is counting it', async () => {
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const person = await seedPerson(db());
      await withScope()(person.authority, (scope) =>
        supply.gapSignals(scope, [{ source: 'ask', planet: 'earth.seasons' }]),
      );
      const scanning = await database.pool.connect();
      await scanning.query('begin');
      await scanning.query('update supply.gap_signal_marks set counted = true where universe_id = $1', [
        person.universeId,
      ]);
      try {
        const started = Date.now();
        const outcome = await withScope()(person.authority, (scope) =>
          supply.gapSignals(scope, [{ source: 'ask', planet: 'earth.seasons' }]),
        );
        expect(outcome.kind).toBe('entered');
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        await scanning.query('rollback');
        scanning.release();
      }
      expect(await marksOf(person.universeId)).toHaveLength(1);
    });

    it('writes no mark for a disposable test account, from a Composer decision, a planned demand or an ask, and does for the same person once the address is proved', async () => {
      const supply = realSupply(database, content.boss, {
        createDailyCap: 10,
        growthDailyCap: 10,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const person = await seedPerson(db());
      await sql`insert into identity.email_addresses (account_id, address, disposable)
        values (${person.accountId}::uuid, ${`ci-${randomUUID()}@example.test`}, true)`.execute(db());
      const planned: PlannedDemandInput = {
        plannerRunId: randomUUID(),
        slot: 0,
        topicIds: [PLANET],
        format: 'scroll',
        language: 'en',
        capabilities: v2Capabilities,
        alreadyMet: [],
        intent: plannedIntent(),
      };
      const request = {
        version: 'content-request.v1' as const,
        commandId: randomUUID(),
        intent: {
          kind: 'topic' as const,
          subject: {
            kind: 'catalogue' as const,
            catalogueVersion: 'content-concepts.v1' as const,
            topicId: PLANET,
            facetId: FACET_B,
          },
          format: 'scroll' as const,
        },
        language: 'en',
        capabilities: v2Capabilities,
      };
      // The Composer's decision (the real recorder of the loop, through the real persist port) is stored, and nothing is recorded.
      expect(await persistWith(person, supply.gapSignals)).toMatchObject({ kind: 'entered', value: 'stored' });
      expect(await storedFor(person.universeId)).toBe(1);
      await withScope()(person.authority, (scope) => supply.record(scope, planned));
      expect((await supply.create(person.authority, request)).kind).toBe('ok');
      expect(await marksOf(person.universeId)).toEqual([]);
      // The same person with an address proved by a mailed link is a reader like any other.
      await sql`update identity.email_addresses set disposable = false where account_id = ${person.accountId}::uuid`.execute(
        db(),
      );
      await persistWith(person, supply.gapSignals);
      expect((await marksOf(person.universeId)).map((mark) => mark.planet)).toEqual([PLANET]);
    });
  });

  describe('the scan: one gap for each hole', () => {
    beforeAll(async () => {
      await resetGaps();
    });

    it('opens one gap for each planet of a library with nothing released, and a second scan opens none', async () => {
      const first = loop();
      expect(await first.scan()).toMatchObject({
        kind: 'scanned',
        opened: CONCEPTS.filter((c) => c.parent !== null).length,
      });
      const rows = await gaps();
      const planets = CONCEPTS.filter((concept) => concept.parent !== null);
      expect(rows).toHaveLength(planets.length);
      expect(rows.every((row) => row.kind === 'thin_planet' && row.status === 'open' && row.priority === 500)).toBe(
        true,
      );
      expect(new Set(rows.map((row) => row.key)).size).toBe(planets.length);
      expect(rows[0]!.key).toBe(gapKeyOf('thin_planet', { planet: rows[0]!.planet }));
      // A second scan, and two at once, find the work done.
      const [a, b] = await Promise.all([first.scan(), first.scan()]);
      expect([a.kind, b.kind].every((kind) => kind === 'scanned' || kind === 'busy')).toBe(true);
      expect(await gaps()).toHaveLength(planets.length);
      expect(
        await count(
          sql<{
            n: string;
          }>`select count(*) as n from (select key from supply.gaps where status not in ('closed','rejected') group by key having count(*) > 1) d`,
        ),
      ).toBe(0);
    });

    it('counts the readers’ marks into the daily counters once each, and ranks the planet readers pointed to above the rest', async () => {
      const people = await Promise.all([seedPerson(db()), seedPerson(db()), seedPerson(db())]);
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      for (const person of people)
        await withScope()(person.authority, async (scope) => {
          await supply.gapSignals(scope, [{ source: 'low_headroom', planet: PLANET }]);
          // The same person pointing to the same planet again the same day is the same reader.
          await supply.gapSignals(scope, [{ source: 'last_resort', planet: PLANET }]);
        });
      const readers = loop();
      expect(await readers.scan()).toMatchObject({ kind: 'scanned', counted: expect.any(Number) as number });
      const counters = await db().selectFrom('supply.gap_signals').selectAll().where('planet', '=', PLANET).execute();
      expect(counters).toHaveLength(1);
      expect(counters[0]).toMatchObject({ key: gapKeyOf('demand', { planet: PLANET }), planet: PLANET, facet: null });
      // Three people, plus the readers the earlier tests left for this planet that were not counted yet.
      const readersOfPlanet = counters[0]!.readers;
      expect(readersOfPlanet).toBeGreaterThanOrEqual(3);
      expect((await marks()).filter((mark) => mark.planet === PLANET).every((mark) => mark.counted)).toBe(true);
      const [tides] = await gapOf(PLANET, 'thin_planet');
      const others = (await gaps()).filter((gap) => gap.planet !== PLANET);
      expect(tides).toMatchObject({ readers: readersOfPlanet });
      expect(tides!.priority).toBeGreaterThan(Math.max(...others.map((gap) => gap.priority)));
      // The same marks are never counted twice.
      await readers.scan();
      expect(
        (await db().selectFrom('supply.gap_signals').select('readers').where('planet', '=', PLANET).executeTakeFirst())
          ?.readers,
      ).toBe(readersOfPlanet);
    });

    it('closes a gap whose hole is gone, and deletes what is past its retention', async () => {
      // A facet gap for a planet that is thin as a whole is not a hole any more: the planet is asked for by itself.
      const staleId = randomUUID();
      await sql`insert into supply.gaps (id, key, kind, planet, facet, priority, first_seen_at)
        values (${staleId}::uuid, ${gapKeyOf('empty_facet', { planet: PLANET, facet: FACET_A })}, 'empty_facet', ${PLANET}, ${FACET_A}, 300, now())`.execute(
        db(),
      );
      const old = await seedPerson(db());
      await sql`insert into supply.gap_signal_marks (universe_id, privacy_epoch, day, key, source, planet, counted)
        values (${old.universeId}::uuid, 1, current_date - 5, ${gapKeyOf('demand', { planet: 'earth.seasons' })}, 'ask', 'earth.seasons', true)`.execute(
        db(),
      );
      await sql`insert into supply.gap_signals (key, day, planet, readers)
        values (${gapKeyOf('demand', { planet: 'earth.seasons' })}, current_date - 40, 'earth.seasons', 2)`.execute(
        db(),
      );
      const endedId = randomUUID();
      await sql`insert into supply.gaps (id, key, kind, planet, priority, status, closed_at, reason, first_seen_at)
        values (${endedId}::uuid, ${gapKeyOf('shallow_planet', { planet: 'earth.seasons' })}, 'shallow_planet', 'earth.seasons', 200, 'closed', now() - interval '100 days', 'filled', now() - interval '120 days')`.execute(
        db(),
      );
      expect(await loop().scan()).toMatchObject({ kind: 'scanned', closed: 1 });
      expect(
        await db().selectFrom('supply.gaps').select(['status', 'reason']).where('id', '=', staleId).executeTakeFirst(),
      ).toEqual({
        status: 'closed',
        reason: 'filled',
      });
      expect(
        await db().selectFrom('supply.gaps').select('id').where('id', '=', endedId).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await count(sql<{ n: string }>`select count(*) as n from supply.gap_signals where day < current_date - 30`),
      ).toBe(0);
      expect(
        await count(sql<{ n: string }>`select count(*) as n from supply.gap_signal_marks where day < current_date - 3`),
      ).toBe(0);
    });

    it('does nothing at all where the switch is off', async () => {
      await resetGaps();
      const off = loop({ enabled: false });
      expect(await off.scan()).toEqual({ kind: 'disabled' });
      expect(await off.brief()).toEqual({ kind: 'disabled' });
      expect(await gaps()).toEqual([]);
      expect(off.calls()).toBe(0);
    });
  });

  describe('the brief job: proposes, commissions under the cap, and the Scroll stays held', () => {
    /** One gap for the planet with held pages, ranked first by the readers who pointed to it. */
    async function openTidesGap() {
      await resetGaps();
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      for (const person of await Promise.all([seedPerson(db()), seedPerson(db())]))
        await withScope()(person.authority, (scope) =>
          supply.gapSignals(scope, [{ source: 'low_headroom', planet: PLANET }]),
        );
      await loop().scan();
      return (await gapOf(PLANET, 'thin_planet'))[0]!;
    }
    /** Two accepted drafts, one for each facet; the tag keeps the titles (and so the keys) of one test from another's. */
    const twoDrafts = (tag: string) =>
      answerWith({
        drafts: [
          draft(`How the moon Orrin raises two bulges in its seas, ${tag}`, FACET_A, BRIEFS[0]),
          draft(`Why a spring tide on Orrin is the strongest, ${tag}`, FACET_B, BRIEFS[1]),
        ],
      });

    it('asks once for recipes, stores what code accepts, commissions a production for each facet and records it on the gap', async () => {
      const gap = await openTidesGap();
      const run = loop({ cap: 10, day: 1, script: () => twoDrafts('first') });
      // The planets that hold no page are refused on the way, at no cost, and are not attempts.
      expect(await run.brief()).toMatchObject({ kind: 'done', proposed: 1, commissioned: 2, failed: 0, blocked: 0 });
      expect(run.calls()).toBe(1);
      const after = (await gaps()).find((row) => row.id === gap.id)!;
      expect(after).toMatchObject({ status: 'commissioned', attempts: 0, attempt_day: null });
      expect(after.recipes).toHaveLength(2);
      expect(after.proposal_run_id).not.toBeNull();
      const recipes = await db()
        .selectFrom('content.recipes')
        .select(['key', 'status', 'facet_id'])
        .where('key', 'in', after.recipes)
        .execute();
      // Stored and checked; a recipe moves on when its job runs, and the job is queued, one for each recipe.
      expect(recipes.map((recipe) => recipe.status)).toEqual(['checked', 'checked']);
      // Create's own group for each brief: shared, no person, counted by the growth cap, one job each.
      const groups = await db()
        .selectFrom('supply.work')
        .select(['commissioned_by', 'production_recipe', 'active'])
        .where('production_recipe', 'in', after.recipes)
        .execute();
      expect(groups).toHaveLength(2);
      expect(groups.every((group) => group.commissioned_by === 'growth' && group.active)).toBe(true);
      for (const key of after.recipes) expect(await jobsFor(key)).toBe(1);
    });

    it('produces a recipe through the real job and keeps its Scroll held: nothing is served until an operator releases it', async () => {
      const [gap] = (await gaps()).filter((row) => row.status === 'commissioned' && row.planet === PLANET);
      const key = gap!.recipes[0] as `gen-${string}`;
      const asset = (
        await db().selectFrom('content.recipes').select('asset_id').where('key', '=', key).executeTakeFirstOrThrow()
      ).asset_id;
      const production = fixtureProduction(db(), () => answerWith(plainOrrin()), orrinResearchFor);
      expect(await production.produce(key, false, signal(), true, 1)).toMatchObject({
        outcome: 'published',
        held: true,
      });
      expect(
        await db().selectFrom('content.assets').select('status').where('id', '=', asset).executeTakeFirst(),
      ).toEqual({ status: 'held' });
      expect(
        await db()
          .selectFrom('content.revision_reviews')
          .select('state')
          .where('asset_id', '=', asset)
          .executeTakeFirst(),
      ).toEqual({ state: 'held' });
      // The library can serve nothing of it: the scan finds the planet no better off, and the gap still waits for the read.
      const result = await loop().scan();
      expect(result).toMatchObject({ kind: 'scanned', closed: 0 });
      expect((await gaps()).find((row) => row.id === gap!.id)!.status).toBe('commissioned');
      const covered = await readReleasedCoverage(db());
      expect(covered.planets.find((p) => p.topicId === PLANET)).toBeUndefined();

      // Released by an operator, the Scroll is served, the gap closes as released, and the hole that remains opens a fresh gap.
      expect(
        await makeReviewGate(db()).release({ assetId: asset, revision: 1, decidedBy: 'cli:ci-reviewer' }),
      ).toMatchObject({ kind: 'released' });
      expect((await readReleasedCoverage(db())).planets.find((p) => p.topicId === PLANET)).toMatchObject({ units: 1 });
      expect(await loop().scan()).toMatchObject({ kind: 'scanned', closed: 1, opened: 1 });
      expect((await gaps()).find((row) => row.id === gap!.id)).toMatchObject({ status: 'closed', reason: 'released' });
      expect((await gapOf(PLANET)).filter((row) => row.status === 'open')).toHaveLength(1);
    });

    it('commissions no more than the growth cap leaves, and leaves the rest of what was stored for later', async () => {
      await resetGaps();
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      for (const person of await Promise.all([seedPerson(db()), seedPerson(db())]))
        await withScope()(person.authority, (scope) =>
          supply.gapSignals(scope, [{ source: 'low_headroom', planet: PLANET }]),
        );
      await loop().scan();
      const capped = loop({ cap: 1, day: 2, script: () => twoDrafts('capped') });
      expect(await capped.brief()).toMatchObject({ proposed: 1, commissioned: 1 });
      expect(
        await count(sql<{ n: string }>`select count(*) as n from supply.work where production_recipe like 'gen-%'`),
      ).toBe(1);
      expect(
        await count(sql<{ n: string }>`select count(*) as n from pgboss.job where name = 'content.produce-scroll'`),
      ).toBe(1);
      // Both recipes were stored and checked; one was commissioned and the other waits, still checked and still the loop's to commission.
      expect(await count(sql<{ n: string }>`select count(*) as n from content.recipes where status = 'checked'`)).toBe(
        2,
      );
      // The cap is used up: the next pass proposes and commissions nothing, and asks no model.
      expect(await capped.brief()).toMatchObject({ proposed: 0, commissioned: 0 });
      expect(capped.calls()).toBe(1);
      expect(
        await count(sql<{ n: string }>`select count(*) as n from supply.work where production_recipe like 'gen-%'`),
      ).toBe(1);
    });

    it('does not pay twice for a redelivery: a crash after the recipes were stored is answered by what is stored, and a lost job is sent again as one job', async () => {
      const gap = await openTidesGap();
      const attemptsBefore = await count(sql<{ n: string }>`select count(*) as n from reasoning.production_attempts`);
      // The pass dies after the model answered and its recipes were stored, and before the answer was recorded on the gap.
      const crashing = loop({
        day: 4,
        script: () => twoDrafts('redelivered'),
        // Free refusals settle as usual; the answer of the planet that holds pages is lost before it is recorded.
        wrapStore: (store) => ({
          ...store,
          settle: (id, transition, at) =>
            transition.kind === 'refused'
              ? store.settle(id, transition, at)
              : Promise.reject(new Error('CI crash before the answer was recorded')),
        }),
      });
      await expect(crashing.brief()).rejects.toThrow('CI crash');
      expect(crashing.calls()).toBe(1);
      expect(await count(sql<{ n: string }>`select count(*) as n from content.recipes where status = 'checked'`)).toBe(
        2,
      );
      const pinned = (await gaps()).find((row) => row.id === gap.id)!;
      expect(pinned).toMatchObject({ status: 'open', attempts: 0 });
      expect(pinned.attempt_day).not.toBeNull();
      // The delivery again, in a new process whose model would answer differently: what is stored is commissioned, and nothing is asked.
      const again = loop({ day: 3, script: () => answerWith({ drafts: [] }) });
      expect(await again.brief()).toMatchObject({ proposed: 0, commissioned: 2 });
      expect(again.calls()).toBe(0);
      const after = (await gaps()).find((row) => row.id === gap.id)!;
      expect(after).toMatchObject({ status: 'commissioned', attempt_day: null });
      expect(await count(sql<{ n: string }>`select count(*) as n from reasoning.production_attempts`)).toBe(
        attemptsBefore + 1,
      );
      for (const key of after.recipes) expect(await jobsFor(key)).toBe(1);
      // A job lost after the group committed is sent again by the next pass, and is still one job.
      await sql`delete from pgboss.job where name = 'content.produce-scroll'`.execute(db());
      await again.brief();
      for (const key of after.recipes) expect(await jobsFor(key)).toBe(1);
      await again.brief();
      for (const key of after.recipes) expect(await jobsFor(key)).toBe(1);
    });

    it('answers a delivery after midnight from the ledger: the gap pinned the day of the attempt, so a kept answer is stored and never paid for again', async () => {
      const gap = await openTidesGap();
      // The model is paid and its answer is kept, but the store refuses (the process died, or the root was switched off): nothing is stored.
      const refused = loop({ day: 8, refuseStore: true, script: () => twoDrafts('kept') });
      expect(await refused.brief()).toMatchObject({ proposed: 1, failed: 0, blocked: 0, paused: true });
      expect(refused.calls()).toBe(1);
      expect(await count(sql<{ n: string }>`select count(*) as n from content.recipes`)).toBe(0);
      const waiting = (await gaps()).find((row) => row.id === gap.id)!;
      expect(waiting).toMatchObject({ status: 'open', attempts: 0, reason: 'scope_refused' });
      expect(waiting.attempt_day).not.toBeNull();
      // The next delivery is a day later and its model would answer differently: it sends the same request, and the ledger answers it.
      const later = loop({ day: 3, script: () => answerWith({ drafts: [] }) });
      expect(await later.brief()).toMatchObject({ proposed: 1, commissioned: 2, failed: 0 });
      expect(later.calls()).toBe(0);
      const after = (await gaps()).find((row) => row.id === gap.id)!;
      expect(after).toMatchObject({ status: 'commissioned', attempts: 0 });
      expect(after.proposal_run_id).not.toBeNull();
      expect(
        await count(
          sql<{
            n: string;
          }>`select count(*) as n from reasoning.production_attempts where run_id = ${after.proposal_run_id!}::uuid`,
        ),
      ).toBe(1);
      for (const key of after.recipes) expect(await jobsFor(key)).toBe(1);
    });

    it('blocks a gap whose attempt is of unknown outcome and never sends it again', async () => {
      const gap = await openTidesGap();
      const unknown = loop({ day: 5, script: () => ({ kind: 'timeout_after_dispatch' }) });
      expect(await unknown.brief()).toMatchObject({ proposed: 1, blocked: 1 });
      expect(unknown.calls()).toBe(1);
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({ status: 'blocked_unknown', attempts: 0 });
      const reason = (await gaps()).find((row) => row.id === gap.id)!.reason;
      expect(reason).toMatch(/^[a-z][a-z0-9_]*$/u);
      // Not on the next pass, not in a new process, not after the scan: the model is never asked again for this attempt.
      const next = loop({ day: 5, script: () => twoDrafts('unknown') });
      expect(await next.brief()).toMatchObject({ proposed: 0 });
      await next.scan();
      expect(await next.brief()).toMatchObject({ proposed: 0 });
      expect(next.calls()).toBe(0);
      expect((await gaps()).find((row) => row.id === gap.id)!.status).toBe('blocked_unknown');
    });

    it('settles a blocked gap only after its unknown attempt is settled in the ledger, and then reopens it as a request of its own', async () => {
      const gap = await openTidesGap();
      const blocked = loop({ day: 11, script: () => ({ kind: 'timeout_after_dispatch' }) });
      expect(await blocked.brief()).toMatchObject({ blocked: 1 });
      const row = (await gaps()).find((candidate) => candidate.id === gap.id)!;
      // The run of the unknown attempt is kept on the gap, so an operator can find it in the ledger.
      expect(row).toMatchObject({ status: 'blocked_unknown', attempts: 0 });
      expect(row.proposal_run_id).not.toBeNull();
      // The ledger still holds the attempt as unresolved: nothing is settled, with or without an action.
      for (const action of [undefined, 'reopen', 'close'] as const) {
        const refused = await settleBlockedGap(db(), { key: gap.key, ...(action === undefined ? {} : { action }) });
        expect(refused).toMatchObject({ kind: 'refused', verdict: 'unsettled' });
        expect(refused.kind === 'refused' && refused.unresolved).toBeGreaterThan(0);
      }
      expect((await gaps()).find((candidate) => candidate.id === gap.id)!.status).toBe('blocked_unknown');
      // The operator writes the attempt off (as `reasoning write-off` does): now it may be settled.
      await sql`update reasoning.production_attempts set state = 'written_off', written_off_reason = 'CI fixture write-off',
          written_off_by = 'cli:ci', written_off_at = now()
        where run_id = ${row.proposal_run_id!}::uuid and state in ('reserved', 'dispatched', 'unknown')`.execute(db());
      expect(await settleBlockedGap(db(), { key: gap.key })).toEqual({ kind: 'ready' });
      expect((await gaps()).find((candidate) => candidate.id === gap.id)!.status).toBe('blocked_unknown');
      expect(await settleBlockedGap(db(), { key: gap.key, action: 'reopen' })).toEqual({ kind: 'reopened' });
      expect((await gaps()).find((candidate) => candidate.id === gap.id)).toMatchObject({
        status: 'open',
        attempts: 1,
        proposal_run_id: null,
        attempt_day: null,
        reason: 'settled_reopened',
      });
      // The next request is a new one (the blocked attempt counts as a failed one): the model is asked, once, and never the blocked request again.
      const again = loop({ day: 11, script: () => twoDrafts('settled') });
      expect(await again.brief()).toMatchObject({ proposed: 1, blocked: 0 });
      expect(again.calls()).toBe(1);
    });

    it('refuses to settle a gap that is not blocked or names no run, finds nothing for an unknown key, and closes a blocked gap whose ledger is settled', async () => {
      await resetGaps();
      const row = (key: string, status: string, run: string | null) =>
        sql`insert into supply.gaps (id, key, kind, planet, priority, status, proposal_run_id, reason)
        values (${randomUUID()}::uuid, ${key}, 'thin_planet', ${`fixture.planet-${key.slice(0, 4)}`}, 500, ${status}, ${run}::uuid, ${status === 'blocked_unknown' ? 'unknown_outcome' : null})`.execute(
          db(),
        );
      const open = 'a'.repeat(64);
      const noRun = 'b'.repeat(64);
      const settled = 'c'.repeat(64);
      await row(open, 'open', null);
      await row(noRun, 'blocked_unknown', null);
      await row(settled, 'blocked_unknown', randomUUID());
      expect(await settleBlockedGap(db(), { key: open, action: 'close' })).toMatchObject({
        kind: 'refused',
        verdict: 'not_blocked',
      });
      expect(await settleBlockedGap(db(), { key: noRun, action: 'reopen' })).toMatchObject({
        kind: 'refused',
        verdict: 'no_run',
      });
      expect(await settleBlockedGap(db(), { key: 'd'.repeat(64) })).toEqual({ kind: 'not_found' });
      expect(await settleBlockedGap(db(), { key: settled, action: 'close' })).toEqual({ kind: 'closed' });
      expect((await gaps()).find((candidate) => candidate.key === settled)).toMatchObject({
        status: 'closed',
        reason: 'settled_closed',
      });
      expect((await gaps()).find((candidate) => candidate.key === open)!.status).toBe('open');
    });

    it('rejects a gap with the reason code after two failed attempts, and reopens its key only for new readers after the cooldown', async () => {
      const gap = await openTidesGap();
      const run = loop({ day: 6, script: () => answerWith({ drafts: [] }) });
      expect(await run.brief()).toMatchObject({ proposed: 1, failed: 1 });
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({
        status: 'open',
        attempts: 1,
        reason: 'nothing_accepted',
        attempt_day: null,
      });
      // The second attempt is a request of its own (the retry number), not the first answered again.
      expect(await run.brief()).toMatchObject({ proposed: 1, rejected: 1 });
      expect(run.calls()).toBe(2);
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({
        status: 'rejected',
        attempts: 2,
        reason: 'nothing_accepted',
      });
      expect(await run.brief()).toMatchObject({ proposed: 0 });

      // The structure alone never reopens it, and neither do readers inside the cooldown.
      await run.scan();
      expect((await gapOf(PLANET)).filter((row) => row.status === 'open')).toEqual([]);
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      await withScope()((await seedPerson(db())).authority, (scope) =>
        supply.gapSignals(scope, [{ source: 'ask', planet: PLANET }]),
      );
      await run.scan();
      expect((await gapOf(PLANET)).filter((row) => row.status === 'open')).toEqual([]);
      // After the cooldown, with readers since, a fresh gap opens under the same key; the rejected one stays as it was.
      const pinned = Date.UTC(2026, 10, 10 - 6, 12);
      await sql`update supply.gaps set closed_at = ${new Date(pinned - 9 * 86_400_000)} where id = ${gap.id}::uuid`.execute(
        db(),
      );
      await run.scan();
      const rows = await gapOf(PLANET, 'thin_planet');
      expect(rows.filter((row) => row.status === 'open')).toHaveLength(1);
      expect(rows.find((row) => row.id === gap.id)!.status).toBe('rejected');
      expect(new Set(rows.map((row) => row.key)).size).toBe(1);
    });

    /** One accepted draft, for the first facet: a gap with one recipe, so a rejected take leaves nothing else in the pipeline. */
    const oneDraft = (tag: string) =>
      answerWith({ drafts: [draft(`How the moon Orrin raises two bulges in its seas, ${tag}`, FACET_A, BRIEFS[0])] });

    it('does not strand a gap whose take an operator rejected: the stored recipe is commissioned again with no model call, each round is counted, and the bound rejects the gap', async () => {
      const gap = await openTidesGap();
      const first = loop({ day: 9, script: () => oneDraft('rejected take') });
      expect(await first.brief()).toMatchObject({ proposed: 1, commissioned: 1 });
      const key = (await gaps()).find((row) => row.id === gap.id)!.recipes[0] as `gen-${string}`;
      const asset = (
        await db().selectFrom('content.recipes').select('asset_id').where('key', '=', key).executeTakeFirstOrThrow()
      ).asset_id;
      const production = fixtureProduction(db(), () => answerWith(plainOrrin()), orrinResearchFor);
      const reject = async (take: number) => {
        expect(await production.produce(key, false, signal(), true, take)).toMatchObject({
          outcome: 'published',
          held: true,
        });
        expect(
          await makeReviewGate(db()).reject({
            assetId: asset,
            revision: take,
            reason: 'CI fixture: not good enough',
            decidedBy: 'cli:ci-reviewer',
          }),
        ).toMatchObject({ kind: 'rejected' });
      };
      const scanner = loop({ maxRounds: 3 });
      const later = loop({ day: 9, script: () => answerWith({ drafts: [] }) });

      // Take 1 is rejected: the recipe may be taken again, and nothing waits on it, so the gap goes back to briefed.
      await reject(1);
      expect((await readRecipeStates(db(), [key])).get(key)).toBe('retryable');
      expect(await scanner.scan()).toMatchObject({ kind: 'scanned', rebriefed: 1, rejected: 0 });
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({
        status: 'briefed',
        rounds: 1,
        recipes: [key],
      });
      // The next pass commissions the stored recipe again under the cap, a new group and a job for take 2, and asks no model.
      expect(await later.brief()).toMatchObject({ proposed: 0, commissioned: 1 });
      expect(later.calls()).toBe(0);
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({ status: 'commissioned', recipes: [key] });
      expect(await jobsFor(key)).toBe(2);
      expect(
        await count(sql<{ n: string }>`select count(*) as n from supply.work where production_recipe = ${key}`),
      ).toBe(2);
      expect(
        await count(
          sql<{ n: string }>`select count(*) as n from supply.work where production_recipe = ${key} and active`,
        ),
      ).toBe(1);

      // Take 2 is rejected: round two, commissioned again as take 3.
      await reject(2);
      expect(await scanner.scan()).toMatchObject({ rebriefed: 1, rejected: 0 });
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({ status: 'briefed', rounds: 2 });
      expect(await later.brief()).toMatchObject({ proposed: 0, commissioned: 1 });
      expect(await jobsFor(key)).toBe(3);

      // Take 3 is rejected and the takes are used up: the third failed round rejects the gap at the bound, and no fresh gap opens in that scan.
      await reject(3);
      expect(await scanner.scan()).toMatchObject({ rejected: 1, rebriefed: 0, reopened: 0 });
      expect((await gaps()).find((row) => row.id === gap.id)).toMatchObject({
        status: 'rejected',
        reason: 'production_rejected',
        rounds: 3,
      });
      expect((await gapOf(PLANET, 'thin_planet')).filter((row) => row.status === 'open')).toEqual([]);
      expect(later.calls()).toBe(0);
    });

    it('runs one pass at a time: a second pass finds the first holding the lock and asks nothing, and a crashed pass frees it', async () => {
      await openTidesGap();
      const hold = gate();
      const first = loop({
        day: 12,
        script: async () => {
          await hold.promise;
          return twoDrafts('overlap');
        },
      });
      const second = loop({ day: 12, script: () => twoDrafts('overlap again') });
      const running = first.brief();
      for (let waited = 0; first.calls() === 0 && waited < 100; waited += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(first.calls()).toBe(1);
      // The first pass is out with the model: a second one does nothing.
      expect(await second.brief()).toEqual({ kind: 'busy' });
      expect(second.calls()).toBe(0);
      hold.open();
      expect(await running).toMatchObject({ kind: 'done', proposed: 1 });
      // Done: the lock is free again.
      expect(await second.brief()).toMatchObject({ kind: 'done' });
      // A pass that dies holding it frees it with its connection.
      const held = await database.pool.connect();
      await held.query("select pg_advisory_lock(hashtextextended('supply.brief-gap', 0))");
      expect(await second.brief()).toEqual({ kind: 'busy' });
      held.release(true);
      for (let waited = 0; waited < 100; waited += 1) {
        if ((await second.brief()).kind !== 'busy') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await second.brief()).kind).toBe('done');
    });

    it('rejects at once, spending nothing, a planet that holds no pages: not an attempt, and it leaves the pass to the planets that do', async () => {
      await resetGaps();
      const supply = realSupply(database, content.boss, {
        createDailyCap: 5,
        growthEnabled: true,
        readExploration: content.readExploration,
      });
      const bare = 'earth.seasons';
      for (const person of await Promise.all([seedPerson(db()), seedPerson(db())]))
        await withScope()(person.authority, (scope) =>
          supply.gapSignals(scope, [{ source: 'low_headroom', planet: bare }]),
        );
      const run = loop({ day: 7, script: () => twoDrafts('bare') });
      await run.scan();
      const planets = CONCEPTS.filter((concept) => concept.parent !== null).length;
      expect(await run.brief()).toMatchObject({ kind: 'done', proposed: 1, commissioned: 2, rejected: planets - 1 });
      // The model was asked once, for the one planet that holds pages.
      expect(run.calls()).toBe(1);
      const refused = (await gaps()).filter((row) => row.status === 'rejected');
      expect(refused).toHaveLength(planets - 1);
      expect(
        refused.every(
          (row) => row.reason === 'no_candidate_pages' && row.attempts === 0 && row.last_attempt_at === null,
        ),
      ).toBe(true);
    });
  });

  describe('the operator’s list', () => {
    it('counts the gaps by status and kind and lists them with codes only', async () => {
      const summary = await readGapSummary(db());
      expect(summary.counts.length).toBeGreaterThan(0);
      expect(summary.gaps.length).toBeGreaterThan(0);
      const open = await readGapSummary(db(), { status: 'rejected' });
      expect(open.gaps.every((gap) => gap.status === 'rejected')).toBe(true);
      // Catalogue ids, codes and counts: the planet is a catalogue id and no recipe text is in the view.
      expect(JSON.stringify(summary)).not.toContain('Orrin');
      expect(Object.keys(summary.gaps[0]!).sort()).toEqual(
        [
          'attempts',
          'facet',
          'firstSeenAt',
          'gapId',
          'kind',
          'lastAttemptAt',
          'planet',
          'priority',
          'readers',
          'reason',
          'recipes',
          'status',
        ].sort(),
      );
    });
  });
});
