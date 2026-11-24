import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import { beatsOfV3, beatWords, validateDocumentV3, WORDS_PER_MINUTE_V3 } from '@knowscroll/scroll-model';
import type { ReadingFacts } from '@knowscroll/backend/modules/content';
import { makeReviewGate } from '@knowscroll/backend/modules/content/nest-providers';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { ReadingFactsSchema } from '../../../packages/backend/src/modules/content/adapters/reading-facts-schema.js';
import { compileEditorialSourceV3 } from '../../../packages/backend/src/modules/content/adapters/scroll-compiler-v3.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import {
  SCROLL_QUALIFICATION_POLICY_V0,
  SCROLL_SHARED_QUALIFICATION_POLICY as shared,
} from '../../../packages/backend/src/modules/evidence/domain/policy.js';
import { qualifyScrollReading } from '../../../packages/backend/src/modules/evidence/domain/qualification.js';
import {
  summariseReading,
  type ObservationBody,
  type ObservationRecord,
} from '../../../packages/backend/src/modules/evidence/domain/reading-summary.js';
import { signal } from '../support/fixture-model.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { activatedAgo, dwell, event, openActive } from '../support/observations.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { markScrollV1 } from '../support/scroll-v2.js';
import { storeV2 } from '../support/stored-v2.js';
import { documentV3Source } from '../support/scroll.js';

/**
 * How a document v3 is read (#761, decision E1): a beat counts for its share of the time it was on screen, the moments
 * it shared with other beats divided between them by their words, so a screen of four beats does not qualify four beats
 * at once. The document is the hand-written seasons fixture (labelled authored CI data, no provider output).
 */
function seasons(): { readonly facts: ReadingFacts; readonly nominalMs: ReadonlyMap<string, number> } {
  const compiled = compileEditorialSourceV3(documentV3Source('seasons'), 1);
  if (compiled.kind !== 'compiled') throw new Error('the seasons fixture must compile');
  const admitted = validateDocumentV3(compiled.document);
  if (admitted.kind !== 'valid') throw new Error('the seasons fixture must validate');
  // What reading each beat's words takes at the document's pace, from the document and not from the facts under test.
  const nominalMs = new Map(
    beatsOfV3(admitted.document).map((beat) => [beat.id, (beatWords(beat) * 60_000) / WORDS_PER_MINUTE_V3] as const),
  );
  return { facts: compiled.readingFacts, nominalMs };
}

/** One screen: the beats on it together, for how long. Screens follow one another on one clock. */
interface Screen {
  readonly blockIds: readonly string[];
  readonly from: number;
  readonly to: number;
}

/** A reader who sees each beat alone on screen for `share` of the time its words take. */
function carefulReader(facts: ReadingFacts, nominalMs: ReadonlyMap<string, number>, share: number): Screen[] {
  let at = 0;
  return facts.blocks.map((block) => {
    const screen = { blockIds: [block.id], from: at, to: at + Math.round((nominalMs.get(block.id) ?? 0) * share) };
    at = screen.to + 100;
    return screen;
  });
}

/** A skimmer: `perScreen` beats on every screen, each screen held for `screenMs`. */
function skimmer(facts: ReadingFacts, perScreen: number, screenMs: number): Screen[] {
  const ids = facts.blocks.map((block) => block.id);
  const screens: Screen[] = [];
  for (let first = 0; first < ids.length; first += perScreen)
    screens.push({
      blockIds: ids.slice(first, first + perScreen),
      from: screens.length * (screenMs + 100),
      to: screens.length * (screenMs + 100) + screenMs,
    });
  return screens;
}

/**
 * The observations a reader's device would report for the screens, in intake order. `activeMs` adds active time on
 * top of the screens' own (a reader still in the article while looking at a figure, say), from the start.
 */
function observations(screens: readonly Screen[], activeMs = 0): ObservationRecord[] {
  const bodies: ObservationBody[] = [
    {
      kind: 'scroll.block_coverage',
      blocks: screens.flatMap((screen) =>
        screen.blockIds.map((blockId) => ({ blockId, intervalsMs: [[screen.from, screen.to]], peakFraction: 1 })),
      ),
    },
    {
      kind: 'scroll.active_dwell',
      activeIntervalsMs: [
        ...screens.map((screen): [number, number] => [screen.from, screen.to]),
        ...(activeMs > 0 ? [[0, activeMs] as [number, number]] : []),
      ],
    },
  ];
  return bodies.map((body, index) => ({
    seq: index + 1,
    sessionId: 's1',
    deviceSequence: index + 1,
    instrumentationVersion: 1,
    body,
  }));
}

