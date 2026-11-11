import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithDryRunPersonalScope, readPersonalRecordingNow } from '@knowscroll/backend/infrastructure/postgres';
import { makeGeographyDryRun, makeSettleQuiet } from '@knowscroll/backend/modules/geography/nest-providers';
import { recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { signal } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';
import { dryRunsWithClock, footprintOf, workerDryRuns } from '../support/dry-run.js';

/**
 * `geography dry-run` (#674, D-411): what a Cartographer run would do, read-only. It freezes the context the run freezes and
 * applies the same rules, and says what the run would record in the codes the run records, so its report matches what a real
 * run then records. Most cases run through the worker's own wiring (`dryRunsFor`), as `operator.js` does. Reading, sources and
 * the model's answers are authored CI fixtures; the dry run calls no model.
 */
const DAY = 86_400_000;
const garbage: FixtureScenario = { kind: 'malformed' };
const PRIVATE_WORDS = ['Seasons', 'earth.seasons', 'axial', 'hemispheres', 'ci-geography-unit', 'support:'];

describe('the Cartographer dry run (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('geography_dry_run');
  });
  afterAll(() => world.close());

  const dry = () => workerDryRuns(world).geography;

  /** Runs the person's active Cartographer run once; the fixture model answers nothing usable. */
  async function cartograph(person: FixturePerson) {
    const runId = (await world.state(person)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    const run = world.runner(person, () => garbage);
    await run.run(await world.job(person, runId), signal());
    const recorded = await world.database.db
      .selectFrom('geography.runs')
      .select(['status', 'outcome'])
      .where('universe_id', '=', person.universeId)
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    return { ...recorded, calls: run.model.calls.length };
  }
  async function reportOf(person: FixturePerson, run = dry()) {
    const result = await run(person.universeId);
    if (result.kind !== 'read') throw new Error(`CI expected a read, got ${result.refusal}`);
    return result.report;
  }
  const placeKinds = async (person: FixturePerson) => {
    const universe = await world.snapshot(person);
    return universe.status === 'ready' ? universe.page.objects.map((place) => place.kind).sort() : [];
  };

  it('works for a reader with no coverage reference, names it as a run records it, and writes nothing', async () => {
    const person = await seedPerson(world.database.db);
    const before = await footprintOf(world, person.universeId);
    const report = await reportOf(person);
    expect(report).toMatchObject({
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'no_support_yet' },
      wouldCallModel: false,
      places: 0,
      routes: 0,
      references: { candidateKeys: null, witnessesHeld: null, supportKeys: null, supportsKept: null },
      due: { total: 0, appliedByNextRun: 0 },
      contextBytes: null,
    });
    expect(await footprintOf(world, person.universeId)).toEqual(before);
    // An explicit request for a reader with nothing read starts a run, which settles on exactly that code.
    expect(await world.request(person.authority, { commandId: randomUUID() })).toMatchObject({ kind: 'accepted' });
    const recorded = await cartograph(person);
    expect(recorded).toMatchObject({ ...report.wouldRecord, calls: 0 });
  });

  it('says a reader with one unit settles with no changes, and a real run then records exactly that', async () => {
    const person = await seedPerson(world.database.db);
    await world.observe(person, await world.fixture(undefined, topic, [facet]));
    const before = await footprintOf(world, person.universeId);
    const report = await reportOf(person);
    expect(report).toMatchObject({
      trigger: 'reading',
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'no_changes' },
      wouldCallModel: false,
      references: { candidateKeys: 1, witnessesHeld: 1, supportKeys: 1, supportsKept: 1, supportsDropped: 0 },
      due: { system: 0, star: 0, planet: 0, region: 0, total: 0 },
      activityChanges: { toQuiet: 0, toActive: 0 },
    });
    expect(report.contextBytes).toBeGreaterThan(1000);
    expect(report.modelItems).toBeGreaterThan(0);
    // Nothing moved: no row, no revision, no job, no ledger run.
    expect(await footprintOf(world, person.universeId)).toEqual(before);
    const recorded = await cartograph(person);
    expect(recorded).toMatchObject({ ...report.wouldRecord, calls: 0 });
  });

  it('says a reader with two units calls the model for a system and its star, and the real run forms exactly those', async () => {
    const person = await seedPerson(world.database.db);
    await world.observe(person, await world.fixture(undefined, topic, [facet]));
    await cartograph(person);
    await world.observe(person, await world.fixture(undefined, topic, [otherFacet]));
    const before = await footprintOf(world, person.universeId);
    const report = await reportOf(person);
    expect(report).toMatchObject({
      action: 'calls_model',
      wouldCallModel: true,
      wouldRecord: { status: 'accepted', outcome: null },
      references: { candidateKeys: 2, supportKeys: 2, supportsKept: 2 },
      due: { system: 1, star: 1, planet: 0, region: 0, total: 2, appliedByNextRun: 2 },
    });
    expect(await footprintOf(world, person.universeId)).toEqual(before);
    expect(await placeKinds(person)).toEqual([]);
    // The real run asks the (fixture) model, which gives nothing usable even after the repair, so the rules apply what is due.
    const recorded = await cartograph(person);
    expect(recorded).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    expect(recorded.calls).toBeGreaterThan(0);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
  });

  it('counts a planet and its regions as due when three units cover two facets, by kind', async () => {
    const person = await seedPerson(world.database.db);
    for (const facetId of [facet, otherFacet, facet])
      await world.observe(person, await world.fixture(undefined, topic, [facetId]));
    const report = await reportOf(person);
    expect(report.due).toEqual({ system: 1, star: 1, planet: 1, region: 2, total: 5, appliedByNextRun: 5 });
    expect(report.references).toMatchObject({
      candidateKeys: 3,
      supportKeys: 3,
      supportsKept: 3,
      supportsDropped: 0,
    });
    await cartograph(person);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    // Everything formed: nothing is due now.
    expect(await reportOf(person)).toMatchObject({
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'no_changes' },
      due: { total: 0 },
      places: 5,
    });
  });

  it('reports the activity changes a month of silence makes due, which the quiet settle then applies', async () => {
    const person = await seedPerson(world.database.db);
    await world.coherent(person);
    await cartograph(person);
    const later = dryRunsWithClock(world, { now: () => new Date(Date.now() + 31 * DAY) }).geography;
    const report = await reportOf(person, later);
    expect(report).toMatchObject({
      action: 'applies_rules',
      wouldRecord: { status: 'accepted', outcome: 'applied_by_rules' },
      wouldCallModel: false,
      due: { total: 0 },
      activityChanges: { toQuiet: 5, toActive: 0 },
    });
    const settle = makeSettleQuiet({ ...world.base, now: () => new Date(Date.now() + 31 * DAY), enabled: () => true });
    expect(await settle({ v: 1, universeId: person.universeId, privacyEpoch: 1, recordingGeneration: 1 })).toEqual({
      outcome: 'applied',
      changed: report.activityChanges.toQuiet,
    });
  });

  it('gives the same report through the worker’s wiring as through the hand-composed ports', async () => {
    const person = await seedPerson(world.database.db);
    await world.coherent(person);
    expect(await reportOf(person, dryRunsWithClock(world).geography)).toEqual(await reportOf(person));
  });

  it('names the switch when the role is off, and the pause when recording is paused', async () => {
    const person = await seedPerson(world.database.db);
    await world.coherent(person);
    expect(await reportOf(person, workerDryRuns(world, { enabled: false }).geography)).toMatchObject({
      action: 'stops',
      roleEnabled: false,
      wouldRecord: { status: 'insufficient', outcome: 'disabled' },
      // The counts are still read, so an operator sees what the role would do once it is on.
      due: { total: 5 },
    });
    const policy = recordingPolicyFor(world.database.db, { lockTimeoutMs: 5000 });
    await policy.set(person.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: 1,
      on: false,
    });
    expect(await reportOf(person)).toMatchObject({ action: 'recording_paused', wouldRecord: null, places: null });
  });

  it('refuses a universe that is missing or suspended, and finds the epoch of one that was cleared', async () => {
    expect(await dry()(randomUUID())).toEqual({ kind: 'refused', refusal: 'universe_missing' });
    const suspended = await seedPerson(world.database.db);
    await world.database.db
      .updateTable('identity.universes')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.universeId)
      .execute();
    expect(await dry()(suspended.universeId)).toEqual({ kind: 'refused', refusal: 'universe_suspended' });
    const later = await seedPerson(world.database.db, { privacyEpoch: 4 });
    expect(await reportOf(later)).toMatchObject({ wouldRecord: { outcome: 'no_support_yet' } });
  });

  it('prints counts and codes only: no label, topic, unit or reference', async () => {
    const person = await seedPerson(world.database.db);
    await world.coherent(person);
    const report = await reportOf(person);
    const text = JSON.stringify(report);
    for (const word of PRIVATE_WORDS) expect(text).not.toContain(word);
    expect(text).not.toContain(person.universeId);
    expect(text).not.toContain(person.accountId);
    // Every value is a number, a boolean, a null or a code of the fixed vocabulary.
    const walk = (value: unknown): unknown[] =>
      value !== null && typeof value === 'object' ? Object.values(value).flatMap(walk) : [value];
    for (const leaf of walk(report))
      expect(['number', 'boolean', 'string'].includes(typeof leaf) || leaf === null).toBe(true);
    for (const leaf of walk(report).filter((leaf): leaf is string => typeof leaf === 'string'))
      expect(leaf).toMatch(/^[a-z_]+$/);
  });

  it('cannot use the trusted read that takes content row locks, which a READ ONLY transaction refuses: why the dry run rechecks without them', async () => {
    const person = await seedPerson(world.database.db);
    await world.observe(person, await world.fixture(undefined, topic, [facet]));
    const locking = makeGeographyDryRun({
      ...world.base,
      withScope: makeWithDryRunPersonalScope(world.database.db, { lockTimeoutMs: 5000 }),
      readRecordingNow: readPersonalRecordingNow,
      enabled: () => true,
    });
    await expect(locking(person.universeId)).rejects.toMatchObject({ code: '25006' });
  });

  it('leaves every row alone even when a heavy reader is read', async () => {
    const person = await seedPerson(world.database.db);
    await world.coherent(person);
    await cartograph(person);
    const before = await footprintOf(world, person.universeId);
    const objects = await sql<{
      payload: unknown;
    }>`select payload from geography.objects where universe_id = ${person.universeId}::uuid order by id`.execute(
      world.database.db,
    );
    await reportOf(person);
    await reportOf(person);
    expect(await footprintOf(world, person.universeId)).toEqual(before);
    expect(
      (
        await sql<{
          payload: unknown;
        }>`select payload from geography.objects where universe_id = ${person.universeId}::uuid order by id`.execute(
          world.database.db,
        )
      ).rows,
    ).toEqual(objects.rows);
  });

  it('gives the Planner’s dry run, through the same wiring, counts of what reading made, and writes nothing', async () => {
    const planner = () => workerDryRuns(world).planner;
    const person = await seedPerson(world.database.db);
    const none = await planner()(person.universeId);
    expect(none).toMatchObject({
      kind: 'read',
      report: { outcome: 'insufficient_evidence', evidence: 0, wouldCallModel: false },
    });
    await world.coherent(person);
    const before = await footprintOf(world, person.universeId);
    const result = await planner()(person.universeId);
    if (result.kind !== 'read') throw new Error('CI expected a read');
    expect(result.report).toMatchObject({
      outcome: 'calls_model',
      wouldCallModel: true,
      topics: 1,
      evidence: 3,
      intentTopics: 0,
      roleEnabled: true,
    });
    expect(result.report.contextBytes).toBeGreaterThan(1000);
    expect(await footprintOf(world, person.universeId)).toEqual(before);
    expect(JSON.stringify(result.report)).not.toContain('earth.seasons');
  });
});
