import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeWithPersonalScope,
  makeWithProductionScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import type { WithProductionScope } from '@knowscroll/backend/reasoning';
import { shortlistTopics } from '@knowscroll/backend/modules/content';
import {
  catalogueStatus,
  fetchResearchWithLinks,
  makeCatalogue,
  makeGrowTopics,
  makeProposeRecipes,
  makeProposeTopic,
  makeReviewGate,
  makeSeedTopicCandidates,
  previewRecipeProposal,
  previewTopicProposal,
  readReleasedCoverage,
  readRecipeStates,
  showServableTopics,
  topicGrowthLock,
  readCandidate,
  readDiscoveryCandidates,
  listCandidates,
  type ProposeTopicResult,
} from '@knowscroll/backend/modules/content/nest-providers';
import { catalogueTopics, gapScanStore, makeScanGaps } from '@knowscroll/backend/modules/supply/nest-providers';
import type { ResearchNetwork } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { stableUuid } from '../../../packages/backend/src/infrastructure/ids/index.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { seedPerson } from '../support/fixtures.js';
import { answerWith, enableProductionScope, fixtureProduction } from '../support/generated-scroll.js';
import { orrinResearchFor, plainOrrin, v2Capabilities } from '../support/scroll-v2.js';
import { authoredWorld, geographyReader, seedAuthoredGeography } from '../support/visit-world.js';

/**
 * Topic growth (#674, slice 3.4, D-422) on a real PostgreSQL and pg-boss: candidates found by code from the links of research pages already
 * accepted for recipes, a place proposed by the model, admitted by code through the catalogue's own admission, invisible until the library has
 * released supply for it. The model is a labelled CI fixture, and every page is an authored fixture about an invented moon: nothing here is
 * provider output, a real page or product data. No request leaves the process: the research network is a fixture too.
 */

const NOW = new Date('2026-11-12T00:00:00.000Z');
const wiki = (title: string) => `https://en.wikipedia.org/wiki/${title}`;
const SOURCE = wiki('Orrin_moon');
const OWN = wiki('Orrin_tides');
const SEAS = wiki('Orrin_seas');
const ALIAS = wiki('Orrin_sea_level');
const PEBBLE = wiki('Orrin_pebble');
const MAYBE = wiki('Orrin_may_mean');
const DUPLICATE = wiki('Tide');

/** Ten invented paragraphs about the sea of the moon Orrin: each is its own passage, and each quote below is a stretch of one. */
const ORRIN = [
  'The moon Orrin is a small invented world whose two shallow seas rise and fall twice during each lunar day because of the pull of its giant planet.',
  'Because the planet holds one face of Orrin turned toward it, the near sea is pulled into a deep bulge while the far sea is left behind.',
  'Sailors of Orrin learned to read the two high waters and the two low waters, and they kept a calendar of fishing and trade by them.',
  'In a narrow bay on Orrin the incoming water is squeezed into a smaller space, so the sea climbs much higher there than on an open shore.',
  'When the second moon lines up with the first at the new moon, the two pulls add together and the seas of Orrin reach their highest range of the month.',
  'The first charts of the Orrin seas were drawn by pilots who measured the depth of every channel with weighted lines over many seasons.',
  'Scholars of Orrin later explained the two bulges with a law of attraction that grows weaker with distance, and they tested it against the pilots tables.',
  'Today the people of Orrin build small mills in the narrowest bays, where the strong flow of the tide can turn a wheel twice a day.',
  'A long shallow shelf along the south coast of Orrin slows the tide, so the high water there arrives hours after it does on the north coast.',
  'The seas of Orrin never freeze, because the daily flow of water keeps the surface moving even in the coldest months of the long year.',
] as const;
const QUOTES = [
  'two shallow seas rise and fall twice during each lunar day because of the pull of its giant planet',
  'In a narrow bay on Orrin the incoming water is squeezed into a smaller space, so the sea climbs much higher there',
  'Sailors of Orrin learned to read the two high waters and the two low waters, and they kept a calendar of fishing and trade by them',
  'A long shallow shelf along the south coast of Orrin slows the tide, so the high water there arrives hours after it does on the north coast',
] as const;

const articleHtml = (title: string, paragraphs: readonly string[]) =>
  `<html><title>${title} - Wikipedia</title><main>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</main></html>`;
const filler = (title: string, count: number) =>
  Array.from(
    { length: count },
    (_, n) =>
      `Fixture paragraph ${String(n + 1)} of ${title} states one invented fact about the moon Orrin and its seas.`,
  );

/** The research network of the fixture: pages by address, redirects, and a record of every address that was read. */
function fixtureNetwork() {
  const served = new Map<string, string>();
  const redirects = new Map<string, string>();
  const fetched: string[] = [];
  const network: ResearchNetwork = {
    addresses: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
    read: (url) => {
      fetched.push(url.href);
      const to = redirects.get(url.href);
      if (to !== undefined) return Promise.resolve({ status: 301, headers: { location: to }, body: '' });
      const body = served.get(url.href);
      return Promise.resolve(
        body === undefined
          ? { status: 404, headers: { 'content-type': 'text/html' }, body: '' }
          : { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body },
      );
    },
  };
  const read = (url: string) => fetchResearchWithLinks(url, network, () => NOW);
  return { served, redirects, fetched, network, read };
}

/** The pages of a world: a source page accepted for a recipe, and what it links to. */
function serveWorld(net: ReturnType<typeof fixtureNetwork>, source = SOURCE) {
  const links = (hrefs: readonly string[]) => hrefs.map((href) => `<a href="${href}">link</a>`).join(' ');
  net.served.set(
    source,
    articleHtml('Orrin moon', [
      `The invented moon Orrin has two seas and a small second moon, and it is described in the pages it links to. ${links(
        ['/wiki/Orrin_seas', '/wiki/Orrin_seas#Tides', '/wiki/Orrin_sea_level'],
      )}`,
      `Its smallest stones are described apart, and the name Orrin has more than one meaning. ${links([
        '/wiki/Orrin_pebble',
        '/wiki/Orrin_may_mean',
        '/wiki/Tide',
      ])}`,
      `Lists and families of pages are kept elsewhere, and so is the page of its own tides. ${links([
        '/wiki/List_of_Orrin_seas',
        '/wiki/Orrin_(disambiguation)',
        '/wiki/Orrin_tides',
        'https://example.com/orrin',
        '/wiki/Category:Orrin',
        source.replace('https://en.wikipedia.org', ''),
      ])}`,
      ...filler('Orrin moon', 4),
    ]),
  );
  net.served.set(SEAS, articleHtml('Orrin seas', ORRIN));
  net.redirects.set(ALIAS, SEAS);
  net.served.set(PEBBLE, articleHtml('Orrin pebble', filler('Orrin pebble', 5)));
  net.served.set(
    MAYBE,
    articleHtml('Orrin may mean', [
      'Orrin may refer to several invented places on the moon, and it is also the name of one small sea there.',
      ...filler('Orrin may mean', 11),
    ]),
  );
  net.served.set(DUPLICATE, articleHtml('Tide', filler('Tide', 12)));
}