const qualifyUnder = (policy: typeof shared, facts: ReadingFacts, screens: readonly Screen[], activeMs = 0) =>
  qualifyScrollReading(summariseReading(observations(screens, activeMs), facts, policy), policy);

describe('Qualifying a document v3 reading on the shared clock (pure, from the seasons fixture)', () => {
  const { facts, nominalMs } = seasons();

  it('is a reading of beats, twelve of them', () => {
    expect(facts.v).toBe(4);
    expect(facts.blocks).toHaveLength(12);
  });

  it('qualifies a careful reader who has each beat alone on screen for the time its words take', () => {
    const result = qualifyUnder(shared, facts, carefulReader(facts, nominalMs, 1));
    expect(result).toMatchObject({ qualification: 'qualified', coverage: 1 });
    expect(result.q).toBeGreaterThanOrEqual(0.6);
  });

  it('qualifies a fast reader who takes just over the 40 % of each beat’s time that counts it as read', () => {
    expect(qualifyUnder(shared, facts, carefulReader(facts, nominalMs, 0.45)).qualification).toBe('qualified');
  });

  it('does not qualify a reader who gives each beat less than 40 % of its words’ time', () => {
    const result = qualifyUnder(shared, facts, carefulReader(facts, nominalMs, 0.35));
    expect(result.qualification).toBe('not_qualified');
    expect(result.q).toBeLessThan(0.6);
  });

  it('does not qualify a skimmer: four beats on screen together, six seconds a screen', () => {
    const result = qualifyUnder(shared, facts, skimmer(facts, 4, 6_000));
    expect(result.qualification).toBe('not_qualified');
    expect(result.q).toBeLessThan(0.6);
  });

  it('does not qualify a skimmer who is active for the whole reading time but never has fewer than four beats on screen', () => {
    // Enough active time that dwell cannot be what fails the reading: only the shared clock keeps the coverage down.
    const screens = skimmer(facts, 4, 6_000);
    const result = qualifyUnder(shared, facts, screens, facts.estimatedReadingMs);
    // A sixth of a minute split four ways is under any beat's own minimum: no beat of the skim counts as seen.
    expect(result).toMatchObject({ qualification: 'not_qualified', dwellRatio: 1, coverage: 0 });
    expect(result.reasons).toContain('no_visibility');
  });

  it('proves the check can fail: with each beat earning the whole screen, that same skim would qualify', () => {
    // The per-unit clock gives every beat of a screen all six seconds, which clears each beat's own minimum. It is the
    // policy of v1 and v2 readings; a document v3 must never be read on it.
    const screens = skimmer(facts, 4, 6_000);
    expect(qualifyUnder(SCROLL_QUALIFICATION_POLICY_V0, facts, screens, facts.estimatedReadingMs)).toMatchObject({
      qualification: 'qualified',
      coverage: 1,
    });
  });

  it('counts a beat for its words’ share of a shared screen, so the heaviest beat of four keeps the most of it', () => {
    const [first, second, third, fourth] = facts.blocks.slice(0, 4);
    if (!first || !second || !third || !fourth) throw new Error('fixture shape');
    const screen = skimmer(facts, 4, 12_000).slice(0, 1);
    const summary = summariseReading(observations(screen), facts, shared);
    const weights = [first, second, third, fourth].map((block) => block.weight);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    // Each beat earns 12 s × weight / total; it is seen when that reaches its own minimum.
    const seen = [first, second, third, fourth].filter(
      (block) =>
        (12_000 * block.weight) / total >= Math.max(500, block.seen?.kind === 'visible' ? block.seen.minVisibleMs : 0),
    );
    expect(summary.seenBlocks.filter((id) => screen[0]?.blockIds.includes(id)).sort()).toEqual(
      seen.map((block) => block.id).sort(),
    );
  });
});

