import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallLockRequest } from '@knowscroll/contracts';
import { exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PlayUseCases } from '@knowscroll/backend/modules/play';
import type { ReadingFacts } from '@knowscroll/backend/modules/content';
import { makeReviewGate, readScrollPlayFacts } from '@knowscroll/backend/modules/content/nest-providers';
import {
  fixtureAuthoredV2,
  fixtureResearchPageV2,
} from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { writerFormatOf } from '../../../packages/backend/src/modules/content/production/writer.js';
import { ReadingFactsSchema } from '../../../packages/backend/src/modules/content/adapters/reading-facts-schema.js';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { answerWith, enableProductionScope, fixtureAuthored, fixtureProduction } from '../support/generated-scroll.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { callsOfRevision, picks, playFor } from '../support/play.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { scrollUseCases } from '../support/scroll.js';
import { markScrollV1 } from '../support/scroll-v2.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

/**
 * The play layer (D-063, D-064, D-180 to D-182) against a real PostgreSQL 16 database: locking a Call
 * it of the labelled Orrin Scroll, what is kept, what refuses, how Clear and export treat it, and
 * that it cannot change what reading does. The document is the authored CI fixture, never provider
 * output or product content.
 */
type Scroll = { readonly assetId: string; readonly revision: number };

/**
 * Publishes the Orrin fixture as the v2 revision of the `seasons` recipe, as production does: stored
 * held (D-138), then released by an operator. Until then no one can open it, and its calls read as
 * absent to play.
 */
async function publishOrrin(db: Parameters<typeof fixtureProduction>[0]): Promise<Scroll> {
  const production = fixtureProduction(
    db,
    () => answerWith(fixtureAuthoredV2()),
    () => fixtureResearchPageV2,
  );
  expect(await production.produce('seasons', false, signal())).toMatchObject({
    outcome: 'published',
    held: true,
    revision: 1,
  });
  const scroll = { assetId: TOPICS.seasons.assetId, revision: 1 };
  const held = await makeWithPersonalScope(db, { lockTimeoutMs: 5_000 })((await seedPerson(db)).authority, (scope) =>
    readScrollPlayFacts(scope, scroll.assetId, scroll.revision),
  );
  expect(held).toEqual({ kind: 'entered', value: undefined });
  expect(await makeReviewGate(db).release({ ...scroll, decidedBy: 'cli:ci-reviewer' })).toMatchObject({
    kind: 'released',
  });
  return scroll;
}

