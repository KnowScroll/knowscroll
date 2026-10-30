import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import { stopWords, WORDS_PER_MINUTE_V2 } from '@knowscroll/scroll-model';
import type { ReadingFacts } from '@knowscroll/backend/modules/content';
import { makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { ReadingFactsSchema } from '../../../packages/backend/src/modules/content/adapters/reading-facts-schema.js';
import { readingFactsOfV2 } from '../../../packages/backend/src/modules/content/adapters/reading-facts-v2.js';
import { evidencePassages } from '../../../packages/backend/src/modules/content/production/evidence.js';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import {
  compileGeneratedScrollV2,
  publicationV2,
} from '../../../packages/backend/src/modules/content/production/writer-v2.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { coverageLocatorTypes } from '../../../packages/backend/src/modules/content/domain/coverage.js';
import { ELIGIBLE_BY_FACTS_VERSION } from '../../../packages/backend/src/modules/evidence/domain/coverage.js';
import { SCROLL_QUALIFICATION_POLICY_V0 as policy } from '../../../packages/backend/src/modules/evidence/domain/policy.js';
import { qualifyScrollReading } from '../../../packages/backend/src/modules/evidence/domain/qualification.js';
import {
  summariseReading,
  type ObservationBody,
  type ObservationRecord,
} from '../../../packages/backend/src/modules/evidence/domain/reading-summary.js';
import { signal } from '../support/fixture-model.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { markScrollV1, ORRIN_PLAN } from '../support/scroll-v2.js';

/**
 * How a v2 Scroll is read (D-128): a stop counts after its own reading time, a call when it is
 * locked in or revealed, and the same q and thresholds as v1 decide. The document is the labelled
 * Orrin fixture: no provider output, no product content.
 */
function orrin(): { readonly facts: ReadingFacts; readonly nominalMs: ReadonlyMap<string, number> } {
  const compiled = compileGeneratedScrollV2(fixtureAuthoredV2(), {
    publication: publicationV2('seasons'),
    recipe: ORRIN_PLAN,
    passages: evidencePassages([fixtureResearchPageV2]),
    pages: [fixtureResearchPageV2],
  });
  if (compiled.kind !== 'compiled') throw new Error('CI fixture must compile');
  // What reading each stop's words takes at 230 words a minute, from the document and not from the facts.
  const nominalMs = new Map(
    compiled.document.stops.map((stop) => [stop.id, (stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2] as const),
  );
  return { facts: readingFactsOfV2(compiled.document), nominalMs };
}

interface Reading {
  /** Visible intervals by block, on one clock. */
  readonly visits: readonly { readonly blockId: string; readonly from: number; readonly to: number }[];
  /** Calls reported as locked in. */
  readonly locked: readonly string[];
}

/** The observations a reader's device would report for a reading, in intake order. */
function observations({ visits, locked }: Reading): ObservationRecord[] {
  const bodies: ObservationBody[] = [
    {
      kind: 'scroll.block_coverage',
      blocks: visits.map((visit) => ({
        blockId: visit.blockId,
        intervalsMs: [[visit.from, visit.to]],
        peakFraction: 1,
      })),
    },
    { kind: 'scroll.active_dwell', activeIntervalsMs: visits.map((visit) => [visit.from, visit.to]) },
    ...locked.map((blockId): ObservationBody => ({
      kind: 'scroll.block_interaction',
      blockId,
      interaction: 'locked',
      atMs: 1,
    })),
  ];
  return bodies.map((body, index) => ({
    seq: index + 1,
    sessionId: 's1',
    deviceSequence: index + 1,
    instrumentationVersion: 1,
    body,
  }));
}

const qualify = (facts: ReadingFacts, reading: Reading) =>
  qualifyScrollReading(summariseReading(observations(reading), facts, policy), policy);

/** Every stop for `shareOfMinimum` of its own reading time (and 10 s on a call, locked), one after another. */
function walkthrough(facts: ReadingFacts, shareOfMinimum: number, lockCalls: boolean): Reading {
  let at = 0;
  const visits = facts.blocks.map((block) => {
    const length = block.seen?.kind === 'visible' ? Math.round(block.seen.minVisibleMs * shareOfMinimum) : 10_000;
    const visit = { blockId: block.id, from: at, to: at + Math.max(1, length) };
    at = visit.to + 100;
    return visit;
  });
  return {
    visits,
    locked: lockCalls ? facts.blocks.filter((b) => b.seen?.kind === 'interaction').map((b) => b.id) : [],
  };
}

/** Small deterministic generator, so the generated traces are the same on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A tap through a read stop gives it less than this share of the time its words take to read: just
 * under the 40 % that D-128 asks for. This is the hardest tapping that must still not qualify, because
 * v1's half-second rule would count such a stop as seen and q could then reach the bar.
 */
const TAP_SHARE = 0.39;

/**
 * Tapping through the spine: the dots in any order, any subset, each read stop on screen for most of
 * (but under) {@link TAP_SHARE} of the time its words take, each call for a few seconds, and any calls
 * locked in as fast as possible. The limits come from the document's words, not from the facts under test.
 */
function tapTrace(
  seed: number,
  facts: ReadingFacts,
  nominalMs: ReadonlyMap<string, number>,
  calls: { readonly maxMs: number; readonly lockAll: boolean } = { maxMs: 5_000, lockAll: false },
): Reading {
  const random = generator(seed);
  const order = facts.blocks.filter(() => random() < 0.5 + 0.5 * random()).sort(() => random() - 0.5);
  let at = 0;
  const visits = order.map((block) => {
    const limit = block.seen?.kind === 'visible' ? TAP_SHARE * (nominalMs.get(block.id) ?? 0) : calls.maxMs;
    const length = Math.max(1, Math.floor(limit * (0.7 + 0.3 * random())));
    const visit = { blockId: block.id, from: at, to: at + length };
    at = visit.to + Math.floor(random() * 300);
    return visit;
  });
  const played = order.filter((block) => block.seen?.kind === 'interaction');
  return { visits, locked: played.filter(() => calls.lockAll || random() < 0.7).map((block) => block.id) };
}

describe('Qualifying a v2 reading (pure, from the labelled Orrin fixture)', () => {
  const { facts, nominalMs } = orrin();

  it('names the same coverage units in content and in evidence, for each version of the facts', () => {
    expect(ELIGIBLE_BY_FACTS_VERSION).toEqual({ 2: coverageLocatorTypes(2), 3: coverageLocatorTypes(3) });
    expect(facts.v).toBe(3);
  });

  it('qualifies a reader who takes each stop’s reading time and locks in every call', () => {
    const result = qualify(facts, walkthrough(facts, 2.5, true));
    expect(result).toMatchObject({ qualification: 'qualified', coverage: 1 });
    expect(result.q).toBeGreaterThanOrEqual(0.6);
  });

  it('qualifies a fast reader at 2.5 times the pace', () => {
    expect(qualify(facts, walkthrough(facts, 1.01, true)).qualification).toBe('qualified');
  });

  it('does not qualify the hardest tap: every dot in order, each just under its share, every call locked in', () => {
    const hardest: Reading = {
      visits: facts.blocks.map((block, index) => {
        const length = block.seen?.kind === 'visible' ? TAP_SHARE * (nominalMs.get(block.id) ?? 0) : 120_000;
        return { blockId: block.id, from: index * 130_000, to: index * 130_000 + Math.floor(length) };
      }),
      locked: facts.blocks.filter((block) => block.seen?.kind === 'interaction').map((block) => block.id),
    };
    const result = qualify(facts, hardest);
    expect(result.qualification).toBe('not_qualified');
    expect(result.q).toBeLessThan(0.6);
  });

  it('never qualifies a reader who plays every call for as long as they like but skips the prose: playing is not reading', () => {
    // Every call on screen for up to two minutes and locked in, every read stop under its share (or not visited).
    for (let seed = 0; seed < 500; seed += 1) {
      const trace = tapTrace(seed, facts, nominalMs, { maxMs: 120_000, lockAll: true });
      const result = qualify(facts, trace);
      expect(result.qualification, `seed ${String(seed)}`).not.toBe('qualified');
    }
    const everyCall: Reading = {
      visits: facts.blocks.map((block, index) => ({
        blockId: block.id,
        from: index * 130_000,
        to:
          index * 130_000 +
          (block.seen?.kind === 'visible' ? Math.floor(TAP_SHARE * (nominalMs.get(block.id) ?? 0)) : 120_000),
      })),
      locked: facts.blocks.filter((block) => block.seen?.kind === 'interaction').map((block) => block.id),
    };
    const result = qualify(facts, everyCall);
    expect(result).toMatchObject({ qualification: 'not_qualified', coverage: 0 });
  });

  it('qualifies a reader who reads all the prose and never locks in a call: not playing does not block reading', () => {
    const result = qualify(facts, walkthrough(facts, 2.5, false));
    expect(result).toMatchObject({ qualification: 'qualified', coverage: 1 });
    expect(result.q).toBeGreaterThanOrEqual(0.6);
  });

  it('never qualifies tapping through the spine: 500 generated traces, none gives a stop its reading time', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const result = qualify(facts, tapTrace(seed, facts, nominalMs));
      expect(result.qualification, `seed ${String(seed)}`).not.toBe('qualified');
      expect(result.q, `seed ${String(seed)}`).toBeLessThan(0.6);
    }
  });

  it('proves the check can fail: with v1’s half-second rule the same quick walk through qualifies', () => {
    const quick = walkthrough(facts, 0.999, false);
    const withV1Rule: ReadingFacts = {
      ...facts,
      blocks: facts.blocks.map(({ id, weight, type }) => ({ id, weight, type })),
    };
    expect(qualify(withV1Rule, quick).qualification).toBe('qualified');
    expect(qualify(facts, quick).qualification).not.toBe('qualified');
  });

  it('counts a call when locked in or revealed, never because it was on screen', () => {
    const call = facts.blocks.find((block) => block.seen?.kind === 'interaction');
    if (call === undefined) throw new Error('CI fixture has calls');
    const reading = (blocks: Reading['visits'], interactions: readonly string[]): ObservationRecord[] =>
      observations({ visits: blocks, locked: [] }).concat(
        interactions.map((interaction, index) => ({
          seq: 90 + index,
          sessionId: 's1',
          deviceSequence: 90 + index,
          instrumentationVersion: 1,
          body: { kind: 'scroll.block_interaction', blockId: call.id, interaction, atMs: 1 },
        })),
      );
    const onScreen = [{ blockId: call.id, from: 0, to: 60_000 }];
    const seen = (interactions: readonly string[]) =>
      summariseReading(reading(onScreen, interactions), facts, policy).seenBlocks.includes(call.id);
    expect(seen([])).toBe(false);
    expect(seen(['locked'])).toBe(true);
    expect(seen(['revealed'])).toBe(true);
    expect(seen(['option-selected'])).toBe(false);
  });
});