describe('The Seasons planet forms from a document v3 Part 1 and two v1 parts (real PostgreSQL, labelled CI fixtures)', () => {
  let world: GeographyWorld;
  const parts: { assetId: string; revision: number }[] = [];
  /** The Orrin v2 Part 1 of the same Seasons planet, kept beside the document v3 to show it is read as it was. */
  let v2Part: { assetId: string; revision: number };
  let v2HeadBefore: unknown;
  let v3: { assetId: string; revision: number };

  const unit = documentV3Source('seasons')['explanationUnitId'] as string;
  const topic = 'earth.seasons';
  const evidenceOf = (exposureId: string) =>
    world.database.db
      .selectFrom('evidence.encounter_evidence')
      .select(['policy_version', 'qualification', 'q', 'coverage'])
      .where('exposure_id', '=', exposureId)
      .orderBy('revision', 'desc')
      .executeTakeFirstOrThrow();
  /** Every coverage row the v2 Part 1 has, as stored: a change to its head would show here. */
  const coverageRowsOf = async (assetId: string) => ({
    heads: await world.database.db
      .selectFrom('content.coverage_heads')
      .selectAll()
      .where('asset_id', '=', assetId)
      .execute(),
    revisions: await world.database.db
      .selectFrom('content.coverage_revisions')
      .selectAll()
      .where('asset_id', '=', assetId)
      .execute(),
  });

  beforeAll(async () => {
    world = await geographyWorld('scroll_v3_reading');
    const { database } = world;
    await enableProductionScope(database.db);
    // Part 1 as a stored v2 Scroll, as the v2 reading test makes it: held, released by an operator (D-138).
    expect(await storeV2(database.db, 'seasons')).toMatchObject({ revision: 1 });
    expect(
      await makeReviewGate(database.db).release({
        assetId: TOPICS.seasons.assetId,
        revision: 1,
        decidedBy: 'cli:ci-reviewer',
      }),
    ).toMatchObject({ kind: 'released' });
    v2Part = { assetId: TOPICS.seasons.assetId, revision: 1 };
    v2HeadBefore = await coverageRowsOf(v2Part.assetId);
    // Parts 2 and 3 stay v1 Scrolls, as in the v2 test.
    for (const key of ['seasons-hemispheres', 'seasons-limits'] as const) {
      const undo = markScrollV1(key);
      try {
        const production = fixtureProduction(database.db, () =>
          answerWith(fixtureAuthored(writerFormatOf(TOPICS[key]))),
        );
        expect(await production.produce(key, false, signal())).toMatchObject({ outcome: 'published' });
      } finally {
        undo();
      }
      parts.push({ assetId: TOPICS[key].assetId, revision: 1 });
    }
    // The document v3 Part 1: admitted with its topic and beat coverage in one go.
    const imported = await world.c.importScroll(documentV3Source('seasons'));
    if (imported.kind !== 'imported') throw new Error(`the seasons fixture was refused: ${imported.reason}`);
    v3 = { assetId: imported.assetId, revision: imported.revision };
  });
  afterAll(() => world.close());

  async function factsOf(scroll: { assetId: string; revision: number }) {
    const row = await world.database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', scroll.assetId)
      .where('revision', '=', scroll.revision)
      .executeTakeFirstOrThrow();
    return ReadingFactsSchema.parse(row.reading_facts) as ReadingFacts;
  }

  /** Opens `scroll` for `person`, reports `screens` as the device would, projects the reading and its activity. */
  async function read(
    person: FixturePerson,
    scroll: { assetId: string; revision: number },
    screens: readonly Screen[],
    options: { readonly activeMs?: number; readonly locked?: readonly string[] } = {},
  ) {
    const opened = await openActive(world.c, person, scroll);
    await activatedAgo(world.database.db, opened.exposureId, 30);
    const coverageEvents = screens.map((screen): Pick<InteractionEvent, 'kind' | 'payload'> => ({
      kind: 'scroll.block_coverage',
      payload: {
        blocks: screen.blockIds.map((blockId) => ({
          blockId,
          intervalsMs: [[screen.from, screen.to]],
          peakFraction: 1,
        })),
      },
    }));
    const interactions = (options.locked ?? []).map((blockId): Pick<InteractionEvent, 'kind' | 'payload'> => ({
      kind: 'scroll.block_interaction',
      payload: { blockId, kind: 'locked', atMs: 1 },
    }));
    const dwellIntervals = [
      ...screens.map((screen): [number, number] => [screen.from, screen.to]),
      ...((options.activeMs ?? 0) > 0 ? [[0, options.activeMs ?? 0] as [number, number]] : []),
    ];
    await world.c.ingestObservations(person.authority, {
      instrumentationVersion: 1,
      events: [...coverageEvents, ...interactions, dwell(...dwellIntervals)].map((body) => event(opened, body)),
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
    return { opened, projected };
  }

  /** What the reader's coverage proves for the Seasons planet's two facets of this Scroll. */
  async function supportsOf(person: FixturePerson) {
    const result = await makeWithPersonalScope(world.database.db, { lockTimeoutMs: 5000 })(person.authority, (scope) =>
      world.c.readTrustedCoverage(scope, {
        probes: ['earth.seasons.axial-tilt', 'earth.seasons.limits'].map((facetId) => ({
          topicId: topic,
          facetId,
          explanationUnitId: unit,
        })),
      }),
    );
    if (result.kind !== 'entered') throw new Error('CI scope refused');
    return result.value;
  }

  it('stores the document v3 with facts v4, its topic and an active beat head, as the import made them', async () => {
    const facts = await factsOf(v3);
    expect(facts.v).toBe(4);
    const head = await world.database.db
      .selectFrom('content.coverage_revisions')
      .select(['status', 'mapping'])
      .where('asset_id', '=', v3.assetId)
      .executeTakeFirstOrThrow();
    expect(head.status).toBe('active');
    expect((head.mapping as unknown as { readingFactsVersion: number }).readingFactsVersion).toBe(4);
  });

  it('qualifies a careful read of every beat under the shared clock, and its binding is observed for both facets', async () => {
    const { nominalMs, facts } = seasons();
    const reader = await seedPerson(world.database.db);
    const { opened, projected } = await read(reader, v3, carefulReader(facts, nominalMs, 1));
    expect(projected).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await evidenceOf(opened.exposureId)).toMatchObject({
      policy_version: 'scroll-qualification.shared.v1',
      qualification: 'qualified',
    });
    const proof = await supportsOf(reader);
    expect(proof.supports.map((support) => support.facetId).sort()).toEqual([
      'earth.seasons.axial-tilt',
      'earth.seasons.limits',
    ]);
    expect(new Set(proof.supports.map((support) => support.explanationUnitId))).toEqual(new Set([unit]));
    expect(proof.witnesses.map((witness) => witness.exposureId)).toEqual([opened.exposureId, opened.exposureId]);
  });

  it('does not qualify a skimmer of four beats a screen, and nothing about the Scroll is supported for them', async () => {
    const { facts } = seasons();
    const skimmerPerson = await seedPerson(world.database.db);
    const { opened, projected } = await read(skimmerPerson, v3, skimmer(facts, 4, 6_000));
    expect(projected).toMatchObject({ kind: 'applied', qualification: 'not_qualified' });
    expect(await evidenceOf(opened.exposureId)).toMatchObject({
      policy_version: 'scroll-qualification.shared.v1',
      qualification: 'not_qualified',
    });
    expect((await supportsOf(skimmerPerson)).witnesses).toEqual([]);
    // The same skim with the reading time covered by active time still earns nothing: the clock, not dwell, decides.
    const patient = await seedPerson(world.database.db);
    const second = await read(patient, v3, skimmer(facts, 4, 6_000), { activeMs: facts.estimatedReadingMs });
    expect(second.projected).toMatchObject({ kind: 'applied', qualification: 'not_qualified' });
    expect((await supportsOf(patient)).witnesses).toEqual([]);
  });

  it('qualifies a careful read in a recorded session under the session label, and its retained witness is confirmed', async () => {
    const { nominalMs, facts } = seasons();
    const { database, c } = world;
    const reader = await seedPerson(database.db);
    // Recording is paused and resumed, so the reading belongs to generation 3: a recorded session, not the original
    // (legacy) clock domain.
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (const [expectedRecordingGeneration, on] of [
      [1, false],
      [2, true],
    ] as const)
      expect(
        await policy.set(reader.authority, {
          version: 'recording-policy.v1',
          commandId: randomUUID(),
          expectedPrivacyEpoch: 1,
          expectedRecordingGeneration,
          on,
        }),
      ).toMatchObject({ kind: 'ok' });
    const opened = await openActive(c, reader, v3, { activate: false });
    const sessionId = randomUUID();
    expect(
      await c.activateExposure(reader.authority, {
        commandId: sessionId,
        exposureId: opened.exposureId,
        recordingGeneration: 3,
      }),
    ).toMatchObject({ kind: 'activated' });
    // A real reading of this length needs real time: backdate the activation and the session's server start, the two
    // clocks the intake bounds an honest claim by. The session row is immutable by trigger, so the fixture lifts that
    // one guard for its own update, on this disposable database, and restores it.
    await activatedAgo(database.db, opened.exposureId, 30);
    await database.db.transaction().execute(async (trx) => {
      await sql`alter table evidence.recording_sessions disable trigger recording_session_guard`.execute(trx);
      await sql`update evidence.recording_sessions set server_started_at = now() - interval '30 minutes'
        where universe_id = ${reader.universeId}::uuid and exposure_id = ${opened.exposureId}::uuid`.execute(trx);
      await sql`alter table evidence.recording_sessions enable trigger recording_session_guard`.execute(trx);
    });
    const screens = carefulReader(facts, nominalMs, 1);
    const bodies = [
      ...screens.map((screen): Pick<InteractionEvent, 'kind' | 'payload'> => ({
        kind: 'scroll.block_coverage',
        payload: {
          blocks: screen.blockIds.map((blockId) => ({
            blockId,
            intervalsMs: [[screen.from, screen.to]],
            peakFraction: 1,
          })),
        },
      })),
      dwell(...screens.map((screen): [number, number] => [screen.from, screen.to])),
    ];
    expect(
      await c.ingestObservations(reader.authority, {
        version: 'observation-batch.v2',
        recordingGeneration: 3,
        instrumentationVersion: 1,
        events: bodies.map((body) => event(opened, body, { sessionId })),
      }),
    ).toMatchObject({ kind: 'ingested', accepted: bodies.length, rejected: 0 });
    const job = {
      v: 2 as const,
      recordingGeneration: 3,
      universeId: reader.universeId,
      privacyEpoch: 1,
      exposureId: opened.exposureId,
    };
    expect(await c.projectScrollReading(job)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await c.projectActivity(job)).toMatchObject({ kind: 'applied' });
    expect(await evidenceOf(opened.exposureId)).toMatchObject({
      policy_version: 'scroll-qualification.shared.recording.v1',
      qualification: 'qualified',
    });

    // Reading the trusted coverage again runs the retained-witness check on the session certificate: a witness it
    // cannot confirm is left out, so both facets standing is the confirmation.
    const proof = await supportsOf(reader);
    expect(proof.supports.map((support) => support.facetId).sort()).toEqual([
      'earth.seasons.axial-tilt',
      'earth.seasons.limits',
    ]);
    expect(proof.witnesses).toHaveLength(2);
    for (const witness of proof.witnesses)
      expect(witness).toMatchObject({ exposureId: opened.exposureId, sourceKind: 'segment', recordingGeneration: 3 });
  });

  it('keeps qualifying a v2 reading in the same database under its old policy, and leaves the v2 heads as they were', async () => {
    const facts = await factsOf(v2Part);
    // Each stop for 2.5 times its own minimum, one after another, every call locked in: the v2 test's careful reader.
    let at = 0;
    const screens = facts.blocks.map((block): Screen => {
      const length = block.seen?.kind === 'visible' ? Math.round(block.seen.minVisibleMs * 2.5) : 10_000;
      const screen = { blockIds: [block.id], from: at, to: at + length };
      at = screen.to + 100;
      return screen;
    });
    const locked = facts.blocks.filter((block) => block.seen?.kind === 'interaction').map((block) => block.id);
    const reader = await seedPerson(world.database.db);
    const { opened, projected } = await read(reader, v2Part, screens, { locked });
    expect(facts.v).toBe(3);
    expect(projected).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    const stored = await evidenceOf(opened.exposureId);
    expect(stored.qualification).toBe('qualified');
    expect(stored.qualification).toBe('qualified');
    // The label of the per-unit clock a v2 reading has always had, not the shared clock's.
    expect(stored.policy_version).toBe('scroll-qualification.v0');
    expect(await coverageRowsOf(v2Part.assetId)).toEqual(v2HeadBefore);
  });

  it('forms the planet and its regions from a careful read of the document v3 and the two v1 parts, and nothing from a skim', async () => {
    const { facts, nominalMs } = seasons();
    const { snapshot, observe } = world;
    const kinds = async (person: FixturePerson) => {
      const result = await snapshot(person);
      return 'page' in result ? result.page.objects.map((place) => place.kind).sort() : [];
    };
    const blockIds = async (scroll: { assetId: string; revision: number }) =>
      (await factsOf(scroll)).blocks.map((block) => block.id);

    const tapper = await seedPerson(world.database.db);
    await read(tapper, v3, skimmer(facts, 4, 6_000));
    expect(await kinds(tapper)).toEqual([]);

    const reader = await seedPerson(world.database.db);
    expect((await read(reader, v3, carefulReader(facts, nominalMs, 1))).projected).toMatchObject({
      qualification: 'qualified',
    });
    const garbage = { kind: 'malformed' } as const;
    const cartograph = async () => {
      const runId = (await world.state(reader)).activeRunId;
      if (!runId) throw new Error('CI expected an active Cartographer run');
      await world.runner(reader, () => garbage).run(await world.job(reader, runId), signal());
    };
    await cartograph();
    expect(await kinds(reader)).toEqual([]);
    await observe(reader, { ...parts[0]!, blocks: await blockIds(parts[0]!) });
    await cartograph();
    expect(await kinds(reader)).toEqual(['star', 'system']);
    await observe(reader, { ...parts[1]!, blocks: await blockIds(parts[1]!) });
    await cartograph();
    expect(await kinds(reader)).toEqual(['planet', 'region', 'region', 'region', 'star', 'system']);
  });
});