describe('Locking a Call it (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let play: PlayUseCases;
  let c: Awaited<ReturnType<typeof scrollUseCases>>;
  let boss: ReturnType<typeof createBoss>;
  let scroll: Scroll;
  let calls: Awaited<ReturnType<typeof callsOfRevision>>;
  const callIt = () => calls.filter((call) => call.kind === 'call_it');
  const finalCall = () => calls.find((call) => call.kind === 'final_call')!;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('play');
    await enableProductionScope(database.db);
    scroll = await publishOrrin(database.db);
    calls = await callsOfRevision(database, scroll);
    c = await scrollUseCases(database, { recording: true });
    play = playFor(database);
    boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await c.close();
    await database.drop();
  });

  /** A person who has opened and activated the Scroll. */
  async function reader() {
    const person = await recordingPerson(database);
    await openActive(c, person, scroll);
    return person;
  }
  const lock = (
    person: FixturePerson,
    call: { readonly id: string },
    option: number,
    over: Partial<CallLockRequest> = {},
  ) =>
    play.lockCall(person.authority, {
      commandId: randomUUID(),
      assetId: scroll.assetId,
      revision: scroll.revision,
      stopId: call.id,
      option,
      recordingGeneration: 1,
      ...over,
    });
  const rows = async (person: FixturePerson) => ({
    landmarks: (
      await sql<{
        n: number;
      }>`select count(*)::int as n from play.landmarks where universe_id = ${person.universeId}::uuid`.execute(
        database.db,
      )
    ).rows[0]!.n,
    calls: (
      await sql<{
        n: number;
      }>`select count(*)::int as n from play.calls where universe_id = ${person.universeId}::uuid`.execute(database.db)
    ).rows[0]!.n,
    results: (
      await sql<{
        n: number;
      }>`select count(*)::int as n from play.scroll_results where universe_id = ${person.universeId}::uuid`.execute(
        database.db,
      )
    ).rows[0]!.n,
  });
  const pause = (person: FixturePerson, generation = 2) =>
    sql`update identity.universes set recording_on = false, recording_generation = ${generation} where id = ${person.universeId}::uuid`.execute(
      database.db,
    );
  const resume = (person: FixturePerson, generation = 3) =>
    sql`update identity.universes set recording_on = true, recording_generation = ${generation} where id = ${person.universeId}::uuid`.execute(
      database.db,
    );

  it('judges a pick on the server from the stored revision, and counts a spark for a right one only', async () => {
    const person = await reader();
    const [first, second] = callIt();
    const right = await lock(person, first!, picks(first!).right);
    expect(right).toMatchObject({
      kind: 'saved',
      outcome: { recorded: true, correct: true, newlyLocked: true, replayed: false, results: { sparks: 1, combo: 1 } },
    });
    const wrong = await lock(person, second!, picks(second!).wrong);
    expect(wrong).toMatchObject({
      kind: 'saved',
      outcome: {
        correct: false,
        results: { sparks: 1, combo: 0, calls: [{ stopId: first!.id }, { stopId: second!.id }] },
      },
    });
    const stored = await sql<{ stop_id: string; option: number; correct: boolean }>`
      select stop_id, option, correct from play.calls where universe_id = ${person.universeId}::uuid order by lock_seq`.execute(
      database.db,
    );
    expect(stored.rows).toEqual([
      { stop_id: first!.id, option: picks(first!).right, correct: true },
      { stop_id: second!.id, option: picks(second!).wrong, correct: false },
    ]);
  });

  it('is idempotent by command ID: a retry answers the stored lock and writes nothing', async () => {
    const person = await reader();
    const [first] = callIt();
    const request = { commandId: randomUUID() };
    const once = await lock(person, first!, picks(first!).wrong, request);
    const before = await rows(person);
    const again = await lock(person, first!, picks(first!).wrong, request);
    expect(once).toMatchObject({ kind: 'saved', outcome: { replayed: false, correct: false } });
    expect(again).toMatchObject({ kind: 'saved', outcome: { replayed: true, correct: false, newlyLocked: true } });
    expect(await rows(person)).toEqual(before);
    // The same command for another pick is refused, not applied.
    expect(await lock(person, first!, picks(first!).right, request)).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
  });

  it('lets the first lock of a call stand, whatever a later command says', async () => {
    const person = await reader();
    const [first] = callIt();
    await lock(person, first!, picks(first!).wrong);
    const second = await lock(person, first!, picks(first!).right);
    expect(second).toMatchObject({
      kind: 'saved',
      outcome: { option: picks(first!).wrong, correct: false, newlyLocked: false, results: { sparks: 0, combo: 0 } },
    });
    expect((await rows(person)).calls).toBe(1);
  });

  it('refuses a forged option of any call, a stop that is not a call and another revision, and stores nothing', async () => {
    const person = await reader();
    const [first] = callIt();
    const final = finalCall();
    expect(await lock(person, first!, first!.options.length)).toEqual({ kind: 'refused', reason: 'option_invalid' });
    expect(await lock(person, final, final.options.length)).toEqual({ kind: 'refused', reason: 'option_invalid' });
    expect(await lock(person, { id: 'not-a-stop' }, 0)).toEqual({ kind: 'refused', reason: 'call_not_found' });
    // A read stop is not a call.
    expect(await lock(person, { id: 's1' }, 0)).toEqual({ kind: 'refused', reason: 'call_not_found' });
    expect(await lock(person, first!, 0, { revision: 2 })).toEqual({ kind: 'refused', reason: 'exposure_required' });
    expect(await rows(person)).toEqual({ landmarks: 0, calls: 0, results: 0 });
  });

  it("refuses a revision the person has no activated exposure to, and another person's exposure does not count", async () => {
    const [first] = callIt();
    const reads = await reader();
    await lock(reads, first!, 0);
    const stranger = await recordingPerson(database);
    expect(await lock(stranger, first!, 0)).toEqual({ kind: 'refused', reason: 'exposure_required' });
    // Opened but never activated: the article was not the reading surface, so there is nothing to play.
    const opened = await recordingPerson(database);
    await openActive(c, opened, scroll, { activate: false });
    expect(await lock(opened, first!, 0)).toEqual({ kind: 'refused', reason: 'exposure_required' });
    expect(await rows(stranger)).toEqual({ landmarks: 0, calls: 0, results: 0 });
    expect(await rows(opened)).toEqual({ landmarks: 0, calls: 0, results: 0 });
  });

  it('gives back the same results after a reload, to its owner only', async () => {
    const person = await reader();
    const [first, second] = callIt();
    await lock(person, first!, picks(first!).right);
    await lock(person, second!, picks(second!).wrong);
    const expected = {
      assetId: scroll.assetId,
      revision: scroll.revision,
      calls: [
        { stopId: first!.id, option: picks(first!).right, correct: true },
        { stopId: second!.id, option: picks(second!).wrong, correct: false },
      ],
      sparks: 1,
      combo: 0,
    };
    // A fresh set of use cases is what a new request sees.
    expect(
      await playFor(database).readResults(person.authority, { assetId: scroll.assetId, revision: scroll.revision }),
    ).toEqual({
      kind: 'results',
      results: expected,
    });
    const other = await reader();
    expect(await play.readResults(other.authority, { assetId: scroll.assetId, revision: scroll.revision })).toEqual({
      kind: 'results',
      results: { ...expected, calls: [], sparks: 0, combo: 0 },
    });
  });

  it('saves nothing while recording is paused, says so, and still reads what was saved before', async () => {
    const person = await reader();
    const [first, second] = callIt();
    await lock(person, first!, picks(first!).right);
    const before = await rows(person);
    await pause(person);
    expect(await lock(person, second!, picks(second!).right, { recordingGeneration: 2 })).toEqual({
      kind: 'not_saved',
      outcome: { recorded: false, reason: 'recording_paused', currentGeneration: 2 },
    });
    expect(await rows(person)).toEqual(before);
    const receipts = await sql<{
      n: number;
    }>`select count(*)::int as n from receipts.personal_commands where universe_id = ${person.universeId}::uuid and operation = 'play.call-lock'`.execute(
      database.db,
    );
    expect(receipts.rows[0]!.n).toBe(1);
    expect(
      await play.readResults(person.authority, { assetId: scroll.assetId, revision: scroll.revision }),
    ).toMatchObject({
      kind: 'results',
      results: { sparks: 1, calls: [{ stopId: first!.id }] },
    });
    // Resumed, a client that did not read the policy again is told to, and a current one is saved.
    await resume(person);
    expect(await lock(person, second!, picks(second!).right, { recordingGeneration: 2 })).toEqual({
      kind: 'not_saved',
      outcome: { recorded: false, reason: 'recording_generation_stale', currentGeneration: 3 },
    });
    expect(await lock(person, second!, picks(second!).right, { recordingGeneration: 3 })).toMatchObject({
      kind: 'saved',
      outcome: { correct: true, results: { sparks: 2, combo: 2 } },
    });
  });

  it('is erased by Clear, and an export lists it in words with no identifier', async () => {
    const person = await reader();
    const [first, second] = callIt();
    await lock(person, first!, picks(first!).right);
    await lock(person, second!, picks(second!).wrong);
    const final = finalCall();
    await lock(person, final, picks(final).wrong);
    const exported = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scopeTx) =>
      exportCurrentPerson(scopeTx, { accountId: person.accountId }, openToEveryone),
    );
    if (exported.kind !== 'entered') throw new Error('export refused');
    const section = exported.value.sections.play as {
      scrolls: {
        items: {
          title?: string;
          sparks: number;
          combo: number;
          calls: { question?: string; picked?: string; right: boolean }[];
        }[];
      };
      landmarks: { items: { name: string; finish: string; earnedAt: string; scroll?: string }[] };
    };
    expect(section.scrolls.items).toHaveLength(1);
    const [item] = section.scrolls.items;
    expect(item).toMatchObject({ title: 'Why Orrin has summers and winters', sparks: 1, combo: 0 });
    expect(item!.calls.map((call) => [call.question, call.picked, call.right])).toEqual([
      [final.prompt, final.options[picks(final).wrong], false],
      [second!.prompt, second!.options[picks(second!).wrong], false],
      [first!.prompt, first!.options[picks(first!).right], true],
    ]);
    // The landmark is listed in words: its name, its finish, the day, and the Scroll it came from.
    expect(section.landmarks.items).toEqual([
      {
        name: LEANING_AXIS.name,
        finish: 'plain',
        earnedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) as string,
        scroll: 'Why Orrin has summers and winters',
      },
    ]);
    expect(JSON.stringify(section)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(JSON.stringify(section)).not.toContain(LEANING_AXIS.key);
    expect(await rows(person)).toEqual({ landmarks: 1, calls: 3, results: 1 });

    await clearRecordingPerson(database, boss, person);
    expect(await rows(person)).toEqual({ landmarks: 0, calls: 0, results: 0 });
    const fresh = { ...person.authority, privacyEpoch: person.authority.privacyEpoch + 1 };
    expect(await play.readResults(fresh, { assetId: scroll.assetId, revision: scroll.revision })).toMatchObject({
      kind: 'results',
      results: { calls: [], sparks: 0, combo: 0 },
    });
    expect(await play.readLandmarks(fresh)).toEqual({ kind: 'landmarks', landmarks: [] });
  });
});

