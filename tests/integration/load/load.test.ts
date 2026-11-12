import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { NavigationOutcome } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { jobConsumer } from '@knowscroll/backend/infrastructure/jobs';
import { planSnapshot } from '@knowscroll/backend/modules/content';
import { readReleasedCoverage, readRecipeStates } from '@knowscroll/backend/modules/content/nest-providers';
import { prepareBufferQueue } from '@knowscroll/backend/modules/composer';
import { pinCatalogue, type CatalogueTopic } from '@knowscroll/backend/modules/geography/nest-providers';
import { catalogueTopics, gapScanStore, makeScanGaps } from '@knowscroll/backend/modules/supply/nest-providers';
import { drain } from '../simulation/drain.js';
import { catalogueOf } from '../support/catalogue.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import type { FixturePerson } from '../support/fixtures.js';
import { workerDryRuns } from '../support/dry-run.js';
import { recordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import { loadSize, topicId, type LoadSize } from './config.js';
import {
  dirtyOnly,
  FACETS_PER_PLANET,
  formationFixture,
  formationRunner,
  halfBuilt,
  syntheticCatalogue,
} from './formation.js';
import { capturing, explain, slowest, summarise, timed, type Captured } from './measure.js';
import { explainBlock, table, verdict, type PathResult } from './report.js';
import { analyzeAll, inflatePlaces, readStarter, seedHistory, seedLibrary, type LibraryCounts } from './seed.js';
import { SCENE_CAPABILITIES, workerParts } from './worker.js';

/**
 * The load test of #674's design target (slice 4.4): 10,000+ topics, 100,000+ assets, one reader with thousands of topics of history and
 * thousands of formed places, on a disposable PostgreSQL, every hot path through its real application code, timed. It records; it asserts
 * nothing about speed (a budget that is missed is a finding in the report, not a red test), only that each path ran and answered.
 * See README.md for what is synthetic. Run with `pnpm --filter @knowscroll/integration-tests test:load`.
 */
const CAPABILITIES = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
type UseCases = Awaited<ReturnType<typeof scrollUseCases>>;
type DryRun = (universeId: string) => Promise<{ readonly kind: string; readonly refusal?: string }>;
const log = (line: string) => {
  // eslint-disable-next-line no-console -- progress of a long manual run
  console.info(`[load ${new Date().toISOString().slice(11, 19)}] ${line}`);
};

interface Standing {
  readonly sessionId: string;
  readonly intentRevision: number;
  readonly offerId: string;
  readonly exposureId: string;
  readonly kind: 'reel' | 'scroll';
}
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index]!, index);
      }
    }),
  );
}