describe('Topic growth (labelled CI fixtures, real PostgreSQL and pg-boss)', () => {
  let database: TestDatabase<Database>;
  const db = () => database.db;
  const live = () => makeCatalogue(db(), { revalidateMs: 0, background: false });
  const net = fixtureNetwork();
  let calls: () => number;
  let script: (sequence: number) => FixtureScenario;
  let propose: ReturnType<typeof makeProposeTopic>;

  /** The proposal role's own harness over the test database, with a labelled fixture model carrying a MiniMax identity. */
  function proposing(
    options: {
      readonly day?: number;
      readonly maxPerSystem?: number;
      readonly storeScope?: WithProductionScope;
      /** Whether the harness's own production scope is on (default). Off, the harness refuses before it sends anything. */
      readonly harnessScope?: boolean;
    } = {},
  ) {
    const fixture = fixtureModel((sequence) => script(sequence), { label: 'topic-proposal-CI-fixture' });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    const production = makeWithProductionScope(db(), { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: db(),
        withProductionScope:
          options.harnessScope === false
            ? makeWithProductionScope(db(), { enabled: false, lockTimeoutMs: 5000 })
            : production,
        enabled: options.harnessScope !== false,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    calls = () => fixture.calls.length;
    propose = makeProposeTopic({
      db: db(),
      authority: { scopeId: 'scroll-supply', generation: 1 },
      // A scope that refuses stands for a crash between the answer and the storing: the answer is kept and nothing is stored.
      withScope: options.storeScope ?? production,
      harness,
      maxTopicsPerSystem: options.maxPerSystem ?? 12,
      // A request is the same request on the same UTC day: each test that is not about a redelivery asks on a day of its own.
      now: () => new Date(Date.UTC(2026, 10, 1 + (options.day ?? 0), 12)),
    });
    return harness;
  }

  const proposal = (
    label: string,
    overrides: Partial<{ systemId: string; meaning: string; quotes: readonly string[] }> = {},
  ) =>
    answerWith({
      topics: [
        {
          systemId: overrides.systemId ?? 'earth',
          label,
          meaning:
            overrides.meaning ??
            'How the two small seas of the invented moon Orrin rise and fall under the pull of their planet.',
          facets: [
            {
              label: 'Daily rhythm',
              meaning: 'How often the seas of a moon rise and fall in one day of the moon.',
              quote: (overrides.quotes ?? QUOTES)[0],
            },
            {
              label: 'Narrow bays',
              meaning: 'Why the water of a sea climbs higher where a bay narrows.',
              quote: (overrides.quotes ?? QUOTES)[1],
            },
            {
              label: 'Reading the water',
              meaning: 'How people who live by a sea learn to read its high and low waters.',
              quote: (overrides.quotes ?? QUOTES)[2],
            },
          ],
        },
      ],
    });

  /** An eligible candidate stored directly, for the tests that are about proposing and not about seeding. */
  async function eligible(url: string, title = 'Orrin seas', passages: readonly string[] = ORRIN) {
    await db()
      .insertInto('content.topic_candidates')
      .values({
        page_url: url,
        host: new URL(url).hostname,
        source_url: SOURCE,
        status: 'eligible',
        title,
        passages: JSON.stringify(passages),
        passage_count: passages.length,
        policy_version: 'topic-growth.v1',
      })
      .execute();
    return url;
  }
  const releaseId = async () => (await live().current()).releaseId;
  const runsOf = async (url: string) =>
    (
      await sql<{
        run_id: string;
        state: string;
        outcome: string | null;
        retry: number;
      }>`select run_id, state, outcome, retry
        from content.topic_proposals where page_url = ${url} order by created_at`.execute(db())
    ).rows;
  const attemptsOf = async (runId: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*) as n from reasoning.production_attempts where run_id = ${runId}::uuid`.execute(db())
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    database = await createTestDatabase<Database>('topic_growth');
    await enableProductionScope(db());
    // The plan's own recipes' pages are read already: this world's only unread source is the one the fixture serves.
    for (const page of new Set(Object.values(RECIPES).flatMap((recipe) => recipe.pages)))
      await sql`insert into content.topic_seed_sources (page_url, host, outcome) values (${page}, ${new URL(page).hostname}, 'read')
        on conflict do nothing`.execute(db());
    // A recipe of the tides planet that the library has accepted: its page is where candidates come from.
    const key = 'gen-orrin-source-00000001';
    await db()
      .insertInto('content.recipes')
      .values({
        key,
        origin: 'proposal',
        status: 'checked',
        title: 'CI fixture recipe about the Orrin moon',
        topic_id: 'earth.tides',
        facet_id: 'earth.tides.forcing',
        asset_id: stableUuid(`content.recipe-asset:${key}`),
        explanation_unit_id: `${key}-v1`,
        brief:
          'Explain how the invented moon Orrin raises two bulges in its seas and why they follow it round. Ask only for what the pages say about the bulges and their timing. Do not claim the sea is pulled flat.',
        pages: [SOURCE, `${OWN}/`],
        proposing_run_id: randomUUID(),
      })
      .execute();
    serveWorld(net);
  });
  afterAll(async () => {
    await database.drop();
  });

  describe('seeding: candidates by code only', () => {
    it('reads the links of a research page already accepted for a recipe, once, and keeps each page code finds with a verdict', async () => {
      const seed = makeSeedTopicCandidates({ db: db(), read: net.read });
      const first = await seed(signal());
      // The stored recipe has two pages: the fixture serves one, and the other (written with a trailing slash, which a link does not have) is recorded once as a source that could not be read.
      expect(first).toMatchObject({ sourcesRead: 2, found: 5, evaluated: 5, eligible: 1, rejected: 4, deferred: 0 });
      const rows = await db()
        .selectFrom('content.topic_candidates')
        .select(['page_url', 'host', 'source_url', 'status', 'verdict', 'passage_count'])
        .orderBy('page_url')
        .execute();
      expect(rows.map((row) => [row.page_url, row.status, row.verdict])).toEqual([
        [MAYBE, 'rejected', 'disambiguation'],
        [PEBBLE, 'rejected', 'stub'],
        [ALIAS, 'rejected', 'duplicate_page'],
        [SEAS, 'eligible', 'ok'],
        [DUPLICATE, 'rejected', 'duplicate_topic'],
      ]);
      // Public pages of a reviewed host, found from the source and no one else's; nothing names a person.
      expect(new Set(rows.map((row) => row.host))).toEqual(new Set(['en.wikipedia.org']));
      expect(new Set(rows.map((row) => row.source_url))).toEqual(new Set([SOURCE]));
      expect(rows.find((row) => row.page_url === SEAS)!.passage_count).toBe(10);
      // The source itself, a recipe's own page, a list, a disambiguation, a category, another host and a repeat of one page are not candidates.
      const known = new Set(rows.map((row) => row.page_url));
      for (const page of [
        SOURCE,
        OWN,
        wiki('List_of_Orrin_seas'),
        wiki('Orrin_(disambiguation)'),
        wiki('Category:Orrin'),
      ])
        expect(known.has(page)).toBe(false);
      expect(net.fetched).not.toContain('https://example.com/orrin');
      expect(net.fetched.filter((url) => url === SOURCE)).toHaveLength(1);
      const read = await db()
        .selectFrom('content.topic_seed_sources')
        .selectAll()
        .where('page_url', '=', SOURCE)
        .execute();
      expect(read).toMatchObject([{ outcome: 'read', links: 8, candidates: 5 }]);
      expect(
        await db()
          .selectFrom('content.topic_seed_sources')
          .select('outcome')
          .where('page_url', '=', `${OWN}/`)
          .execute(),
      ).toEqual([{ outcome: 'http_refused' }]);
    });

    it('reads nothing twice: a source page and a candidate are each read once', async () => {
      const before = net.fetched.length;
      const again = await makeSeedTopicCandidates({ db: db(), read: net.read })(signal());
      expect(again).toEqual({ sourcesRead: 0, found: 0, evaluated: 0, eligible: 0, rejected: 0, deferred: 0 });
      expect(net.fetched.length).toBe(before);
    });

    it('reads a source again after a day only if it met a failure that may pass, never one that was read', async () => {
      await sql`update content.topic_seed_sources set read_at = now() - interval '2 days' where page_url in (${SOURCE}, ${`${OWN}/`})`.execute(
        db(),
      );
      const before = net.fetched.length;
      const again = await makeSeedTopicCandidates({ db: db(), read: net.read })(signal());
      expect(again).toMatchObject({ sourcesRead: 1, found: 0, evaluated: 0 });
      // The page the host answered with a refusal is asked for again; the page that was read is not.
      expect(net.fetched.slice(before)).toEqual([`${OWN}/`]);
      const rows = await db().selectFrom('content.topic_seed_sources').select(['page_url', 'outcome']).execute();
      expect(rows.filter((row) => row.page_url === SOURCE || row.page_url === `${OWN}/`)).toEqual(
        expect.arrayContaining([
          { page_url: SOURCE, outcome: 'read' },
          { page_url: `${OWN}/`, outcome: 'http_refused' },
        ]),
      );
      // Asked for again, it is not asked for a third time the same day.
      expect(await makeSeedTopicCandidates({ db: db(), read: net.read })(signal())).toMatchObject({ sourcesRead: 0 });
    });

    it('lists the candidates for the operator with codes and counts, and never a page’s text or a title', async () => {
      const listing = await listCandidates(db(), { status: 'eligible' });
      expect(listing).toMatchObject([
        { pageUrl: SEAS, host: 'en.wikipedia.org', status: 'eligible', verdict: 'ok', passages: 10 },
      ]);
      expect(JSON.stringify(listing)).not.toContain('Orrin seas');
      expect(JSON.stringify(listing)).not.toContain('invented');
    });

    it('rejects a page that cannot be read with the code of the fetch, and counts a read that may pass until it is given up on', async () => {
      const missing = wiki('Orrin_missing');
      const flaky = wiki('Orrin_flaky');
      await sql`insert into content.topic_candidates (page_url, host, source_url, policy_version)
        values (${missing}, 'en.wikipedia.org', ${SOURCE}, 'topic-growth.v1'), (${flaky}, 'en.wikipedia.org', ${SOURCE}, 'topic-growth.v1')`.execute(
        db(),
      );
      const failing = fixtureNetwork();
      failing.served.set(missing, '<html><title>Page not found</title><main><p>Gone.</p></main></html>');
      const network: ResearchNetwork = {
        addresses: failing.network.addresses,
        read: (url, address) =>
          url.href === flaky ? Promise.reject(new Error('socket hang up')) : failing.network.read(url, address),
      };
      const read = (url: string) => fetchResearchWithLinks(url, network, () => NOW);
      const outcomes: string[] = [];
      for (let pass = 0; pass < 3; pass += 1) {
        const result = await makeSeedTopicCandidates({ db: db(), read })(signal());
        outcomes.push(`${String(result.deferred)}/${String(result.rejected)}`);
      }
      // A page that refuses is rejected with the fetch's code at once. A read the network failed is counted, and the third failed read gives the page up.
      expect(outcomes).toEqual(['1/1', '1/0', '0/1']);
      expect(await readCandidate(db(), missing)).toMatchObject({ status: 'rejected', verdict: 'page_soft_404' });
      expect(await readCandidate(db(), flaky)).toMatchObject({ status: 'rejected', verdict: 'page_unreachable' });
      await sql`delete from content.topic_candidates where page_url in (${missing}, ${flaky})`.execute(db());
    });
  });

  describe('proposing and admitting', () => {
    let person: Awaited<ReturnType<typeof seedPerson>>;
    let placesBefore: unknown;
    const withScope = () => makeWithPersonalScope(db(), { lockTimeoutMs: 5000 });

    beforeAll(async () => {
      person = await seedPerson(db());
      await seedAuthoredGeography(db(), person, authoredWorld);
      const read = await withScope()(person.authority, (scope) => geographyReader(db())(scope));
      placesBefore = read.kind === 'entered' ? read.value : undefined;
    });

    it('places the page as a topic under the system the model named, in a release of the catalogue that is not servable, ids made by code', async () => {
      script = () => proposal('Orrin seas');
      proposing({ day: 0 });
      expect(await previewTopicProposal(db(), { pageUrl: SEAS }, 12)).toMatchObject({
        kind: 'dry_run',
        passages: 10,
        systemsOffered: 6,
        requestBound: 2,
      });
      expect(calls()).toBe(0);
      const result = await propose({ pageUrl: SEAS, dryRun: false }, signal());
      expect(result).toMatchObject({
        kind: 'admitted',
        topicId: 'earth.orrin-seas',
        facets: 3,
        releaseId: 2,
        repaired: false,
        requestBound: 2,
      });
      expect(calls()).toBe(1);
      const catalogue = await live().current();
      expect(catalogue.releaseId).toBe(2);
      expect(catalogue.concept('earth.orrin-seas')).toMatchObject({
        kind: 'topic',
        parent: 'earth',
        label: 'Orrin seas',
        servable: false,
        introducedIn: 2,
        sceneFamily: null,
      });
      expect(catalogue.concept('earth.orrin-seas')!.facets.map((facet) => facet.id)).toEqual([
        'earth.orrin-seas.daily-rhythm',
        'earth.orrin-seas.narrow-bays',
        'earth.orrin-seas.reading-the-water',
      ]);
      const release = await db()
        .selectFrom('content.concept_releases')
        .select(['source', 'summary'])
        .where('release_id', '=', 2)
        .executeTakeFirstOrThrow();
      expect(release).toMatchObject({ source: 'growth', summary: { addedTopics: 1, addedFacets: 3, shown: 0 } });
      // The candidate is the topic's origin; the run is settled; the role ran on the production harness under its own name.
      expect(await readCandidate(db(), SEAS)).toMatchObject({ status: 'admitted', topicId: 'earth.orrin-seas' });
      const [run] = await runsOf(SEAS);
      expect(run).toMatchObject({ state: 'completed', outcome: 'admitted', retry: 0 });
      const ledger = await sql<{
        role_id: string;
        purpose: string;
        owner_module: string;
        state: string;
      }>`select role_id, purpose,
        owner_module, state from reasoning.production_runs where id = ${run!.run_id}::uuid`.execute(db());
      expect(ledger.rows).toEqual([
        { role_id: 'content.topic-proposal', purpose: 'topic-proposal', owner_module: 'content', state: 'completed' },
      ]);
      expect(await attemptsOf(run!.run_id)).toBe(1);
    });

    it('is invisible until it can form a planet: not listed, not shortlisted, no room, no place on a person’s map, nothing to be served', async () => {
      const catalogue = await live().current();
      expect(catalogue.topics().some((topic) => topic.id === 'earth.orrin-seas')).toBe(false);
      expect(catalogue.children('earth').some((topic) => topic.id === 'earth.orrin-seas')).toBe(false);
      expect(catalogue.allTopics().some((topic) => topic.id === 'earth.orrin-seas')).toBe(true);
      expect(
        shortlistTopics(catalogue, 'orrin seas rise and fall twice a day').some(
          (topic) => topic.id === 'earth.orrin-seas',
        ),
      ).toBe(false);
      expect(await catalogueStatus(db())).toMatchObject({ topics: 18, servableTopics: 17, waitingTopics: 1 });
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      // A person's places read exactly as before the release, and nothing of the new topic is on the map.
      const read = await withScope()(person.authority, (scope) => geographyReader(db())(scope));
      expect(read.kind === 'entered' ? read.value : undefined).toEqual(placesBefore);
      expect(JSON.stringify(placesBefore)).not.toContain('orrin');
      // No Scroll is held, released or even recipe-bound for it yet: discovery has nothing to offer for it.
      const topicAssets = await db()
        .selectFrom('content.encounter_topics')
        .select('asset_id')
        .where('topic_id', '=', 'earth.orrin-seas')
        .execute();
      expect(topicAssets).toEqual([]);
      expect((await readReleasedCoverage(db())).planets.map((planet) => planet.topicId)).not.toContain(
        'earth.orrin-seas',
      );
    });

    it('does not pay twice for a redelivery: the run is answered from what it decided, and nothing is sent', async () => {
      script = () => proposal('Orrin seas again');
      proposing({ day: 0 });
      const [run] = await runsOf(SEAS);
      expect(await propose({ pageUrl: SEAS, dryRun: false }, signal())).toMatchObject({
        kind: 'refused',
        reason: 'not_open',
        status: 'admitted',
      });
      expect(calls()).toBe(0);
      expect(await attemptsOf(run!.run_id)).toBe(1);
      expect(await releaseId()).toBe(2);
    });

    it('is answered from the ledger when the answer was kept and the store never happened: the redelivery admits it with no second paid call', async () => {
      const url = await eligible(wiki('Orrin_crash'), 'Orrin crash');
      const refusingScope: WithProductionScope = () =>
        Promise.resolve({ kind: 'refused', refusal: { kind: 'production_disabled' } });
      script = () =>
        proposal('Orrin bays', {
          meaning: 'How the narrow bays of the invented moon Orrin squeeze the incoming water of its seas.',
        });
      proposing({ day: 1, storeScope: refusingScope });
      expect(await propose({ pageUrl: url, dryRun: false }, signal())).toMatchObject({
        kind: 'failed',
        code: 'scope_refused',
        closed: false,
      });
      expect(calls()).toBe(1);
      // The candidate is mid-flight with its day pinned, and nothing was released.
      expect(await readCandidate(db(), url)).toMatchObject({ status: 'proposed', attemptDay: '2026-11-02' });
      expect(await releaseId()).toBe(2);
      // Another process, a later day, a model that would answer differently and fail: nothing is sent, the kept answer is what is stored.
      script = () => ({ kind: 'not_connected' });
      proposing({ day: 5 });
      const redelivered = await propose({ pageUrl: url, dryRun: false }, signal());
      expect(redelivered).toMatchObject({ kind: 'admitted', topicId: 'earth.orrin-bays', releaseId: 3 });
      expect(calls()).toBe(0);
      const [run] = await runsOf(url);
      expect(run).toMatchObject({ state: 'completed', outcome: 'admitted', retry: 0 });
      expect(await attemptsOf(run!.run_id)).toBe(1);
      expect((await live().current()).concept('earth.orrin-bays')).toMatchObject({ servable: false });
    });

    it('refuses a proposal by code and releases nothing: a system it was not offered, a quote the page does not hold, a name that is taken, an address', async () => {
      const cases: readonly {
        readonly name: string;
        readonly answer: FixtureScenario;
        readonly code: string;
        readonly maxPerSystem?: number;
      }[] = [
        {
          name: 'not_offered',
          answer: proposal('Orrin sky', { systemId: 'earth' }),
          code: 'system_not_offered',
          maxPerSystem: 3,
        },
        { name: 'unknown', answer: proposal('Orrin sky', { systemId: 'oceans' }), code: 'system_unknown' },
        {
          name: 'quote',
          answer: proposal('Orrin sky', {
            quotes: [QUOTES[0], 'The moon Orrin is made entirely of invented cheese and nothing else.', QUOTES[2]],
          }),
          code: 'quote_not_in_page',
        },
        { name: 'taken', answer: proposal('Tides'), code: 'id_collision' },
        { name: 'again', answer: proposal('The tide'), code: 'duplicate_topic' },
        {
          name: 'address',
          answer: proposal('Orrin sky', {
            meaning: 'See https://example.org/orrin for how the sky of a small moon behaves.',
          }),
          code: 'text_has_address',
        },
        // The catalogue's own admission, which code runs after its own checks: a line break in a meaning is not one it accepts.
        {
          name: 'catalogue',
          answer: proposal('Orrin sky', {
            meaning: 'How the sky of the invented moon Orrin\nlooks from its two small seas.',
          }),
          code: 'catalogue_meaning_text',
        },
        { name: 'declined', answer: answerWith({ topics: [] }), code: 'declined' },
      ];
      for (const [at, entry] of cases.entries()) {
        const url = await eligible(wiki(`Orrin_case_${entry.name}`), 'Orrin case');
        script = () => entry.answer;
        proposing({ day: 10 + at, ...(entry.maxPerSystem === undefined ? {} : { maxPerSystem: entry.maxPerSystem }) });
        const before = await releaseId();
        const result = await propose({ pageUrl: url, dryRun: false }, signal());
        expect(result, entry.name).toMatchObject({ kind: 'not_admitted', code: entry.code });
        expect(await releaseId(), entry.name).toBe(before);
        expect(await readCandidate(db(), url), entry.name).toMatchObject({ status: 'refused', verdict: entry.code });
        // A refused candidate keeps nothing of the page, and is not asked about again.
        expect((await readCandidate(db(), url))!.passages, entry.name).toBeUndefined();
        expect(await propose({ pageUrl: url, dryRun: false }, signal()), entry.name).toMatchObject({
          kind: 'refused',
          reason: 'not_open',
          status: 'refused',
        });
        expect(calls(), entry.name).toBe(1);
      }
    });

    it('sends one repair for an answer of the wrong shape, and refuses the candidate by code only when the repair is not valid either: a conclusive failure is counted', async () => {
      const url = await eligible(wiki('Orrin_shape'), 'Orrin shape');
      // Two facets only: the shape wants three to five. The repair is wrong the same way.
      const tooFew = answerWith({
        topics: [
          {
            systemId: 'earth',
            label: 'Orrin shape',
            meaning: 'How the shape of the invented moon Orrin follows from its slow spin.',
            facets: [
              { label: 'Spin', meaning: 'How a moon spins once in its orbit.', quote: QUOTES[0] },
              { label: 'Bulges', meaning: 'Why a moon bulges toward its planet.', quote: QUOTES[1] },
            ],
          },
        ],
      });
      script = () => tooFew;
      proposing({ day: 30 });
      const result = await propose({ pageUrl: url, dryRun: false }, signal());
      expect(result).toMatchObject({ kind: 'failed', code: 'invalid_output', unknown: false, closed: true });
      expect(calls()).toBe(2);
      // Counted as a failed attempt, the day released; the candidate may be asked about once more, on another day.
      expect(await readCandidate(db(), url)).toMatchObject({ status: 'eligible', attempts: 1 });
      expect((await readCandidate(db(), url))!.attemptDay).toBeUndefined();
      // The same day is the same closed run: nothing is sent for it again. A new day is a new request, and a second failure refuses the page.
      script = () => proposal('Orrin shape', { quotes: [QUOTES[0], QUOTES[1], QUOTES[2]] });
      proposing({ day: 30 });
      expect(await propose({ pageUrl: url, dryRun: false }, signal())).toMatchObject({
        kind: 'admitted',
        topicId: 'earth.orrin-shape',
      });
      // That answered; a different candidate fails twice over two days and is refused as model_failed.
      const bad = await eligible(wiki('Orrin_fails'), 'Orrin fails');
      script = () => ({ kind: 'not_connected' });
      proposing({ day: 31 });
      expect(await propose({ pageUrl: bad, dryRun: false }, signal())).toMatchObject({ kind: 'failed', closed: true });
      expect(await readCandidate(db(), bad)).toMatchObject({ status: 'eligible', attempts: 1 });
      proposing({ day: 32 });
      expect(await propose({ pageUrl: bad, dryRun: false }, signal())).toMatchObject({ kind: 'failed', closed: true });
      expect(await readCandidate(db(), bad)).toMatchObject({ status: 'refused', verdict: 'model_failed', attempts: 2 });
      expect((await runsOf(bad)).map((run) => [run.retry, run.state, run.outcome])).toEqual([
        [0, 'failed', 'model_failed'],
        [1, 'failed', 'model_failed'],
      ]);
    });

    it('never resends an attempt of unknown outcome: the candidate is blocked and no later pass or command asks again', async () => {
      const url = await eligible(wiki('Orrin_unknown'), 'Orrin unknown');
      script = () => ({ kind: 'timeout_after_dispatch' });
      proposing({ day: 40 });
      const first = await propose({ pageUrl: url, dryRun: false }, signal());
      expect(first).toMatchObject({ kind: 'failed', unknown: true, closed: false });
      expect(calls()).toBe(1);
      expect(await readCandidate(db(), url)).toMatchObject({ status: 'blocked_unknown', verdict: 'outcome_unknown' });
      const [run] = await runsOf(url);
      expect(run).toMatchObject({ state: 'open', outcome: null });
      // The same request, the next day, another process: refused before anything is sent.
      script = () => proposal('Orrin unknown');
      proposing({ day: 41 });
      expect(await propose({ pageUrl: url, dryRun: false }, signal())).toMatchObject({
        kind: 'refused',
        reason: 'not_open',
        status: 'blocked_unknown',
      });
      expect(calls()).toBe(0);
      expect(await attemptsOf(run!.run_id)).toBe(1);
    });

    it('waits, without blocking the candidate, when the harness refuses before it sends anything, and sends the same request once the cause is gone', async () => {
      const url = await eligible(wiki('Orrin_waits'), 'Orrin waits');
      script = () => proposal('Orrin waits');
      proposing({ day: 45, harnessScope: false });
      const waiting = await propose({ pageUrl: url, dryRun: false }, signal());
      expect(waiting).toMatchObject({ kind: 'paused' });
      expect(calls()).toBe(0);
      expect(await readCandidate(db(), url)).toMatchObject({
        status: 'proposed',
        attemptDay: new Date(Date.UTC(2026, 10, 46, 12)).toISOString().slice(0, 10),
      });
      // The cause is gone: the same request (the same pinned day, whatever day it is now) is sent, once, and admitted.
      proposing({ day: 48 });
      expect(await propose({ pageUrl: url, dryRun: false }, signal())).toMatchObject({
        kind: 'admitted',
        topicId: 'earth.orrin-waits',
      });
      expect(calls()).toBe(1);
      const runs = await runsOf(url);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ state: 'completed', retry: 0 });
    });

    it('refuses a page that is no candidate, and a dry run reads the database only', async () => {
      script = () => proposal('Orrin sky');
      proposing({ day: 50 });
      expect(await propose({ pageUrl: wiki('Not_a_candidate'), dryRun: false }, signal())).toEqual({
        kind: 'refused',
        reason: 'not_a_candidate',
      });
      expect(await propose({ pageUrl: PEBBLE, dryRun: false }, signal())).toEqual({
        kind: 'refused',
        reason: 'not_open',
        status: 'rejected',
      });
      const url = await eligible(wiki('Orrin_dry'), 'Orrin dry');
      expect(await propose({ pageUrl: url, dryRun: true }, signal())).toMatchObject({
        kind: 'dry_run',
        contextItems: expect.any(Number) as number,
      });
      expect(calls()).toBe(0);
      expect(await runsOf(url)).toEqual([]);
      expect(await readCandidate(db(), url)).toMatchObject({ status: 'eligible' });
    });

    it('rejects, for nothing, a candidate that became an existing topic again after it was read', async () => {
      const url = await eligible(wiki('Orrin_late'), 'Orrin seas');
      script = () => proposal('Orrin late');
      proposing({ day: 60 });
      const result: ProposeTopicResult = await propose({ pageUrl: url, dryRun: false }, signal());
      expect(result).toEqual({ kind: 'refused', reason: 'duplicate_topic' });
      expect(calls()).toBe(0);
      expect(await readCandidate(db(), url)).toMatchObject({ status: 'rejected', verdict: 'duplicate_topic' });
    });
  });

  describe('what the gap loop does with it', () => {
    const production = () => fixtureProduction(db(), () => answerWith(plainOrrin()), orrinResearchFor);
    const TOPIC = 'earth.orrin-seas';
    const facets = [
      'earth.orrin-seas.daily-rhythm',
      'earth.orrin-seas.narrow-bays',
      'earth.orrin-seas.daily-rhythm',
    ] as const;
    const BRIEFS = [
      'Explain why the two shallow seas of the invented moon Orrin rise and fall twice during each lunar day. Ask only for what the page says about the pull of the planet and the two bulges. Do not offer any prediction of the tides.',
      'Describe how the water of Orrin climbs highest in narrow bays, where the incoming sea is squeezed into a smaller space. Ask only for what the page says about bays and the height of the water. Do not give any heights or times.',
      'Show how the sailors of Orrin read the high and low waters to keep a calendar of fishing and trade. Ask only for what the page says about the calendar and the pilots. Do not invent any dates or customs.',
    ] as const;

    it('sees it as a thin planet and can propose its first recipes from the page it grew from', async () => {
      const scan = makeScanGaps({
        readCatalogue: async () => catalogueTopics(await live().current()),
        enabled: true,
        depthTarget: 6,
        maxRounds: 3,
        store: gapScanStore(db()),
        readCoverage: () => readReleasedCoverage(db()),
        readRecipeStates: (keys) => readRecipeStates(db(), keys),
        now: () => NOW,
        newId: randomUUID,
      });
      expect(await scan()).toMatchObject({ kind: 'scanned' });
      const gap = await db()
        .selectFrom('supply.gaps')
        .select(['kind', 'planet', 'facet', 'status'])
        .where('planet', '=', TOPIC)
        .execute();
      expect(gap).toEqual([{ kind: 'thin_planet', planet: TOPIC, facet: null, status: 'open' }]);
      // The recipe brief role is asked only from pages code already holds: the page this topic grew from is one.
      expect(await previewRecipeProposal(db(), { topicId: TOPIC })).toMatchObject({
        kind: 'dry_run',
        candidatePages: 1,
      });
      // A topic of the plan that has no recipe produced has no page at all, and is refused before any request: the origin page is what is new.
      expect(await previewRecipeProposal(db(), { topicId: 'history.industrial-revolution' })).toEqual({
        kind: 'refused',
        reason: 'no_candidate_pages',
      });
    });

    it('becomes servable only when the library has released three explanations over two of its facets, in a release of its own', async () => {
      const fixture = fixtureModel(
        () =>
          answerWith({
            drafts: [
              { title: 'Why the seas of Orrin rise twice a day', facetId: facets[0], brief: BRIEFS[0], pages: [SEAS] },
              {
                title: 'How the narrow bays of Orrin lift the water',
                facetId: facets[1],
                brief: BRIEFS[1],
                pages: [SEAS],
              },
              { title: 'How the sailors of Orrin read the water', facetId: facets[2], brief: BRIEFS[2], pages: [SEAS] },
            ],
          }),
        { label: 'recipe-brief-CI-fixture' },
      );
      const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
      const scope = makeWithProductionScope(db(), { enabled: true, lockTimeoutMs: 5000 });
      const proposeRecipes = makeProposeRecipes({
        db: db(),
        authority: { scopeId: 'scroll-supply', generation: 1 },
        withScope: scope,
        harness: makeProductionReasoningHarness(
          postgresProductionHarnessPorts({
            db: db(),
            withProductionScope: scope,
            enabled: true,
            model,
            logEvent: silent,
            settings: fixtureSettings,
          }),
        ),
        now: () => new Date(Date.UTC(2026, 10, 20, 12)),
      });
      const proposed = await proposeRecipes({ topicId: TOPIC, dryRun: false }, signal());
      expect(proposed).toMatchObject({ kind: 'proposed' });
      const keys = (
        await db().selectFrom('content.recipes').select('key').where('topic_id', '=', TOPIC).orderBy('key').execute()
      ).map((row) => row.key);
      expect(keys).toHaveLength(3);
      for (const key of keys)
        expect(
          await production().produce(
            key as Parameters<ReturnType<typeof production>['produce']>[0],
            false,
            signal(),
            true,
            1,
          ),
        ).toMatchObject({
          outcome: 'published',
          held: true,
        });
      // Held for a read: no supply, so the topic still waits, and discovery offers a reader none of the held Scrolls, asked for the topic or not.
      const reader = await seedPerson(db());
      const assets = new Set(keys.map((key) => stableUuid(`content.recipe-asset:${key}`)));
      for (const topicIds of [[TOPIC], undefined]) {
        const read = await makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })(reader.authority, (scope) =>
          readDiscoveryCandidates(scope, {
            languages: ['en'],
            formats: ['scroll'],
            capabilities: v2Capabilities,
            limit: 100,
            ...(topicIds === undefined ? {} : { topicIds }),
          }),
        );
        if (read.kind !== 'entered') throw new Error('CI scope refused');
        expect(read.value.filter((candidate) => assets.has(candidate.assetId))).toEqual([]);
      }
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      const gate = makeReviewGate(db());
      for (const key of keys.slice(0, 2))
        await gate.release({
          assetId: stableUuid(`content.recipe-asset:${key}`),
          revision: 1,
          decidedBy: 'cli:ci-reviewer',
        });
      expect(await showServableTopics(db())).toEqual({ kind: 'unchanged' });
      await gate.release({
        assetId: stableUuid(`content.recipe-asset:${keys[2]}`),
        revision: 1,
        decidedBy: 'cli:ci-reviewer',
      });
      const before = await releaseId();
      expect(await showServableTopics(db())).toMatchObject({
        kind: 'appended',
        releaseId: before + 1,
        summary: { shown: 1 },
      });
      const catalogue = await live().current();
      expect(catalogue.concept(TOPIC)).toMatchObject({ servable: true });
      expect(catalogue.children('earth').map((topic) => topic.id)).toContain(TOPIC);
      expect(catalogue.concept('earth.orrin-bays')).toMatchObject({ servable: false });
    });
  });
});

describe('The scheduled topic growth step (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  const db = () => database.db;
  const live = () => makeCatalogue(db(), { revalidateMs: 0, background: false });
  const net = fixtureNetwork();
  let calls: () => number;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('topic_growth_pass');
    await enableProductionScope(db());
    for (const page of new Set(Object.values(RECIPES).flatMap((recipe) => recipe.pages)))
      await sql`insert into content.topic_seed_sources (page_url, host, outcome) values (${page}, ${new URL(page).hostname}, 'read')
        on conflict do nothing`.execute(db());
    const key = 'gen-orrin-source-00000002';
    await db()
      .insertInto('content.recipes')
      .values({
        key,
        origin: 'proposal',
        status: 'checked',
        title: 'CI fixture recipe about the Orrin moon',
        topic_id: 'earth.tides',
        facet_id: 'earth.tides.forcing',
        asset_id: stableUuid(`content.recipe-asset:${key}`),
        explanation_unit_id: `${key}-v1`,
        brief:
          'Explain how the invented moon Orrin raises two bulges in its seas and why they follow it round. Ask only for what the pages say about the bulges and their timing. Do not claim the sea is pulled flat.',
        pages: [SOURCE, `${OWN}/`],
        proposing_run_id: randomUUID(),
      })
      .execute();
    serveWorld(net);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** One pass of the step, with its ports over this database and the fixture network and model. */
  function pass(
    options: {
      readonly enabled?: boolean;
      readonly cap?: number;
      readonly maxPerSystem?: number;
      readonly script?: (sequence: number) => FixtureScenario;
    } = {},
  ) {
    const fixture = fixtureModel((sequence) => (options.script ?? (() => ({ kind: 'not_connected' })))(sequence), {
      label: 'topic-proposal-CI-fixture',
    });
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
    calls = () => fixture.calls.length;
    // The real clock: the cap counts rows by the database's own clock, which the pass's clock must agree with.
    const now = () => new Date();
    const maxTopicsPerSystem = options.maxPerSystem ?? 12;
    return makeGrowTopics({
      enabled: options.enabled ?? true,
      growthDailyCap: options.cap ?? 10,
      maxTopicsPerSystem,
      db: db(),
      lock: topicGrowthLock(db()),
      seed: makeSeedTopicCandidates({ db: db(), read: net.read }),
      propose: makeProposeTopic({
        db: db(),
        authority: { scopeId: 'scroll-supply', generation: 1 },
        withScope: scope,
        harness,
        maxTopicsPerSystem,
        now,
      }),
      now,
    });
  }
  const rowCount = async (
    table: 'content.topic_candidates' | 'content.topic_proposals' | 'content.topic_seed_sources',
  ) => Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(db())).rows[0]!.n);
  const calm = async () => ({
    candidates: await rowCount('content.topic_candidates'),
    proposals: await rowCount('content.topic_proposals'),
    release: (await live().current()).releaseId,
    fetched: net.fetched.length,
  });

  it('does nothing while it is switched off: no page is read, no model is asked, no row is written, no release is made', async () => {
    const before = await calm();
    const off = pass({ enabled: false, script: () => answerWith({ topics: [] }) });
    expect(await off(signal())).toEqual({ kind: 'disabled' });
    expect(await pass({ cap: 0 })(signal())).toEqual({ kind: 'disabled' });
    expect(calls()).toBe(0);
    expect(await calm()).toEqual(before);
    expect(await rowCount('content.topic_seed_sources')).toBe(
      new Set(Object.values(RECIPES).flatMap((recipe) => recipe.pages)).size,
    );
  });

  it('looks for candidates when few wait, proposes for the oldest eligible one, and admits it as a topic that is not servable', async () => {
    const result = await pass({
      script: () =>
        answerWith({
          topics: [
            {
              systemId: 'earth',
              label: 'Orrin seas',
              meaning:
                'How the two small seas of the invented moon Orrin rise and fall under the pull of their planet.',
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
        }),
    })(signal());
    expect(result).toMatchObject({
      kind: 'done',
      seeded: { sourcesRead: 2, found: 5, eligible: 1, rejected: 4 },
      proposals: ['admitted'],
      paused: false,
    });
    expect(calls()).toBe(1);
    expect((await live().current()).concept('earth.orrin-seas')).toMatchObject({ servable: false });
  });

  it('then has nothing to do: its source was read once, and no candidate is eligible, and a candidate whose attempt is of unknown outcome is never picked', async () => {
    await db()
      .insertInto('content.topic_candidates')
      .values({
        page_url: wiki('Orrin_blocked'),
        host: 'en.wikipedia.org',
        status: 'blocked_unknown',
        verdict: 'outcome_unknown',
        title: 'Orrin blocked',
        passages: JSON.stringify(ORRIN),
        passage_count: 10,
        policy_version: 'topic-growth.v1',
      })
      .execute();
    const before = await calm();
    expect(await pass()(signal())).toMatchObject({ kind: 'done', idle: 'no_candidate', proposals: [], paused: false });
    expect(calls()).toBe(0);
    expect(await calm()).toEqual(before);
  });

  it('keeps within the growth cap: not once today’s runs have reached it, and not while as many topics wait for supply as it allows', async () => {
    await db()
      .insertInto('content.topic_candidates')
      .values({
        page_url: wiki('Orrin_waiting'),
        host: 'en.wikipedia.org',
        status: 'eligible',
        title: 'Orrin waiting',
        passages: JSON.stringify(ORRIN),
        passage_count: 10,
        policy_version: 'topic-growth.v1',
      })
      .execute();
    const before = await calm();
    // One run today and a cap of one.
    expect(await pass({ cap: 1 })(signal())).toMatchObject({ kind: 'done', idle: 'cap_reached', proposals: [] });
    // Tomorrow the cap is free again (the run is a day old), but the one topic that waits for supply is as many as a cap of one allows.
    await sql`update content.topic_proposals set created_at = now() - interval '2 days'`.execute(db());
    expect(await pass({ cap: 1 })(signal())).toMatchObject({ kind: 'done', idle: 'waiting_topics', proposals: [] });
    expect(calls()).toBe(0);
    expect(await calm()).toEqual(before);
  });

  it('stops adding to a system that has reached the size limit, and to a catalogue where every system has', async () => {
    const before = await calm();
    expect(await pass({ maxPerSystem: 1 })(signal())).toMatchObject({ kind: 'done', idle: 'no_room', proposals: [] });
    expect(calls()).toBe(0);
    expect(await calm()).toEqual(before);
    // Offered to a system with room only: the pass proposes, and a model that names another system is refused by code.
    const result = await pass({
      maxPerSystem: 4,
      script: () =>
        answerWith({
          topics: [
            {
              systemId: 'earth',
              label: 'Orrin waiting',
              meaning: 'A topic the model put under a system that was not offered to it, which code refuses.',
              facets: [
                { label: 'One', meaning: 'The first angle on the invented subject.', quote: QUOTES[0] },
                { label: 'Two', meaning: 'The second angle on the invented subject.', quote: QUOTES[1] },
                { label: 'Three', meaning: 'The third angle on the invented subject.', quote: QUOTES[2] },
              ],
            },
          ],
        }),
    })(signal());
    // Earth holds four topics now (three and the new one): at the limit, so not offered.
    expect(result).toMatchObject({ kind: 'done', proposals: ['not_admitted'] });
    expect(await readCandidate(db(), wiki('Orrin_waiting'))).toMatchObject({
      status: 'refused',
      verdict: 'system_not_offered',
    });
    expect((await live().current()).releaseId).toBe(before.release);
  });

  it('runs one pass at a time: a second finds the lock held and does nothing', async () => {
    const held = await db()
      .connection()
      .execute(async (connection) => {
        await sql`select pg_advisory_lock(hashtextextended('content.grow-topics', 0))`.execute(connection);
        try {
          return await pass()(signal());
        } finally {
          await sql`select pg_advisory_unlock(hashtextextended('content.grow-topics', 0))`.execute(connection);
        }
      });
    expect(held).toEqual({ kind: 'busy' });
    expect(calls()).toBe(0);
  });

  it('lists what it did for the operator: counts by status, and each page with a verdict', async () => {
    const listing = await listCandidates(db(), {});
    const byStatus = Object.fromEntries(
      ['admitted', 'rejected', 'refused'].map((status) => [
        status,
        listing.filter((row) => row.status === status).length,
      ]),
    );
    expect(byStatus).toEqual({ admitted: 1, rejected: 4, refused: 1 });
    expect(listing.find((row) => row.status === 'admitted')).toMatchObject({
      pageUrl: SEAS,
      topicId: 'earth.orrin-seas',
      passages: 10,
    });
  });
});