describe('The stored tally bounds of a Scroll (migration 0077, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let scroll: Scroll;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('play_bounds');
    await enableProductionScope(database.db);
    scroll = await publishOrrin(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  /** One row for a person of its own, so the primary key never stands in the way of the check. */
  async function store(tally: { calls: number; sparks: number; combo: number }) {
    const person = await recordingPerson(database);
    await sql`
      insert into play.scroll_results (universe_id, privacy_epoch, asset_id, revision, calls_locked, sparks, combo)
      values (${person.universeId}::uuid, 1, ${scroll.assetId}::uuid, ${scroll.revision}, ${tally.calls}, ${tally.sparks}, ${tally.combo})`.execute(
      database.db,
    );
  }
  const CHECK_VIOLATION = { code: '23514' };

  it('holds the most a Scroll can earn: four calls, five sparks (three Call its and a doubled Final call) and a combo of four', async () => {
    await store({ calls: 4, sparks: 5, combo: 4 });
    // The tallies the rule can really produce all fit.
    await store({ calls: 4, sparks: 4, combo: 4 });
    await store({ calls: 4, sparks: 3, combo: 0 });
    await store({ calls: 0, sparks: 0, combo: 0 });
  });

  it('refuses a tally the rule cannot produce: a sixth spark, a fifth in a row, more sparks than calls and a bonus, a run longer than the sparks', async () => {
    await expect(store({ calls: 4, sparks: 6, combo: 4 })).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(store({ calls: 4, sparks: 5, combo: 5 })).rejects.toMatchObject(CHECK_VIOLATION);
    // Five sparks need the doubled Final call, which needs a combo of two before it: four calls at least.
    await expect(store({ calls: 3, sparks: 5, combo: 3 })).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(store({ calls: 4, sparks: 3, combo: 4 })).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(store({ calls: 5, sparks: 0, combo: 0 })).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(store({ calls: 4, sparks: -1, combo: 0 })).rejects.toMatchObject(CHECK_VIOLATION);
  });
});

