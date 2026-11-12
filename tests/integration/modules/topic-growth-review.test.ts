import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  appendRelease,
  catalogueStatus,
  decideTopic,
  makeCatalogue,
  makeGrowTopics,
  makeProposeTopic,
  makeSeedTopicCandidates,
  proposeUnderLock,
  readCandidate,
  reviewCandidates,
  showServableTopics,
  topicGrowthLock,
  type ReadResearchPage,
  type SeedResult,
} from '@knowscroll/backend/modules/content/nest-providers';
import { extractResearch } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { stableUuid } from '../../../packages/backend/src/infrastructure/ids/index.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { answerWith, enableProductionScope } from '../support/generated-scroll.js';

/**
 * The review of topic growth (#674, D-422): an outage trips the role's brake and blocks nobody, a late answer of a parallel delivery still links its
 * topic, the command and the pass never run at once, a candidate no system offers itself for does not hold the queue, a bad seed row is skipped, and
 * the owner approves each topic that grew before it can be served. The model is a labelled CI fixture and every page an authored fixture about an
 * invented moon; no request leaves the process.
 */

const wiki = (title: string) => `https://en.wikipedia.org/wiki/${title}`;
const ORRIN = [
  'The moon Orrin is a small invented world whose two shallow seas rise and fall twice during each lunar day because of the pull of its giant planet.',
  'Because the planet holds one face of Orrin turned toward it, the near sea is pulled into a deep bulge while the far sea is left behind.',
  'Sailors of Orrin learned to read the two high waters and the two low waters, and they kept a calendar of fishing and trade by them.',
  'In a narrow bay on Orrin the incoming water is squeezed into a smaller space, so the sea climbs much higher there than on an open shore.',
  'When the second moon lines up with the first at the new moon, the two pulls add together and the seas of Orrin reach their highest range of the month.',
  'The first charts of the Orrin seas were drawn by pilots who measured the depth of every channel with weighted lines over many seasons.',
  'Scholars of Orrin later explained the two bulges with a law of attraction that grows weaker with distance, and they tested it against the pilots tables.',
  'Today the people of Orrin build small mills in the narrowest bays, where the strong flow of the tide can turn a wheel twice a day.',
] as const;
const QUOTES = [
  'two shallow seas rise and fall twice during each lunar day because of the pull of its giant planet',
  'In a narrow bay on Orrin the incoming water is squeezed into a smaller space, so the sea climbs much higher there',
  'Sailors of Orrin learned to read the two high waters and the two low waters, and they kept a calendar of fishing and trade by them',
] as const;
const NO_SEED: SeedResult = { sourcesRead: 0, found: 0, evaluated: 0, eligible: 0, rejected: 0, deferred: 0 };

const proposal = (label: string) =>
  answerWith({
    topics: [
      {
        systemId: 'earth',
        label,
        meaning: 'How the two small seas of the invented moon Orrin rise and fall under the pull of their planet.',
        facets: [
          {
            label: 'Daily rhythm',
            meaning: 'How often the seas of a moon rise and fall in one day of the moon.',
            quote: QUOTES[0],
          },
          {
            label: 'Narrow bays',
            meaning: 'Why the water of a sea climbs higher where a bay narrows.',
            quote: QUOTES[1],
          },
          {
            label: 'Reading the water',
            meaning: 'How people who live by a sea learn to read its high and low waters.',
            quote: QUOTES[2],
          },
        ],
      },
    ],
  });