describe('load test: the design target (#674, slice 4.4)', () => {
  const size: LoadSize = loadSize();
  const results: PathResult[] = [];
  const facts: Record<string, unknown> = {};
  const startedAt = new Date();
  let world: GeographyWorld;
  let direct: UseCases;
  let seedDb: DatabaseHandle<Database>;
  let parts: ReturnType<typeof workerParts>;
  let heavy: FixturePerson;
  let complete: FixturePerson;
  let lights: FixturePerson[] = [];
  let library: LibraryCounts;
  const db = () => world.database.db;

  beforeAll(async () => {
    world = await geographyWorld('load', {
      buffers: true,
      region: true,
      composerPolicy: 'v2',
      workerMaterialChange: true,
    });
    direct = await scrollUseCases(world.database, { recording: true, composerPolicy: 'v2' });
    parts = workerParts(world, 'v2');
    // Bulk statements outlive the 20 s statement timeout the suite gives a test database; the measured paths keep it.
    seedDb = createDatabase<Database>(
      {
        url: world.database.settings.url,
        applicationName: 'knowscroll-load-seed',
        poolMax: 2,
        statementTimeoutMs: 1_800_000,
      },
      { onIdleClientError: () => undefined },
    );
    const seeding = seedDb.db;
    const t0 = performance.now();

    // The template Scroll: the real compiled starter Scroll, admitted through the real import, then withdrawn from the library.
    const source = starterSource() as {
      assetId: string;
      reference: string;
      publication: { explanationUnitId: string };
    };
    source.assetId = randomUUID();
    source.reference = 'ci-load-template';
    source.publication.explanationUnitId = 'load-template';
    const imported = await world.c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('LOAD_TEMPLATE_REFUSED');
    const starter = await readStarter(seeding, imported.assetId);
    await sql`update content.assets set status = 'withdrawn' where id = ${imported.assetId}::uuid`.execute(seeding);

    library = await seedLibrary(seeding, size, starter, log);
    facts['library'] = library;
    facts['seedLibrarySeconds'] = (performance.now() - t0) / 1000;
    log(`library: ${JSON.stringify(library)}`);

    heavy = await recordingPerson(world.database);
    complete = await recordingPerson(world.database);
    lights = [];
    await mapLimit(Array.from({ length: size.lightReaders }), 8, async (_, index) => {
      lights[index] = await recordingPerson(world.database);
    });
    log(`${String(lights.length)} light readers created`);

    await seedHistory(seeding, [heavy.universeId], size, size.heavyMetUnits, { sequential: true, stepMinutes: 25 });
    await seedHistory(
      seeding,
      lights.map((light) => light.universeId),
      size,
      size.lightMetUnits,
      { sequential: false, stepMinutes: 90 },
    );
    log('reader history seeded');
    await analyzeAll(seeding);
    const sizes = await sql<{
      db: string;
      content: string;
      personal: string;
    }>`select pg_size_pretty(pg_database_size(current_database())) as db,
      pg_size_pretty((select sum(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'content' and c.relkind = 'r')) as content,
      pg_size_pretty((select sum(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('experience', 'evidence', 'personal_context') and c.relkind = 'r')) as personal`.execute(
      seeding,
    );
    facts['sizes'] = sizes.rows[0];
    const counts = await sql<Record<string, string>>`select
      (select count(*) from experience.encounter_lineage where universe_id = ${heavy.universeId}::uuid) as heavy_met,
      (select count(*) from evidence.topic_context where universe_id = ${heavy.universeId}::uuid) as heavy_topics,
      (select count(*) from experience.encounter_lineage) as lineage_rows,
      (select count(*) from identity.universes) as universes`.execute(seeding);
    facts['readerRows'] = counts.rows[0];
    facts['seedSeconds'] = (performance.now() - t0) / 1000;
    log(`seeded in ${(performance.now() - t0).toFixed(0)} ms`);
  });

  afterAll(async () => {
    const finishedAt = new Date();
    const pg = await sql<{ version: string; settings: string }>`select version() as version,
      (select string_agg(name || '=' || current_setting(name), ', ' order by name) from pg_settings
        where name in ('shared_buffers', 'work_mem', 'effective_cache_size', 'max_connections', 'TimeZone', 'fsync', 'synchronous_commit', 'random_page_cost', 'jit')) as settings`
      .execute(db())
      .catch(() => ({ rows: [{ version: 'unknown', settings: 'unknown' }] }));
    const body = [
      `Run started ${startedAt.toISOString()}, finished ${finishedAt.toISOString()}; size \`${size.name}\`.`,
      '',
      `Machine: ${String(cpus().length)} logical CPUs (${cpus()[0]?.model ?? 'unknown'}), ${(totalmem() / 2 ** 30).toFixed(0)} GiB memory, Node ${process.version}.`,
      `PostgreSQL: ${pg.rows[0]?.version ?? 'unknown'}`,
      `Settings: ${pg.rows[0]?.settings ?? 'unknown'}`,
      '',
      '```json',
      JSON.stringify(facts, null, 2),
      '```',
      '',
      table(results),
      '',
      ...results.flatMap((result) => [
        `### ${result.name}`,
        '',
        ...result.notes.map((note) => `- ${note}`),
        '',
        explainBlock(result),
        '',
      ]),
    ].join('\n');
    const directory = new URL('./output/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('measurements.md', directory), body);
    writeFileSync(new URL('results.json', directory), JSON.stringify({ size, facts, results }, null, 2));
    log(`wrote ${new URL('measurements.md', directory).pathname}`);
    for (const result of results)
      log(
        `${result.name}: p50 ${result.summary.p50.toFixed(1)} p95 ${result.summary.p95.toFixed(1)} max ${result.summary.max.toFixed(1)} ${verdict(result)}`,
      );
    await seedDb.close();
    await direct.close();
    await world.close();
  });

  // ----------------------------------------------------------------------------------------------------------------
  // Navigation: a Composer v2 vertical decision, and what a person does around it
  // ----------------------------------------------------------------------------------------------------------------
  async function discover(c: UseCases, person: FixturePerson) {
    const answer = await c.navigate(person.authority, {
      commandId: randomUUID(),
      target: { kind: 'discover' },
      capabilities: CAPABILITIES,
    });
    return answer.kind === 'accepted' && answer.outcome.status === 'ready' ? answer.outcome : undefined;
  }
  async function activate(c: UseCases, person: FixturePerson, outcome: Ready): Promise<Standing> {
    const activated = await c.activateOffer(person.authority, {
      commandId: randomUUID(),
      target: {
        kind: 'offer',
        sessionId: outcome.sessionId,
        offerId: outcome.offer.offerId,
        expectedIntentRevision: outcome.intentRevision,
      },
    });
    if (activated.kind !== 'accepted') throw new Error(`LOAD_ACTIVATION_REFUSED ${JSON.stringify(activated)}`);
    return {
      sessionId: outcome.sessionId,
      intentRevision: outcome.intentRevision,
      offerId: outcome.offer.offerId,
      exposureId: activated.outcome.exposureId,
      kind: outcome.offer.metadata.kind,
    };
  }
  async function vertical(c: UseCases, person: FixturePerson, standing: Standing) {
    return c.navigate(person.authority, {
      commandId: randomUUID(),
      sessionId: standing.sessionId,
      expectedIntentRevision: standing.intentRevision,
      from: { offerId: standing.offerId, exposureId: standing.exposureId },
      intent: { mode: 'vertical', direction: 'next', format: standing.kind },
    });
  }

  it('navigation: the vertical decision for the heavy reader and for light readers', async () => {
    const heavyMs: number[] = [];
    const heavyQueries: Captured[] = [];
    const heavyStatus: Record<string, number> = {};
    let repeats = 0;
    let offers = 0;
    const discoverMs: number[] = [];
    const activateMs: number[] = [];
    const first = await timed(() => discover(direct, heavy));
    discoverMs.push(first.ms);
    if (!first.value) throw new Error('LOAD_HEAVY_DISCOVER_NOT_READY');
    const metNumber = (unit: string) => Number(unit.slice(3));
    const met = (unit: string) => unit.startsWith('lu-') && metNumber(unit) <= size.heavyMetUnits;
    const note = (outcome: Ready) => {
      for (const offer of [outcome.offer, ...outcome.bufferedOffers]) {
        offers += 1;
        if (met(offer.explanationUnitId)) repeats += 1;
      }
    };
    note(first.value);
    let standing = (await timed(() => activate(direct, heavy, first.value!))).value;
    for (let i = 0; i < size.heavyDecisions; i++) {
      const { value, queries } = await capturing(() => timed(() => vertical(direct, heavy, standing)));
      heavyMs.push(value.ms);
      heavyQueries.push(...queries);
      const status = value.value.kind === 'accepted' ? value.value.outcome.status : value.value.kind;
      heavyStatus[status] = (heavyStatus[status] ?? 0) + 1;
      if (value.value.kind !== 'accepted' || value.value.outcome.status !== 'ready') break;
      note(value.value.outcome);
      const next = await timed(() =>
        activate(direct, heavy, value.value.kind === 'accepted' ? (value.value.outcome as Ready) : first.value!),
      );
      activateMs.push(next.ms);
      standing = next.value;
    }
    const slow = slowest(heavyQueries);
    results.push({
      name: 'Composer v2 vertical decision, heavy reader',
      summary: summarise(heavyMs),
      budget: { label: 'navigation', limitMs: 300, statistic: 'p95' },
      notes: [
        `The reader has met ${String(size.heavyMetUnits)} explanations over ${String(size.heavyMetUnits)} topics (encounter lineage), so every decision sends the bounded met list (up to 5,000 ids) into retrieval.`,
        `Answers: ${JSON.stringify(heavyStatus)}; ${String(offers)} offers examined, ${String(repeats)} of them an explanation the reader had already met (policy v2 must make this 0 while anything unseen exists).`,
        `Statements per decision: ${(heavyQueries.length / Math.max(1, heavyMs.length)).toFixed(0)} on average (transaction plumbing included).`,
        `First "Somewhere new" (discover) ${discoverMs[0]!.toFixed(0)} ms; offer activation p50 ${summarise(activateMs).p50.toFixed(0)} ms, p95 ${summarise(activateMs).p95.toFixed(0)} ms (not budgeted).`,
      ],
      ...(slow ? { explain: await explain(world.database.name, slow, heavyQueries) } : {}),
    });
    log(`heavy decisions: ${JSON.stringify(summarise(heavyMs))}`);

    const lightMs: number[] = [];
    const lightQueries: Captured[] = [];
    const lightStatus: Record<string, number> = {};
    const lightDiscover: number[] = [];
    for (let i = 0; i < size.lightDecisions; i++) {
      const person = lights[i % lights.length]!;
      const opened = await timed(() => discover(direct, person));
      lightDiscover.push(opened.ms);
      if (!opened.value) {
        lightStatus['discover_not_ready'] = (lightStatus['discover_not_ready'] ?? 0) + 1;
        continue;
      }
      const stand = await activate(direct, person, opened.value);
      const { value, queries } = await capturing(() => timed(() => vertical(direct, person, stand)));
      lightMs.push(value.ms);
      lightQueries.push(...queries);
      const status = value.value.kind === 'accepted' ? value.value.outcome.status : value.value.kind;
      lightStatus[status] = (lightStatus[status] ?? 0) + 1;
    }
    const lightSlow = slowest(lightQueries);
    results.push({
      name: 'Composer v2 vertical decision, light readers',
      summary: summarise(lightMs),
      budget: { label: 'navigation', limitMs: 300, statistic: 'p95' },
      notes: [
        `${String(size.lightReaders)} light readers with ${String(size.lightMetUnits)} met explanations each; each of the ${String(size.lightDecisions)} decisions is a different reader's first swipe.`,
        `Answers: ${JSON.stringify(lightStatus)}; "Somewhere new" p50 ${summarise(lightDiscover).p50.toFixed(0)} ms, p95 ${summarise(lightDiscover).p95.toFixed(0)} ms (not budgeted).`,
      ],
      ...(lightSlow ? { explain: await explain(world.database.name, lightSlow, lightQueries) } : {}),
    });
    log(`light decisions: ${JSON.stringify(summarise(lightMs))}`);
  });

  // ----------------------------------------------------------------------------------------------------------------
  // Buffer preparation: the worker's job after each activation
  // ----------------------------------------------------------------------------------------------------------------
  it('buffer preparation: the worker job queued by an activation', async () => {
    for (const [label, readers] of [
      ['heavy reader', [heavy]],
      ['light readers', lights.slice(size.lightDecisions % Math.max(1, lights.length))],
    ] as const) {
      const ms: number[] = [];
      const outcomes: Record<string, number> = {};
      const queries: Captured[] = [];
      const consumer = jobConsumer(prepareBufferQueue, async (payload, delivery) => {
        const { value, queries: seen } = await capturing(() =>
          timed(() => parts.prepareBuffer(payload, { jobId: delivery.jobId, signal: delivery.signal })),
        );
        ms.push(value.ms);
        queries.push(...seen);
        const kind = (value.value as { kind?: string }).kind ?? 'done';
        outcomes[kind] = (outcomes[kind] ?? 0) + 1;
      });
      for (let i = 0; i < size.bufferRuns; i++) {
        const person = readers[i % readers.length]!;
        const opened = await discover(world.c, person);
        if (!opened) continue;
        await activate(world.c, person, opened);
        await drain(world.c.boss, db(), [consumer], { maxRounds: 3 });
      }
      const slow = slowest(queries);
      results.push({
        name: `Buffer preparation, ${label}`,
        summary: summarise(ms),
        notes: [
          `The worker's \`composer.prepare-buffer\` handler, as the worker composes it, run for each queued job (no model: Jev off).`,
          `Outcomes: ${JSON.stringify(outcomes)}.`,
          'No budget was set for this path by the issue; it runs off the request path, and the figure is for the report.',
        ],
        ...(slow ? { explain: await explain(world.database.name, slow, queries) } : {}),
      });
      log(`buffer ${label}: ${JSON.stringify(summarise(ms))}`);
    }
  });

  // ----------------------------------------------------------------------------------------------------------------
  // Formation: thousands of formed places, then one new reading
  // ----------------------------------------------------------------------------------------------------------------
  // The Cartographer's recorded outcome of one run, and what its frozen context held.
  const recorded = async (runId: string) =>
    (
      await sql<{
        outcome: string | null;
        bytes: number;
        topics: number | null;
        status: string;
      }>`select status, outcome::text as outcome,
        octet_length(context::text) as bytes, jsonb_array_length(context -> 'evaluated' -> 'topics') as topics
        from geography.runs where id = ${runId}::uuid`.execute(db())
    ).rows[0];
  const describeRuns = (rows: (Awaited<ReturnType<typeof recorded>> | undefined)[]) => {
    const defined = rows.filter((row) => row !== undefined);
    const tally = (key: (row: (typeof defined)[number]) => string) =>
      JSON.stringify(
        defined.reduce<Record<string, number>>((all, row) => ({ ...all, [key(row)]: (all[key(row)] ?? 0) + 1 }), {}),
      );
    return `Frozen context: max ${String(Math.max(...defined.map((row) => row.bytes)))} bytes, max ${String(Math.max(...defined.map((row) => row.topics ?? 0)))} topics evaluated. Run statuses ${tally((row) => row.status)}; outcomes ${tally((row) => (row.outcome ?? 'none').slice(0, 80))}.`;
  };
  const countPlaces = async (universeId: string) =>
    (
      await sql<{
        kind: string;
        n: number;
      }>`select payload ->> 'kind' as kind, count(*)::int as n from geography.objects
        where universe_id = ${universeId}::uuid group by 1 order by 1`.execute(db())
    ).rows;
  const placesText = (rows: { kind: string; n: number }[]) =>
    `${String(rows.reduce((sum, row) => sum + row.n, 0))} places (${rows.map((row) => `${String(row.n)} ${row.kind}`).join(', ')})`;
  const dirtyCount = async (universeId: string) =>
    Number(
      (
        await sql<{
          n: string;
        }>`select count(*) as n from personal_context.coverage_dirty_topics where universe_id = ${universeId}::uuid`.execute(
          db(),
        )
      ).rows[0]!.n,
    );

  /** One reading of a topic, then one Cartographer run, timed with its statements captured. */
  async function readingThenRun(
    fx: ReturnType<typeof formationFixture>,
    runner: ReturnType<typeof formationRunner>,
    person: FixturePerson,
    index: number,
    label: string,
    facet: number,
    extra: readonly string[] = [],
  ) {
    for (const [n, name] of [label, ...extra].entries())
      await fx.addUnit(seedDb.db, person.universeId, index, name, facet + n);
    await dirtyOnly(world, person, topicId(index));
    const { value, queries } = await capturing(() => timed(() => runner.cartograph(person)));
    return { ms: value.ms, queries, row: await recorded(value.value) };
  }

  it('formation: the real run to its limit, then incremental runs after one new qualified reading', async () => {
    const synthetic = syntheticCatalogue(size.topics);
    const fx = formationFixture(synthetic.entries, synthetic.planets);
    const keys = await fx.seed(seedDb.db, heavy.universeId, size.heavyPlanets);
    const runner = formationRunner(world, fx.overrides);

    // (1) The catch-up of a reader with 2,400 planets of support: an explicit request marks every topic dirty, and runs follow until none is pending.
    const asked = await world.request(heavy.authority, { commandId: randomUUID() });
    if (asked.kind !== 'accepted') throw new Error('LOAD_REQUEST_REFUSED');
    const catchUp = performance.now();
    let runs = 0;
    const lastRuns: string[] = [];
    for (; (await world.state(heavy)).activeRunId && runs < 2_000; runs++)
      lastRuns.push(await runner.cartograph(heavy));
    const catchUpMs = performance.now() - catchUp;
    const atLimit = await countPlaces(heavy.universeId);
    const left = await dirtyCount(heavy.universeId);
    const finalRuns = await Promise.all(lastRuns.slice(-5).map(recorded));
    facts['heavyFormation'] = {
      supportKeys: keys,
      planets: size.heavyPlanets,
      catchUpRuns: runs,
      catchUpMs,
      places: atLimit,
      dirtyTopicsLeft: left,
    };
    log(
      `formation catch-up: ${String(runs)} runs, ${catchUpMs.toFixed(0)} ms, ${placesText(atLimit)}, ${String(left)} topics still dirty`,
    );
    results.push({
      name: `Formation catch-up of ${String(size.heavyPlanets)} planets (explicit request: every topic dirty)`,
      summary: summarise([catchUpMs]),
      notes: [
        `${String(runs)} runs of at most 16 dirty topics each, back to back (no 30 s pacing), then no run was left pending: ${(catchUpMs / Math.max(1, runs)).toFixed(0)} ms per run.`,
        `Result: ${placesText(atLimit)} of the ${String(size.heavyPlanets)} planets' places formed; ${String(left)} topics still dirty. The last runs: ${describeRuns(finalRuns)}`,
        'Formation stops at the 1,000-place limit of one reader (outcome `limit`, run `stale`) when the reader has more planets than that holds: the rest never form and their topics stay dirty. It is a one-time pass (explicit request, or the operator reconciliation) and has no budget.',
      ],
    });

    // (2) The heavy reader at the limit: a reading of a formed topic (applies or changes nothing), and a reading that would create a place (refused at the limit).
    const formed = (
      await sql<{ concept: string }>`select payload ->> 'conceptId' as concept from geography.objects
        where universe_id = ${heavy.universeId}::uuid and payload ->> 'kind' = 'planet' order by id limit ${size.formationRuns}`.execute(
        db(),
      )
    ).rows.map((row) => Number(row.concept.slice(-5)));
    const heavySteady = {
      ms: [] as number[],
      queries: [] as Captured[],
      rows: [] as Awaited<ReturnType<typeof recorded>>[],
    };
    for (const [i, index] of formed.entries()) {
      const r = await readingThenRun(fx, runner, heavy, index, `again-${String(i)}`, i);
      heavySteady.ms.push(r.ms);
      heavySteady.queries.push(...r.queries);
      heavySteady.rows.push(r.row);
    }
    const slowSteady = slowest(heavySteady.queries);
    results.push({
      name: 'Formation run after one new reading, heavy reader (a topic whose places are formed)',
      summary: summarise(heavySteady.ms),
      budget: { label: 'formation run', limitMs: 2000, statistic: 'p95' },
      notes: [
        `Heavy reader: ${String(size.heavyPlanets)} planets of support (${String(keys)} support keys), ${placesText(atLimit)} stored; catalogue of ${String(size.topics)} topics (synthetic, injected).`,
        "Timed: one `geography.cartograph` run (claim, freeze the context of the dirty topic, the model wait as a fixture, apply, delta, settle). Not timed: the new support row and the dirty mark, which a reading's projection makes.",
        describeRuns(heavySteady.rows),
      ],
      ...(slowSteady ? { explain: await explain(world.database.name, slowSteady, heavySteady.queries) } : {}),
    });
    const unformed = Array.from({ length: size.heavyPlanets }, (_, index) => index)
      .filter((index) => !formed.includes(index) && halfBuilt(index))
      .slice(0, size.formationRuns);
    const refused = {
      ms: [] as number[],
      queries: [] as Captured[],
      rows: [] as Awaited<ReturnType<typeof recorded>>[],
    };
    for (const index of unformed) {
      const r = await readingThenRun(fx, runner, heavy, index, 'ex-a', 1, ['ex-b']);
      refused.ms.push(r.ms);
      refused.queries.push(...r.queries);
      refused.rows.push(r.row);
    }
    const slowRefused = slowest(refused.queries);
    results.push({
      name: 'Formation run after one new reading, heavy reader (a planet would be created)',
      summary: summarise(refused.ms),
      budget: { label: 'formation run', limitMs: 2000, statistic: 'p95' },
      notes: [
        `Each reading completes a planet that has no place yet (three units over two facets). The reader holds ${placesText(atLimit)}; one reader may hold 1,000.`,
        describeRuns(refused.rows),
        'Read the outcomes: a run that is refused as `limit` is fast, and the point is the answer. A reader at the limit cannot gain a place however much it reads.',
      ],
      ...(slowRefused ? { explain: await explain(world.database.name, slowRefused, refused.queries) } : {}),
    });

    // (3) A reader below the limit, for the cost of the runs that do create places: 280 planets, about 750 places.
    const below = await recordingPerson(world.database);
    const belowPlanets = Math.min(280, size.heavyPlanets);
    const belowFx = formationFixture(synthetic.entries, synthetic.planets);
    await belowFx.seed(seedDb.db, below.universeId, belowPlanets);
    const belowRunner = formationRunner(world, belowFx.overrides);
    const belowAsked = await world.request(below.authority, { commandId: randomUUID() });
    if (belowAsked.kind !== 'accepted') throw new Error('LOAD_REQUEST_REFUSED');
    for (let n = 0; (await world.state(below)).activeRunId && n < 400; n++) await belowRunner.cartograph(below);
    const belowPlaces = await countPlaces(below.universeId);
    const creating = {
      ms: [] as number[],
      queries: [] as Captured[],
      rows: [] as Awaited<ReturnType<typeof recorded>>[],
    };
    const halves = Array.from({ length: belowPlanets }, (_, index) => index).filter((index) => halfBuilt(index));
    for (const index of halves.slice(0, size.formationRuns)) {
      const r = await readingThenRun(belowFx, belowRunner, below, index, 'ex-a', 1, ['ex-b']);
      creating.ms.push(r.ms);
      creating.queries.push(...r.queries);
      creating.rows.push(r.row);
    }
    const slowCreating = slowest(creating.queries);
    results.push({
      name: 'Formation run after one new reading, reader below the limit (a planet and its regions are created)',
      summary: summarise(creating.ms),
      budget: { label: 'formation run', limitMs: 2000, statistic: 'p95' },
      notes: [
        `A reader with ${String(belowPlanets)} planets of support and ${placesText(belowPlaces)} stored. Each reading completes a half-built planet: the planet and two regions are created and a delta is written.`,
        describeRuns(creating.rows),
      ],
      ...(slowCreating ? { explain: await explain(world.database.name, slowCreating, creating.queries) } : {}),
    });

    // (4) What the issue asked for in the data: thousands of formed places. The real code cannot form them, so the rest of the catalogue's places are written by SQL.
    const written = await inflatePlaces(seedDb.db, heavy.universeId, size.heavyPlanets, (index) => ({
      system: topicId(index).split('.t')[0]!,
      planet: topicId(index),
      facets: Array.from({ length: FACETS_PER_PLANET }, (_, f) => `${topicId(index)}.f${String(f)}`),
    }));
    await sql`analyze geography.objects`.execute(seedDb.db);
    const inflated = await countPlaces(heavy.universeId);
    facts['heavyPlacesSeeded'] = { writtenBySql: written, places: inflated };
    log(`heavy places inflated: +${String(written)} → ${placesText(inflated)}`);
    const big = { ms: [] as number[], queries: [] as Captured[], rows: [] as Awaited<ReturnType<typeof recorded>>[] };
    for (const [i, index] of formed.entries()) {
      const r = await readingThenRun(fx, runner, heavy, index, `more-${String(i)}`, i + 1);
      big.ms.push(r.ms);
      big.queries.push(...r.queries);
      big.rows.push(r.row);
    }
    const slowBig = slowest(big.queries);
    results.push({
      name: "Formation run after one new reading, heavy reader with every planet's places stored",
      summary: summarise(big.ms),
      budget: { label: 'formation run', limitMs: 2000, statistic: 'p95' },
      notes: [
        `${placesText(inflated)} stored (${String(written)} of them written by SQL, not formed by a run).`,
        describeRuns(big.rows),
      ],
      ...(slowBig ? { explain: await explain(world.database.name, slowBig, big.queries) } : {}),
    });
    log(
      `formation heavy-at-limit: ${JSON.stringify(summarise(heavySteady.ms))}; creating below limit: ${JSON.stringify(summarise(creating.ms))}; inflated: ${JSON.stringify(summarise(big.ms))}`,
    );
  });

  // ----------------------------------------------------------------------------------------------------------------
  // The Universe / sky read
  // ----------------------------------------------------------------------------------------------------------------
  it('the Universe read: the heavy reader, and a reader whose whole product catalogue is formed', async () => {
    // A reader over the real catalogue (release 1 of the library plan): every planet formed, so the read can be answered and Scenes can project it.
    const snapshot = planSnapshot();
    const pinned = pinCatalogue(snapshot);
    const entries: CatalogueTopic[] = snapshot.all().map((concept) => pinned.topic(concept.id)!);
    const planets = entries.filter((entry) => entry.parent !== null && entry.facets.length > 0);
    const realFx = formationFixture(entries, planets, { halfBuilt: false, snapshot });
    await realFx.seed(seedDb.db, complete.universeId, planets.length);
    const runner = formationRunner(world, realFx.overrides);
    const asked = await world.request(complete.authority, { commandId: randomUUID() });
    if (asked.kind !== 'accepted') throw new Error('LOAD_REQUEST_REFUSED');
    let runs = 0;
    for (; (await world.state(complete)).activeRunId && runs < 200; runs++) await runner.cartograph(complete);
    const objects = Number(
      (
        await sql<{
          n: string;
        }>`select count(*) as n from geography.objects where universe_id = ${complete.universeId}::uuid`.execute(db())
      ).rows[0]!.n,
    );
    facts['completeReader'] = { planets: planets.length, runs, objects };

    const universe = { selection: { kind: 'universe' as const }, limit: 100 };
    const answerOf = (read: Awaited<ReturnType<typeof world.read>>) =>
      read.kind === 'read'
        ? `${read.snapshot.status}${'reason' in read.snapshot ? `/${read.snapshot.reason}` : ''}`
        : read.reason;

    for (const [label, person, budgeted] of [
      ['heavy reader', heavy, false],
      ['reader with the whole product catalogue formed', complete, true],
    ] as const) {
      const ms: number[] = [];
      const queries: Captured[] = [];
      const answers: Record<string, number> = {};
      for (let i = 0; i < size.skyReads; i++) {
        const { value, queries: seen } = await capturing(() => timed(() => world.read(person.authority, universe)));
        ms.push(value.ms);
        queries.push(...seen);
        const key = answerOf(value.value);
        answers[key] = (answers[key] ?? 0) + 1;
      }
      const slow = slowest(queries);
      const stored = Number(
        (
          await sql<{
            n: string;
          }>`select count(*) as n from geography.objects where universe_id = ${person.universeId}::uuid`.execute(db())
        ).rows[0]!.n,
      );
      results.push({
        name: `Universe read (geography snapshot, 100 per page), ${label}`,
        summary: summarise(ms),
        ...(budgeted ? { budget: { label: 'sky read', limitMs: 500, statistic: 'p95' as const } } : {}),
        notes: [
          `${String(stored)} places stored. Answers: ${JSON.stringify(answers)}.`,
          budgeted
            ? 'The read the client makes first; this reader can be answered because every place is valid against the (17-topic) code catalogue.'
            : 'The read refuses as `limit` past 1,000 places (`read.ts`), and as `temporarily_unavailable` when a stored place names a concept the code catalogue lacks (`validView`); this reader holds both kinds, so the figure is the time to be refused, and the read does not meet the design target whatever its speed.',
        ],
        ...(slow ? { explain: await explain(world.database.name, slow, queries) } : {}),
      });
    }

    // Scenes: the projection of each reader's Geography, then the manifest and a chunk read.
    for (const [label, person] of [
      ['heavy reader', heavy],
      ['reader with the whole product catalogue formed', complete],
    ] as const) {
      const job = (
        await sql<{
          data: unknown;
        }>`select data from pgboss.job where name = 'scenes.project' and data ->> 'universeId' = ${person.universeId}
          order by created_on desc limit 1`.execute(db())
      ).rows[0];
      const projectNotes: string[] = [];
      let projectedMs = Number.NaN;
      if (job) {
        const { value, queries } = await capturing(async () =>
          timed(async () => {
            try {
              return `answered ${JSON.stringify(await parts.projectScene(job.data as never))}`;
            } catch (error) {
              return `refused: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`;
            }
          }),
        );
        projectedMs = value.ms;
        projectNotes.push(
          `Projection (\`scenes.project\`) of ${label}: ${value.value} in ${value.ms.toFixed(0)} ms, ${String(queries.length)} statements.`,
        );
      } else projectNotes.push(`No \`scenes.project\` job was queued for the ${label}.`);
      const manifest: number[] = [];
      const chunk: number[] = [];
      const manifestQueries: Captured[] = [];
      let answer = 'not read';
      let chunkAnswer = 'not read';
      for (let i = 0; i < size.skyReads; i++) {
        const { value, queries } = await capturing(() =>
          timed(() =>
            parts.readManifest(person.authority, {
              selection: { kind: 'universe' },
              capabilities: SCENE_CAPABILITIES,
            } as never),
          ),
        );
        manifest.push(value.ms);
        manifestQueries.push(...queries);
        answer = value.value.kind === 'read' ? value.value.scene.status : value.value.reason;
        if (
          value.value.kind === 'read' &&
          'manifest' in value.value.scene &&
          value.value.scene.manifest.chunks.length > 0
        ) {
          const ref = value.value.scene.manifest.chunks[0]!;
          const read = await timed(() =>
            parts.readChunk(person.authority, {
              selection: { kind: 'universe' },
              capabilities: SCENE_CAPABILITIES,
              reference: {
                universeId: person.universeId,
                privacyEpoch: 1,
                manifestSceneRevision: value.value.kind === 'read' ? value.value.scene.sceneRevision : 0,
                chunkId: ref.chunkId,
                chunkSceneRevision: ref.sceneRevision,
              },
            } as never),
          );
          chunk.push(read.ms);
          chunkAnswer = read.value.kind === 'read' ? 'read' : read.value.reason;
        }
      }
      const slow = slowest(manifestQueries);
      results.push({
        name: `Scenes manifest read (the sky), ${label}`,
        summary: summarise(manifest),
        ...(person === complete ? { budget: { label: 'sky read', limitMs: 500, statistic: 'p95' as const } } : {}),
        notes: [
          ...projectNotes,
          `Manifest answer: ${answer}; one chunk read: ${chunkAnswer}${chunk.length ? ` (p50 ${summarise(chunk).p50.toFixed(1)} ms, p95 ${summarise(chunk).p95.toFixed(1)} ms over ${String(chunk.length)})` : ''}.`,
          Number.isFinite(projectedMs) ? '' : '',
        ].filter(Boolean),
        ...(slow ? { explain: await explain(world.database.name, slow, manifestQueries) } : {}),
      });
    }
  });

  // ----------------------------------------------------------------------------------------------------------------
  // The dry-run commands
  // ----------------------------------------------------------------------------------------------------------------
  it('the dry-run commands: geography dry-run and planner dry-run for the heavy reader', async () => {
    // The operator's reconciliation leaves every topic of a reader dirty: the worst case for a dry run.
    const asked = await world.request(heavy.authority, { commandId: randomUUID() });
    if (asked.kind !== 'accepted') throw new Error('LOAD_REQUEST_REFUSED');
    const runs = workerDryRuns(world);
    for (const [label, run] of [
      ['geography dry-run', runs.geography as DryRun],
      ['planner dry-run', runs.planner as DryRun],
    ] as const) {
      for (const [who, person] of [
        ['heavy reader', heavy],
        ['light reader', lights[0]!],
      ] as const) {
        const ms: number[] = [];
        const queries: Captured[] = [];
        const answers: Record<string, number> = {};
        for (let i = 0; i < 5; i++) {
          const { value, queries: seen } = await capturing(() => timed(() => run(person.universeId)));
          ms.push(value.ms);
          queries.push(...seen);
          const key = value.value.kind === 'read' ? 'read' : `refused:${String(value.value.refusal)}`;
          answers[key] = (answers[key] ?? 0) + 1;
        }
        const slow = slowest(queries);
        results.push({
          name: `\`${label}\`, ${who}`,
          summary: summarise(ms),
          notes: [
            `Answers: ${JSON.stringify(answers)}. Through the worker's own wiring (\`dryRunsFor\`), read-only.`,
            who === 'heavy reader'
              ? 'The heavy reader has every topic dirty (the explicit request above); the real trusted read does not vouch for the synthetic supports, so the report says what a run would settle, not a formation.'
              : 'A light reader: a few met explanations and no coverage.',
            'No budget was set for this path by the issue.',
          ],
          ...(slow ? { explain: await explain(world.database.name, slow, queries) } : {}),
        });
      }
    }
  });

  // ----------------------------------------------------------------------------------------------------------------
  // The gap loop's scan
  // ----------------------------------------------------------------------------------------------------------------
  it('the gap loop: the scheduled scan over the whole library', async () => {
    const reader = lights.map((light) => light.universeId);
    // Readers' marks of the last days (a decision that fell to its last resort, a topic with little unseen left ...): 100 topics each.
    const perReader = Math.min(100, size.topics);
    await sql`insert into supply.gap_signal_marks(universe_id, privacy_epoch, day, key, source, planet, facet, counted)
      select u.id, 1, current_date, md5(u.id::text || ':' || k) || md5(k::text || u.id::text), 'last_resort',
        ('load.s' || lpad((((k * 97) % ${sql.raw(String(size.topics))}) / 100)::text, 3, '0') || '.t' || lpad(((k * 97) % ${sql.raw(String(size.topics))})::text, 5, '0')), null, false
      from unnest(${reader}::uuid[]) as u(id) cross join generate_series(1, ${perReader}::int) as k`.execute(seedDb.db);
    await sql`analyze supply.gap_signal_marks`.execute(seedDb.db);
    const scan = makeScanGaps({
      readCatalogue: async () => catalogueTopics(await catalogueOf(db()).current()),
      enabled: true,
      depthTarget: 6,
      maxRounds: 3,
      store: gapScanStore(db()),
      readCoverage: () => readReleasedCoverage(db()),
      readRecipeStates: (keys) => readRecipeStates(db(), keys),
      now: () => new Date(),
      newId: randomUUID,
    });
    const first = await capturing(() => timed(() => scan()));
    const later: number[] = [];
    const queries: Captured[] = [...first.queries];
    const answers: string[] = [first.value.value.kind];
    for (let i = 1; i < size.gapScans; i++) {
      const { value, queries: seen } = await capturing(() => timed(() => scan()));
      later.push(value.ms);
      queries.push(...seen);
      answers.push(value.value.kind);
    }
    const slow = slowest(queries);
    const coverageOnly = await timed(() => readReleasedCoverage(db()));
    results.push({
      name: 'Gap loop scan (`supply.scan-gaps`), first scan with the marks to count',
      summary: summarise([first.value.ms]),
      budget: { label: 'gap scan', limitMs: 5000, statistic: 'max' },
      notes: [
        `${String(reader.length * perReader)} uncounted marks from ${String(reader.length)} readers, counted into the daily signals by this scan; the library has ${String(library.assets)} assets and ${String(library.releasedBindings)} released bindings over ${String(library.topics)} topics.`,
        `Outcome: ${JSON.stringify(first.value.value)}.`,
        `The structural pass walks the release-1 catalogue read from the database (17 planets); the scan is given that catalogue, not the 10,000-topic synthetic one, so the in-memory part over a 10,000-topic catalogue is not measured. The library read (\`readReleasedCoverage\`, SQL over all ${String(library.releasedBindings)} bindings) alone took ${coverageOnly.ms.toFixed(0)} ms and returned ${String(coverageOnly.value.planets.length)} planets.`,
      ],
      ...(slow ? { explain: await explain(world.database.name, slow, queries) } : {}),
    });
    results.push({
      name: 'Gap loop scan, later scans (marks already counted)',
      summary: summarise(later),
      budget: { label: 'gap scan', limitMs: 5000, statistic: 'max' },
      notes: [`Outcomes: ${answers.join(', ')}.`],
    });
  });
});