/** The landmark the `seasons` recipe names; the published Orrin fixture carries it from the plan (D-188). */
const LEANING_AXIS = { key: 'the-leaning-axis', name: 'The Leaning Axis' };

describe('The Final call and its landmark (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let play: PlayUseCases;
  let c: Awaited<ReturnType<typeof scrollUseCases>>;
  let scroll: Scroll;
  let calls: Awaited<ReturnType<typeof callsOfRevision>>;
  const callIt = () => calls.filter((call) => call.kind === 'call_it');
  const finalCall = () => calls.find((call) => call.kind === 'final_call')!;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('play_final');
    await enableProductionScope(database.db);
    scroll = await publishOrrin(database.db);
    calls = await callsOfRevision(database, scroll);
    c = await scrollUseCases(database, { recording: true });
    play = playFor(database);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  async function reader() {
    const person = await recordingPerson(database);
    await openActive(c, person, scroll);
    return person;
  }
  const lock = (
    person: FixturePerson,
    call: { readonly id: string },
    option: number,
    over: Partial<CallLockRequest> = {},
  ) =>
    play.lockCall(person.authority, {
      commandId: randomUUID(),
      assetId: scroll.assetId,
      revision: scroll.revision,
      stopId: call.id,
      option,
      recordingGeneration: 1,
      ...over,
    });
  const landmarkRows = async (person: FixturePerson) =>
    (
      await sql<{ landmark_key: string; landmark_name: string; tier: string }>`
        select landmark_key, landmark_name, tier from play.landmarks where universe_id = ${person.universeId}::uuid`.execute(
        database.db,
      )
    ).rows;

  it("carries the recipe's landmark and the tilt control in the stored revision, set by code", async () => {
    const final = finalCall();
    expect(final).toMatchObject({ kind: 'final_call', binding: { kind: 'tilt' } });
    const stored = await database.db
      .selectFrom('content.asset_revisions')
      .select('document')
      .where('asset_id', '=', scroll.assetId)
      .where('revision', '=', scroll.revision)
      .executeTakeFirstOrThrow();
    expect((stored.document as { landmark?: unknown }).landmark).toEqual(LEANING_AXIS);
  });

  it('judges the Final call on the server, and awards the gold landmark for a right answer', async () => {
    const person = await reader();
    const final = finalCall();
    const answer = await lock(person, final, picks(final).right);
    expect(answer).toMatchObject({
      kind: 'saved',
      outcome: {
        stopId: final.id,
        correct: true,
        newlyLocked: true,
        results: { sparks: 1, combo: 1, landmark: { ...LEANING_AXIS, tier: 'gold' } },
      },
    });
    expect(await landmarkRows(person)).toEqual([
      { landmark_key: LEANING_AXIS.key, landmark_name: LEANING_AXIS.name, tier: 'gold' },
    ]);
  });

  it('awards the plain landmark for a wrong Final call: it is never lost for a miss', async () => {
    const person = await reader();
    const final = finalCall();
    expect(await lock(person, final, picks(final).wrong)).toMatchObject({
      kind: 'saved',
      outcome: { correct: false, results: { sparks: 0, combo: 0, landmark: { ...LEANING_AXIS, tier: 'plain' } } },
    });
    expect(await landmarkRows(person)).toMatchObject([{ tier: 'plain' }]);
  });

  it('doubles a right Final call after a combo of two, on the server, with the shared rule', async () => {
    const person = await reader();
    const [first, second] = callIt();
    await lock(person, first!, picks(first!).right);
    await lock(person, second!, picks(second!).right);
    const final = finalCall();
    expect(await lock(person, final, picks(final).right)).toMatchObject({
      outcome: { results: { sparks: 4, combo: 3, landmark: { tier: 'gold' } } },
    });
    const broken = await reader();
    await lock(broken, first!, picks(first!).right);
    await lock(broken, second!, picks(second!).wrong);
    expect(await lock(broken, final, picks(final).right)).toMatchObject({
      outcome: { results: { sparks: 2, combo: 1 } },
    });
  });

  it('is idempotent: a retry answers the same landmark and writes nothing, and a second lock changes nothing', async () => {
    const person = await reader();
    const final = finalCall();
    const request = { commandId: randomUUID() };
    const once = await lock(person, final, picks(final).wrong, request);
    const again = await lock(person, final, picks(final).wrong, request);
    expect(once).toMatchObject({ outcome: { replayed: false, results: { landmark: { tier: 'plain' } } } });
    expect(again).toMatchObject({ outcome: { replayed: true, results: { landmark: { tier: 'plain' } } } });
    // Another command locking the Final call again, and right this time, does not upgrade the landmark.
    const second = await lock(person, final, picks(final).right);
    expect(second).toMatchObject({
      kind: 'saved',
      outcome: { correct: false, newlyLocked: false, results: { landmark: { tier: 'plain' } } },
    });
    expect(await landmarkRows(person)).toHaveLength(1);
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from play.calls where universe_id = ${person.universeId}::uuid`.execute(
          database.db,
        )
      ).rows[0]!.n,
    ).toBe(1);
  });

  it('refuses without an activated exposure and awards nothing, to a stranger or to someone who only opened it', async () => {
    const final = finalCall();
    const stranger = await recordingPerson(database);
    expect(await lock(stranger, final, picks(final).right)).toEqual({ kind: 'refused', reason: 'exposure_required' });
    const opened = await recordingPerson(database);
    await openActive(c, opened, scroll, { activate: false });
    expect(await lock(opened, final, picks(final).right)).toEqual({ kind: 'refused', reason: 'exposure_required' });
    expect(await landmarkRows(stranger)).toEqual([]);
    expect(await landmarkRows(opened)).toEqual([]);
  });

  it('awards nothing while recording is paused, and the landmark stays absent after resuming', async () => {
    const person = await reader();
    await sql`update identity.universes set recording_on = false, recording_generation = 2 where id = ${person.universeId}::uuid`.execute(
      database.db,
    );
    const final = finalCall();
    expect(await lock(person, final, picks(final).right, { recordingGeneration: 2 })).toEqual({
      kind: 'not_saved',
      outcome: { recorded: false, reason: 'recording_paused', currentGeneration: 2 },
    });
    expect(await landmarkRows(person)).toEqual([]);
    await sql`update identity.universes set recording_on = true, recording_generation = 3 where id = ${person.universeId}::uuid`.execute(
      database.db,
    );
    expect(await play.readLandmarks(person.authority)).toEqual({ kind: 'landmarks', landmarks: [] });
    expect(
      await play.readResults(person.authority, { assetId: scroll.assetId, revision: scroll.revision }),
    ).toMatchObject({ kind: 'results', results: { calls: [], sparks: 0 } });
  });

  it("lists a person's own landmarks, and no one else's", async () => {
    const mine = await reader();
    const final = finalCall();
    await lock(mine, final, picks(final).right);
    const other = await reader();
    const listed = await play.readLandmarks(mine.authority);
    expect(listed).toMatchObject({
      kind: 'landmarks',
      landmarks: [
        {
          assetId: scroll.assetId,
          revision: scroll.revision,
          ...LEANING_AXIS,
          tier: 'gold',
          earnedAt: expect.any(String) as string,
        },
      ],
    });
    expect(await play.readLandmarks(other.authority)).toEqual({ kind: 'landmarks', landmarks: [] });
    // Reading the results back after a reload carries the landmark too.
    expect(
      await playFor(database).readResults(mine.authority, { assetId: scroll.assetId, revision: scroll.revision }),
    ).toMatchObject({ kind: 'results', results: { landmark: { ...LEANING_AXIS, tier: 'gold' } } });
  });
});

describe('Play cannot change what reading does (the D-063 wall, real PostgreSQL)', () => {
  let world: GeographyWorld;
  let play: PlayUseCases;
  let scrolls: Scroll[];
  beforeAll(async () => {
    world = await geographyWorld('play_wall');
    await enableProductionScope(world.database.db);
    play = playFor(world.database);
    scrolls = [await publishOrrin(world.database.db)];
    for (const key of ['seasons-hemispheres', 'seasons-limits'] as const) {
      const recipe = TOPICS[key];
      // Parts 2 and 3 stay v1 Scrolls here, as in the reading test: the planet forms the same from a v2 part and v1 parts.
      const undo = markScrollV1(key);
      try {
        const production = fixtureProduction(world.database.db, () =>
          answerWith(fixtureAuthored(writerFormatOf(recipe))),
        );
        expect(await production.produce(key, false, signal())).toMatchObject({ outcome: 'published' });
      } finally {
        undo();
      }
      scrolls.push({ assetId: recipe.assetId, revision: 1 });
    }
  });
  afterAll(() => world.close());

  const factsOf = async (scroll: Scroll): Promise<ReadingFacts> => {
    const row = await world.database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', scroll.assetId)
      .where('revision', '=', scroll.revision)
      .executeTakeFirstOrThrow();
    return ReadingFactsSchema.parse(row.reading_facts);
  };

  /** Reads the v2 Part 1 as one device would report it: every stop for its time, every call revealed. */
  async function readPart1(
    person: FixturePerson,
    pick: (call: { answer: number; options: readonly string[] }) => number,
    share = 2.5,
  ) {
    const opened = await openActive(world.c, person, scrolls[0]!);
    await activatedAgo(world.database.db, opened.exposureId, 30);
    const facts = await factsOf(scrolls[0]!);
    let at = 0;
    const visits = facts.blocks.map((block) => {
      const length = block.seen?.kind === 'visible' ? block.seen.minVisibleMs * share : 10_000;
      const visit = { blockId: block.id, from: at, to: at + Math.round(length) };
      at = visit.to + 100;
      return visit;
    });
    // The person plays: every call, the Final call included, is locked before the same reading is reported.
    for (const call of await callsOfRevision(world.database, scrolls[0]!))
      expect(
        await play.lockCall(person.authority, {
          commandId: randomUUID(),
          assetId: scrolls[0]!.assetId,
          revision: 1,
          stopId: call.id,
          option: pick(call),
          recordingGeneration: 1,
        }),
      ).toMatchObject({ kind: 'saved' });
    const revealed = facts.blocks.filter((block) => block.seen?.kind === 'interaction').map((block) => block.id);
    await world.c.ingestObservations(person.authority, {
      instrumentationVersion: 1,
      events: [
        ...visits.map((visit) => event(opened, coverage([visit.blockId], visit.to - visit.from, visit.from))),
        ...revealed.map((blockId) =>
          event(opened, {
            kind: 'scroll.block_interaction',
            payload: { blockId, kind: 'revealed', atMs: 1 },
          }),
        ),
        event(opened, dwell(...visits.map((visit): [number, number] => [visit.from, visit.to]))),
      ],
    });
    const request = { v: 1 as const, universeId: person.universeId, privacyEpoch: 1, exposureId: opened.exposureId };
    const projected = await world.c.projectScrollReading(request);
    await world.c.projectActivity(request);
    return { projected, exposureId: opened.exposureId };
  }

  /** What evidence, activity and Personal Context hold of one reading, without ids or times. */
  async function recordOf(person: FixturePerson) {
    const db = world.database.db;
    const evidence = await sql`
      select qualification, q, coverage, active_dwell_ms, estimated_reading_ms, policy_version, summary
      from evidence.encounter_evidence where universe_id = ${person.universeId}::uuid order by revision`.execute(db);
    const activity = await sql`
      select channels, policy_version from evidence.activity_revisions
      where universe_id = ${person.universeId}::uuid order by activity`.execute(db);
    const contributions = await sql`
      select (payload->'contribution') - 'exposureId'::text - 'activityId'::text - 'activatedAt'::text as contribution
      from personal_context.recording_exposure_contributions where universe_id = ${person.universeId}::uuid`.execute(
      db,
    );
    return { evidence: evidence.rows, activity: activity.rows, contributions: contributions.rows };
  }

  it('gives the same reading quality, evidence and Personal Context to a right pick and a wrong one', async () => {
    const rightReader = await seedPerson(world.database.db);
    const wrongReader = await seedPerson(world.database.db);
    const right = await readPart1(rightReader, (call) => picks(call).right);
    const wrong = await readPart1(wrongReader, (call) => picks(call).wrong);
    // The play record differs ...
    const sparks = async (person: FixturePerson) => {
      const result = await play.readResults(person.authority, { assetId: scrolls[0]!.assetId, revision: 1 });
      return result.kind === 'results' ? result.results.sparks : -1;
    };
    expect(await sparks(rightReader)).toBeGreaterThan(0);
    expect(await sparks(wrongReader)).toBe(0);
    // The landmark differs too: gold for the right Final call, plain for the wrong one.
    const finish = async (person: FixturePerson) => {
      const listed = await play.readLandmarks(person.authority);
      return listed.kind === 'landmarks' ? listed.landmarks.map((landmark) => landmark.tier) : [];
    };
    expect(await finish(rightReader)).toEqual(['gold']);
    expect(await finish(wrongReader)).toEqual(['plain']);
    // ... and reading does not: the same qualification, the same activity, the same contribution.
    const withoutId = (projected: typeof right.projected) => ({ ...projected, evidenceId: undefined });
    expect(withoutId(right.projected)).toEqual(withoutId(wrong.projected));
    expect(right.projected).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await recordOf(rightReader)).toEqual(await recordOf(wrongReader));
    expect((await recordOf(rightReader)).activity.length).toBeGreaterThan(0);
    // The comparison is sensitive: a reading that differs (a quick tap through the same Scroll) is not equal.
    const tapper = await seedPerson(world.database.db);
    await readPart1(tapper, (call) => picks(call).right, 0.5);
    expect(await recordOf(tapper)).not.toEqual(await recordOf(rightReader));
  });

  it('forms the same places for two people who read alike and called differently', async () => {
    const { observe, snapshot } = world;
    const rightReader = await seedPerson(world.database.db);
    const wrongReader = await seedPerson(world.database.db);
    await readPart1(rightReader, (call) => picks(call).right);
    await readPart1(wrongReader, (call) => picks(call).wrong);
    const garbage = { kind: 'malformed' } as const;
    const cartograph = async (person: FixturePerson) => {
      const runId = (await world.state(person)).activeRunId;
      if (!runId) throw new Error('CI expected an active Cartographer run');
      await world.runner(person, () => garbage).run(await world.job(person, runId), signal());
    };
    const places = async (person: FixturePerson) => {
      const result = await snapshot(person);
      return 'page' in result ? result.page.objects.map((place) => `${place.kind}:${place.label}`).sort() : [];
    };
    for (const person of [rightReader, wrongReader]) {
      await cartograph(person);
      for (const part of scrolls.slice(1)) {
        await observe(person, { ...part, blocks: (await factsOf(part)).blocks.map((block) => block.id) });
        await cartograph(person);
      }
    }
    const formed = await places(rightReader);
    expect(formed.filter((place) => place.startsWith('planet:'))).toHaveLength(1);
    expect(await places(wrongReader)).toEqual(formed);
  });
});