describe('The Seasons planet forms from a v2 Part 1 and two v1 parts (real PostgreSQL, labelled CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('scroll_v2_reading');
    await enableProductionScope(world.database.db);
  });
  afterAll(() => world.close());

  /** Reads a v2 Scroll the way the device reports it: each stop for its reading time, each call locked in. */
  async function readV2(person: FixturePerson, scroll: { assetId: string; revision: number }, quick: boolean) {
    const row = await world.database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', scroll.assetId)
      .where('revision', '=', scroll.revision)
      .executeTakeFirstOrThrow();
    const stored = ReadingFactsSchema.parse(row.reading_facts);
    const reading = walkthrough(stored, quick ? 0.5 : 2.5, !quick);
    const opened = await openActive(world.c, person, scroll);
    await activatedAgo(world.database.db, opened.exposureId, 30);
    const interactions = reading.locked.map((blockId): Pick<InteractionEvent, 'kind' | 'payload'> => ({
      kind: 'scroll.block_interaction',
      payload: { blockId, kind: 'locked', atMs: 1 },
    }));
    const coverageEvents = reading.visits.map((visit) => coverage([visit.blockId], visit.to - visit.from, visit.from));
    await world.c.ingestObservations(person.authority, {
      instrumentationVersion: 1,
      events: [
        ...coverageEvents.map((body) => event(opened, body)),
        ...interactions.map((body) => event(opened, body)),
        event(opened, dwell(...reading.visits.map((visit): [number, number] => [visit.from, visit.to]))),
      ],
    });
    const projected = await world.c.projectScrollReading({
      v: 1,
      universeId: person.universeId,
      privacyEpoch: 1,
      exposureId: opened.exposureId,
    });
    await world.c.projectActivity({
      v: 1,
      universeId: person.universeId,
      privacyEpoch: 1,
      exposureId: opened.exposureId,
    });
    return projected;
  }

  it('qualifies a full reading of the v2 Part 1, and a quick tap through it forms nothing', async () => {
    const { database, observe, snapshot } = world;
    const scrolls: { assetId: string; revision: number }[] = [];
    // Part 1 is a v2 Scroll as the plan makes it: produced, held, and served once an operator releases it (D-138).
    const part1 = fixtureProduction(
      database.db,
      () => answerWith(fixtureAuthoredV2()),
      () => fixtureResearchPageV2,
    );
    expect(await part1.produce('seasons', false, signal())).toMatchObject({
      outcome: 'published',
      held: true,
      revision: 1,
    });
    expect(
      await makeReviewGate(database.db).release({
        assetId: TOPICS.seasons.assetId,
        revision: 1,
        decidedBy: 'cli:ci-reviewer',
      }),
    ).toMatchObject({ kind: 'released' });
    scrolls.push({ assetId: TOPICS.seasons.assetId, revision: 1 });
    // Parts 2 and 3 stay v1 Scrolls here, to show a planet forms the same from a v2 part and v1 parts.
    for (const key of ['seasons-hemispheres', 'seasons-limits'] as const) {
      const recipe = TOPICS[key];
      const undo = markScrollV1(key);
      try {
        const production = fixtureProduction(database.db, () => answerWith(fixtureAuthored(writerFormatOf(recipe))));
        expect(await production.produce(key, false, signal())).toMatchObject({ outcome: 'published' });
      } finally {
        undo();
      }
      const row = await database.db
        .selectFrom('content.asset_revisions')
        .select('reading_facts')
        .where('asset_id', '=', recipe.assetId)
        .executeTakeFirstOrThrow();
      expect(ReadingFactsSchema.parse(row.reading_facts).v).toBe(2);
      scrolls.push({ assetId: recipe.assetId, revision: 1 });
    }

    // Tapping through Part 1 qualifies nothing, so nothing forms from it.
    const tapper = await seedPerson(database.db);
    expect(await readV2(tapper, scrolls[0]!, true)).toMatchObject({ kind: 'applied', qualification: 'not_qualified' });
    const kinds = async (person: FixturePerson) => {
      const result = await snapshot(person);
      return 'page' in result ? result.page.objects.map((place) => place.kind).sort() : [];
    };
    expect(await kinds(tapper)).toEqual([]);

    // Reading Part 1 to the end, then the two v1 parts, forms the planet exactly as three v1 Scrolls do.
    const reader = await seedPerson(database.db);
    expect(await readV2(reader, scrolls[0]!, false)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    const garbage = { kind: 'malformed' } as const;
    const cartograph = async () => {
      const runId = (await world.state(reader)).activeRunId;
      if (!runId) throw new Error('CI expected an active Cartographer run');
      await world.runner(reader, () => garbage).run(await world.job(reader, runId), signal());
    };
    await cartograph();
    expect(await kinds(reader)).toEqual([]);
    await observe(reader, { ...scrolls[1]!, blocks: await blockIds(scrolls[1]!.assetId) });
    await cartograph();
    expect(await kinds(reader)).toEqual(['star', 'system']);
    await observe(reader, { ...scrolls[2]!, blocks: await blockIds(scrolls[2]!.assetId) });
    await cartograph();
    expect(await kinds(reader)).toEqual(['planet', 'region', 'region', 'region', 'star', 'system']);
  });

  async function blockIds(assetId: string): Promise<string[]> {
    const row = await world.database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', assetId)
      .executeTakeFirstOrThrow();
    return ReadingFactsSchema.parse(row.reading_facts).blocks.map((block) => block.id);
  }
});