describe('The review of topic growth (labelled CI fixtures, real PostgreSQL and pg-boss)', () => {
  let database: TestDatabase<Database>;
  const db = () => database.db;
  const live = () => makeCatalogue(db(), { revalidateMs: 0, background: false });

  /** The proposal role on its own harness over the test database, the proposer and a scheduled pass, with a labelled fixture model. */
  function build(
    script: (sequence: number) => FixtureScenario,
    options: {
      readonly maxPerSystem?: number;
      readonly dayShift?: number;
      readonly seed?: (signal: AbortSignal) => Promise<SeedResult>;
    } = {},
  ) {
    const fixture = fixtureModel(script, { label: 'topic-proposal-review-CI-fixture' });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    const scope = makeWithProductionScope(db(), { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: db(),
        withProductionScope: scope,
        enabled: true,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    // The real clock, as the cap and the backoff count by the database's own; a test that needs tomorrow shifts it.
    const now = () => new Date(Date.now() + (options.dayShift ?? 0) * 86_400_000);
    const maxTopicsPerSystem = options.maxPerSystem ?? 12;
    const propose = makeProposeTopic({
      db: db(),
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope: scope,
      harness,
      maxTopicsPerSystem,
      now,
    });
    const pass = makeGrowTopics({
      enabled: true,
      growthDailyCap: 10,
      maxTopicsPerSystem,
      db: db(),
      lock: topicGrowthLock(db()),
      seed: options.seed ?? (() => Promise.resolve(NO_SEED)),
      propose,
      now,
    });
    return { propose, pass, calls: () => fixture.calls.length };
  }

  /** An eligible candidate stored directly, a moment after the one before it. */
  async function eligible(url: string, title: string, passages: readonly string[] = ORRIN) {
    await db()
      .insertInto('content.topic_candidates')
      .values({
        page_url: url,
        host: new URL(url).hostname,
        status: 'eligible',
        title,
        passages: JSON.stringify(passages),
        passage_count: passages.length,
        policy_version: 'topic-growth.v1',
      })
      .execute();
    return url;
  }
  const statusOf = async (url: string) => (await readCandidate(db(), url))?.status;
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const dayAfterTomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  /** Each part has a database of its own: the role's failure brake and the queue of candidates are counted over a whole database. */
  function useDatabase(name: string) {
    beforeAll(async () => {
      database = await createTestDatabase<Database>(name);
      await enableProductionScope(db());
    });
    afterAll(async () => {
      await database.drop();
    });
  }

  describe('an outage of the provider', () => {
    useDatabase('topic_review_outage');
    it('trips the role’s brake after five failed runs and blocks nobody: the step pauses, and no failed candidate is asked again the same day', async () => {
      const urls: string[] = [];
      for (let n = 0; n < 7; n += 1)
        urls.push(await eligible(wiki(`Orrin_outage_${String(n)}`), `Orrin outage ${String(n)}`));
      const { pass, calls } = build(() => ({ kind: 'not_connected' }));
      const results = [];
      for (let n = 0; n < 7; n += 1) results.push(await pass(signal()));
      // Five failures, each a closed attempt on its own candidate.
      expect(results.slice(0, 5).map((result) => (result.kind === 'done' ? result.proposals : []))).toEqual(
        Array.from({ length: 5 }, () => ['failed']),
      );
      expect(calls()).toBe(5);
      for (const url of urls.slice(0, 5))
        expect(await readCandidate(db(), url)).toMatchObject({
          status: 'eligible',
          attempts: 1,
          notBefore: tomorrow(),
        });
      // The sixth is refused by the brake before anything is sent: the pass pauses, on the candidate next in line, and so does the one after.
      for (const result of results.slice(5))
        expect(result).toMatchObject({ kind: 'done', proposals: ['paused'], paused: true });
      expect(calls()).toBe(5);
      expect(await readCandidate(db(), urls[5]!)).toMatchObject({ status: 'proposed', attempts: 0 });
      expect(await statusOf(urls[6]!)).toBe('eligible');
      // Nobody is blocked, and no failed candidate was asked a second time today.
      const counts = await sql<{
        status: string;
        n: string;
      }>`select status, count(*) as n from content.topic_candidates group by status`.execute(db());
      expect(counts.rows.find((row) => row.status === 'blocked_unknown')).toBeUndefined();
      expect(
        Number(
          (await sql<{ n: string }>`select count(*) as n from content.topic_proposals where retry > 0`.execute(db()))
            .rows[0]!.n,
        ),
      ).toBe(0);
    });
  });

  describe('two deliveries of one request', () => {
    useDatabase('topic_review_twins');
    it('link the topic even when the other delivery blocked the candidate while the answer was kept', async () => {
      const url = await eligible(wiki('Orrin_twins'), 'Orrin twins');
      const held = gate<void>();
      const { propose, calls } = build(() => ({
        kind: 'hold',
        until: held.promise.then(() => proposal('Orrin twins')),
      }));
      const first = propose({ pageUrl: url, dryRun: false }, signal());
      await vi.waitFor(() => expect(calls()).toBe(1));
      // The same request again while the first waits at the model: the ledger says the attempt is out, which this delivery cannot resend.
      const second = await propose({ pageUrl: url, dryRun: false }, signal());
      expect(second).toMatchObject({ kind: 'failed', closed: false });
      expect(await statusOf(url)).toBe('blocked_unknown');
      // The answer of the first arrives after all: the topic is made, and the candidate it grew from is linked, not left blocked.
      held.open();
      expect(await first).toMatchObject({ kind: 'admitted', topicId: 'earth.orrin-twins' });
      expect(calls()).toBe(1);
      expect(await readCandidate(db(), url)).toMatchObject({
        status: 'admitted',
        topicId: 'earth.orrin-twins',
        verdict: 'ok',
      });
      const runs = await sql<{
        state: string;
        outcome: string | null;
        topic_id: string | null;
      }>`select state, outcome, topic_id
        from content.topic_proposals where page_url = ${url}`.execute(db());
      expect(runs.rows).toEqual([{ state: 'completed', outcome: 'admitted', topic_id: 'earth.orrin-twins' }]);
    });

    it('are kept apart from the scheduled pass: the operator’s command waits for the pass’s lock and asks nothing while it is held', async () => {
      const url = await eligible(wiki('Orrin_locked'), 'Orrin locked');
      const { propose, calls } = build(() => proposal('Orrin locked'));
      const lock = topicGrowthLock(db());
      const busy = await db()
        .connection()
        .execute(async (connection) => {
          await sql`select pg_advisory_lock(hashtextextended('content.grow-topics', 0))`.execute(connection);
          try {
            return await proposeUnderLock(lock, propose, { pageUrl: url, dryRun: false }, signal());
          } finally {
            await sql`select pg_advisory_unlock(hashtextextended('content.grow-topics', 0))`.execute(connection);
          }
        });
      expect(busy).toEqual({ kind: 'busy' });
      expect(calls()).toBe(0);
      expect(await statusOf(url)).toBe('eligible');
      // Free, it runs, and releases the lock for the next.
      expect(await proposeUnderLock(lock, propose, { pageUrl: url, dryRun: false }, signal())).toMatchObject({
        kind: 'admitted',
        topicId: 'earth.orrin-locked',
      });
      expect(await lock.exclusively(() => Promise.resolve('free'))).toBe('free');
    });
  });

  describe('a page no system offers itself for', () => {
    useDatabase('topic_review_room');
    it('is backed off to the next day and does not hold the queue: the candidate behind it is tried in the same pass', async () => {
      // Twenty systems in all, more than the twelve a model is shown, so the ones offered are the ones that share key words with the page.
      const systems = Array.from({ length: 14 }, (_, n) => ({
        kind: 'add' as const,
        draft: {
          id: `zeppelin${String.fromCharCode(97 + n)}`,
          kind: 'system' as const,
          parentId: null,
          label: `Zeppelin hangar ${String(n)}`,
          meaning: `The airships of the invented hangar ${String(n)}, and the zeppelin fleets that fly from it.`,
          sceneFamily: 'ridged.v1' as const,
          haze: 'pink' as const,
          sameMeaningAs: [],
        },
      }));
      expect(await appendRelease(db(), systems, 'operator')).toMatchObject({ kind: 'appended' });
      const unplaceable = await eligible(wiki('Xylophone_quartz'), 'Xylophone quartz', [
        'The xylophone quartz crystal rings when it is struck with a small wooden mallet in a quiet room of the museum.',
        'A quartz xylophone has bars cut from the crystal, and each bar is tuned by grinding its underside very slowly.',
      ]);
      const placeable = await eligible(wiki('Zeppelin_hangar_page'), 'Zeppelin hangar', [
        'A zeppelin hangar is a very large shed built to shelter an airship, and zeppelin hangars are among the largest buildings ever made.',
        'The doors of a zeppelin hangar open the full width of the building so that a zeppelin can be walked out into the wind.',
      ]);
      const { pass, calls } = build(() => answerWith({ topics: [] }));
      const first = await pass(signal());
      // The first candidate is refused for nothing, the second is asked about: the queue moved on.
      expect(first).toMatchObject({ kind: 'done', proposals: ['refused', 'not_admitted'] });
      expect(calls()).toBe(1);
      expect(await readCandidate(db(), unplaceable)).toMatchObject({
        status: 'eligible',
        attempts: 0,
        notBefore: tomorrow(),
      });
      expect((await readCandidate(db(), unplaceable))!.attemptDay).toBeUndefined();
      expect(await statusOf(placeable)).toBe('refused');
      // Today it is not asked again, and nothing is sent for it; tomorrow it is, and backed off again.
      expect(await pass(signal())).toMatchObject({ kind: 'done', idle: 'no_candidate', proposals: [] });
      expect(calls()).toBe(1);
      const later = build(() => answerWith({ topics: [] }), { dayShift: 1 });
      expect(await later.pass(signal())).toMatchObject({ kind: 'done', proposals: ['refused'] });
      expect(later.calls()).toBe(0);
      expect(await readCandidate(db(), unplaceable)).toMatchObject({
        status: 'eligible',
        notBefore: dayAfterTomorrow(),
      });
    });
  });

  describe('a bad seed row', () => {
    useDatabase('topic_review_seed');
    const SOURCE = wiki('Orrin_seed_source');
    const page = (url: string, text: readonly string[]) =>
      extractResearch(
        `<html><title>Seed fixture - Wikipedia</title><main>${text.map((p) => `<p>${p}</p>`).join('')}</main></html>`,
        url,
        '2026-11-12T00:00:00.000Z',
      );

    beforeAll(async () => {
      for (const planPage of new Set(Object.values(RECIPES).flatMap((recipe) => recipe.pages)))
        await sql`insert into content.topic_seed_sources (page_url, host, outcome) values (${planPage}, ${new URL(planPage).hostname}, 'read')
          on conflict do nothing`.execute(db());
      const key = 'gen-orrin-seed-source-00000001';
      await db()
        .insertInto('content.recipes')
        .values({
          key,
          origin: 'proposal',
          status: 'checked',
          title: 'CI fixture recipe about the Orrin seed source',
          topic_id: 'earth.tides',
          facet_id: 'earth.tides.forcing',
          asset_id: stableUuid(`content.recipe-asset:${key}`),
          explanation_unit_id: `${key}-v1`,
          brief:
            'Explain how the invented moon Orrin raises two bulges in its seas and why they follow it round. Ask only for what the pages say about the bulges and their timing. Do not claim the sea is pulled flat.',
          // One address longer than the candidates table holds: a source that can never be recorded is not one.
          pages: [SOURCE, `https://en.wikipedia.org/wiki/${'Long'.repeat(100)}`],
          proposing_run_id: randomUUID(),
        })
        .execute();
    });

    it('is skipped, not stored and not allowed to stop the pass: an address the table cannot hold, a source that cannot be a source, a page that will not store', async () => {
      const filler = ORRIN.map((text, n) => `${text} Fixture ${String(n)}.`);
      const overlong = `https://en.wikipedia.org/wiki/${'x'.repeat(400)}`;
      const good = [wiki('Orrin_good_a'), wiki('Orrin_good_b'), wiki('Orrin_good_c')];
      const read: ReadResearchPage = (url) => {
        if (url === SOURCE)
          // The reader would drop the overlong link; a reader that did not must not be able to wedge the step.
          return Promise.resolve({ page: page(url, filler), links: [overlong, ...good] });
        if (url === good[0])
          // Fifty thousand characters of passages: the table refuses a page this large, and the candidate is rejected, not retried for ever.
          return Promise.resolve({
            page: {
              ...page(url, filler),
              passages: Array.from({ length: 50 }, (_, n) => ({
                id: `p-${String(n)}`,
                text: `Passage ${String(n)}. ${'Long words go here. '.repeat(50)}`,
              })),
            },
            links: [],
          });
        return Promise.resolve({ page: page(url, filler), links: [] });
      };
      const result = await makeSeedTopicCandidates({ db: db(), read })(signal());
      expect(result).toMatchObject({ sourcesRead: 1, found: 3, evaluated: 3, eligible: 2, rejected: 1 });
      expect((await readCandidate(db(), overlong)) === undefined).toBe(true);
      expect(await readCandidate(db(), good[0]!)).toMatchObject({ status: 'rejected', verdict: 'seed_failed' });
      expect(await statusOf(good[1]!)).toBe('eligible');
      expect(await statusOf(good[2]!)).toBe('eligible');
      // The source is recorded as read, and the one with the overlong address was never one: nothing is read twice, nothing throws.
      expect(
        (
          await db()
            .selectFrom('content.topic_seed_sources')
            .select('outcome')
            .where('page_url', '=', SOURCE)
            .executeTakeFirstOrThrow()
        ).outcome,
      ).toBe('read');
      expect(await makeSeedTopicCandidates({ db: db(), read })(signal())).toEqual(NO_SEED);
    });
  });

  describe('the owner approves each topic that grew', () => {
    useDatabase('topic_review_owner');
    const url = wiki('Orrin_owner');
    const TOPIC = 'earth.orrin-owner';

    it('lists the topic’s label, meaning and facets for the operator to read, with its decision pending and the topic waiting', async () => {
      await eligible(url, 'Orrin owner');
      const { propose } = build(() => proposal('Orrin owner'));
      expect(await propose({ pageUrl: url, dryRun: false }, signal())).toMatchObject({
        kind: 'admitted',
        topicId: TOPIC,
      });
      const [row] = await reviewCandidates(db(), { status: 'admitted' });
      expect(row).toMatchObject({
        pageUrl: url,
        topicId: TOPIC,
        approval: 'pending',
        topic: {
          label: 'Orrin owner',
          meaning: 'How the two small seas of the invented moon Orrin rise and fall under the pull of their planet.',
          servable: false,
          facets: [
            { label: 'Daily rhythm', meaning: 'How often the seas of a moon rise and fall in one day of the moon.' },
            { label: 'Narrow bays', meaning: 'Why the water of a sea climbs higher where a bay narrows.' },
            {
              label: 'Reading the water',
              meaning: 'How people who live by a sea learn to read its high and low waters.',
            },
          ],
        },
      });
      // A candidate that made no topic shows no topic text, and never the page's own text or title.
      const everything = await reviewCandidates(db(), {});
      expect(
        everything.filter((candidate) => candidate.topic === undefined).every((candidate) => !('title' in candidate)),
      ).toBe(true);
      expect(await catalogueStatus(db())).toMatchObject({ awaitingApproval: expect.any(Number) as number });
      expect((await catalogueStatus(db())).awaitingApproval).toBeGreaterThanOrEqual(1);
    });

    it('is never made servable before the owner has approved it, by the step that shows topics or by a release of any kind', async () => {
      // (The test of the whole path, three released explanations and all, is in topic-growth.test.ts.)
      const releaseBefore = (await live().current()).releaseId;
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      expect(await appendRelease(db(), [{ kind: 'show', nodeId: TOPIC }], 'operator')).toEqual({
        kind: 'refused',
        refusals: [{ code: 'not_approved', nodeId: TOPIC }],
      });
      // SQL itself holds the owner's decision to a topic that was made: a candidate that made none cannot be approved, whoever writes the row.
      await expect(
        sql`insert into content.topic_candidates (page_url, host, status, approval, decided_by, decided_at, passages, policy_version)
          values (${wiki('Orrin_sql')}, 'en.wikipedia.org', 'eligible', 'approved', 'cli:ci', now(), '[]'::jsonb, 'topic-growth.v1')`.execute(
          db(),
        ),
      ).rejects.toBeDefined();
      expect((await live().current()).releaseId).toBe(releaseBefore);
      expect((await live().current()).concept(TOPIC)).toMatchObject({ servable: false });
    });

    it('is retired when rejected, once, and the decision is never taken back; a topic of the plan has none to make', async () => {
      expect(
        await decideTopic(db(), { topicId: 'earth.tides', decision: 'reject', decidedBy: 'cli:ci-owner' }),
      ).toEqual({ kind: 'not_grown' });
      expect(
        await decideTopic(db(), { topicId: 'earth.nothing', decision: 'approve', decidedBy: 'cli:ci-owner' }),
      ).toEqual({ kind: 'not_grown' });
      expect(await decideTopic(db(), { topicId: TOPIC, decision: 'reject', decidedBy: 'cli:ci-owner' })).toEqual({
        kind: 'rejected',
        retired: true,
      });
      const catalogue = await live().current();
      expect(catalogue.concept(TOPIC)).toMatchObject({ retired: true, servable: false });
      expect(catalogue.allTopics().some((topic) => topic.id === TOPIC)).toBe(false);
      expect(await decideTopic(db(), { topicId: TOPIC, decision: 'approve', decidedBy: 'cli:ci-owner' })).toEqual({
        kind: 'already_decided',
        approval: 'rejected',
      });
      expect(await decideTopic(db(), { topicId: TOPIC, decision: 'reject', decidedBy: 'cli:ci-owner' })).toEqual({
        kind: 'already_decided',
        approval: 'rejected',
      });
      const row = await db()
        .selectFrom('content.topic_candidates')
        .select(['approval', 'decided_by', 'decided_at'])
        .where('topic_id', '=', TOPIC)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ approval: 'rejected', decided_by: 'cli:ci-owner' });
      expect(row.decided_at).toBeInstanceOf(Date);
      // Its id is never reused: the name is taken for good.
      expect(await readCandidate(db(), url)).toMatchObject({ approval: 'rejected', topicId: TOPIC });
    });

    it('is approved once, with who decided and when, and is then servable only with its supply', async () => {
      const other = wiki('Orrin_approved');
      await eligible(other, 'Orrin approved');
      const { propose } = build(() => proposal('Orrin approved'));
      expect(await propose({ pageUrl: other, dryRun: false }, signal())).toMatchObject({ kind: 'admitted' });
      // No supply yet: approved, and still waiting.
      expect(
        await decideTopic(db(), { topicId: 'earth.orrin-approved', decision: 'approve', decidedBy: 'cli:ci-owner' }),
      ).toEqual({
        kind: 'approved',
        servable: false,
      });
      expect(
        await decideTopic(db(), { topicId: 'earth.orrin-approved', decision: 'reject', decidedBy: 'cli:ci-owner' }),
      ).toEqual({
        kind: 'already_decided',
        approval: 'approved',
      });
      expect((await live().current()).concept('earth.orrin-approved')).toMatchObject({
        servable: false,
        retired: false,
      });
      expect(await readCandidate(db(), other)).toMatchObject({ approval: 'approved' });
    });
  });
});
