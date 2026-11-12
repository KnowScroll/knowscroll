import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeCatalogue } from '@knowscroll/backend/modules/content/nest-providers';
import { evidenceRebuildInterestRollups } from '@knowscroll/backend/modules/evidence/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { activatedAgo, coverage, dwell, event, openActive } from '../support/observations.js';
import { clearRecordingPerson, recordingPerson } from '../support/recording-person.js';
import { scrollUseCases, starterSource } from '../support/scroll.js';

/**
 * Long-term interest storage and reads for Composer policy v3 (#674, slice 4.2, D-420): `log_weight`, the system and person
 * roll-ups written in the same transaction as the topic rows, the top-K read as an index range scan, and erasure. Authored CI
 * fixtures on real PostgreSQL; nothing here is product data.
 */
const HALF_LIFE_MS = 14 * 86_400_000;
const DAY = 86_400_000;
const decayed = (stored: number, storedAt: Date, at: number) =>
  stored * Math.pow(2, -Math.max(0, at - storedAt.getTime()) / HALF_LIFE_MS);

describe('interest roll-ups and the top-K read (real PostgreSQL, authored CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let c: Awaited<ReturnType<typeof scrollUseCases>>;
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  const topics = ['earth.seasons', 'earth.tides', 'space.stars'] as const;
  const fixtures = new Map<string, { assetId: string; revision: number }>();

  beforeAll(async () => {
    database = await createTestDatabase<Database>('interest_rollups');
    c = await scrollUseCases(database, { recording: true, composerPolicy: 'v3' });
    for (const topic of topics) {
      const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      source.assetId = randomUUID();
      source.publication.explanationUnitId = `ci-interest-${topic.replace('.', '-')}-${randomUUID()}`;
      const imported = await c.importScroll(source);
      if (imported.kind !== 'imported') throw new Error(`CI authored fixture refused: ${imported.reason}`);
      await database.db.deleteFrom('content.encounter_topics').where('asset_id', '=', imported.assetId).execute();
      await database.db
        .insertInto('content.encounter_topics')
        .values({
          asset_id: imported.assetId,
          asset_revision: imported.revision,
          topic_id: topic,
          role: 'primary',
          weight: 1,
        })
        .execute();
      fixtures.set(topic, { assetId: imported.assetId, revision: imported.revision });
    }
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  /** A full qualified read of the Scroll about `topic`, projected through the real worker use cases. */
  async function qualifiedRead(person: FixturePerson, topic: (typeof topics)[number]) {
    const fixture = fixtures.get(topic)!;
    const reading = await openActive(c, person, fixture);
    await activatedAgo(database.db, reading.exposureId, 30);
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', fixture.assetId)
      .where('revision', '=', fixture.revision)
      .executeTakeFirstOrThrow();
    const blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((b) => b.id);
    await c.ingestObservations(person.authority, {
      instrumentationVersion: 1,
      events: [event(reading, coverage(blocks, 4000)), event(reading, dwell([0, 68000]))],
    });
    const payload = { v: 1 as const, universeId: person.universeId, privacyEpoch: 1, exposureId: reading.exposureId };
    expect(await c.projectScrollReading(payload)).toMatchObject({ kind: 'applied', qualification: 'qualified' });
    expect(await c.projectActivity(payload)).toMatchObject({ kind: 'applied' });
    return payload;
  }

  const topicRows = (person: FixturePerson) =>
    sql<{
      topic_id: string;
      activity: number;
      evaluated_at: Date;
      log_weight: number | null;
      scroll_measured: number;
      scroll_qualified: number;
      reel_measured: number;
    }>`
      select topic_id,activity,evaluated_at,log_weight,scroll_measured,scroll_qualified,reel_measured from evidence.topic_context
      where universe_id=${person.universeId}::uuid order by topic_id`.execute(database.db);
  const rollupRows = (person: FixturePerson) =>
    sql<{
      level: string;
      subject_id: string;
      activity: number;
      evaluated_at: Date;
      log_weight: number | null;
      scroll_measured: number;
      scroll_qualified: number;
      reel_measured: number;
      reel_qualified: number;
    }>`
      select level,subject_id,activity,evaluated_at,log_weight,scroll_measured,scroll_qualified,reel_measured,reel_qualified from evidence.interest_rollups
      where universe_id=${person.universeId}::uuid order by level,subject_id`.execute(database.db);

  it('writes log_weight with every topic row, and a system and a person roll-up that sum their topics', async () => {
    const person = await recordingPerson(database);
    // Two reads of Seasons, one of Tides (both Earth), one of Stars (Space).
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'earth.tides');
    await qualifiedRead(person, 'space.stars');
    const rows = (await topicRows(person)).rows;
    expect(rows.map((r) => r.topic_id)).toEqual(['earth.seasons', 'earth.tides', 'space.stars']);
    for (const row of rows) {
      expect(row.activity).toBeGreaterThan(0);
      expect(row.log_weight).toBeCloseTo(
        Math.log(row.activity) + (Math.LN2 * row.evaluated_at.getTime()) / HALF_LIFE_MS,
        9,
      );
    }
    const seasons = rows[0]!;
    expect(seasons.scroll_measured).toBe(2);
    expect(seasons.activity).toBeGreaterThan(rows[1]!.activity);

    const rollups = (await rollupRows(person)).rows;
    expect(rollups.map((r) => `${r.level}:${r.subject_id}`)).toEqual(['person:', 'system:earth', 'system:space']);
    // Compared at one time, the roll-up is the sum of the topic rows beneath it.
    const at = Date.now() + 10 * DAY;
    const sumAt = (...ids: string[]) =>
      rows
        .filter((r) => ids.includes(r.topic_id))
        .reduce((total, r) => total + decayed(r.activity, r.evaluated_at, at), 0);
    const rollupAt = (level: string, subject: string) => {
      const row = rollups.find((r) => r.level === level && r.subject_id === subject)!;
      return decayed(row.activity, row.evaluated_at, at);
    };
    expect(rollupAt('system', 'earth')).toBeCloseTo(sumAt('earth.seasons', 'earth.tides'), 9);
    expect(rollupAt('system', 'space')).toBeCloseTo(sumAt('space.stars'), 9);
    expect(rollupAt('person', '')).toBeCloseTo(sumAt('earth.seasons', 'earth.tides', 'space.stars'), 9);
    // Counts are sums too: four measured and qualified Scrolls, three of them under Earth, none a Reel.
    const count = (level: string, subject: string) =>
      rollups.find((r) => r.level === level && r.subject_id === subject)!;
    expect(count('person', '')).toMatchObject({
      scroll_measured: 4,
      scroll_qualified: 4,
      reel_measured: 0,
      reel_qualified: 0,
    });
    expect(count('system', 'earth')).toMatchObject({ scroll_measured: 3, scroll_qualified: 3 });
    expect(count('system', 'space')).toMatchObject({ scroll_measured: 1, scroll_qualified: 1 });
    for (const row of rollups) {
      expect(row.log_weight).toBeCloseTo(
        Math.log(row.activity) + (Math.LN2 * row.evaluated_at.getTime()) / HALF_LIFE_MS,
        9,
      );
    }
  });

  it('reads the top topics strongest first from the index, honours K and the floor, and leaves a quiet person with none', async () => {
    const person = await recordingPerson(database);
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'space.stars');
    const now = new Date().toISOString();
    const lead = async (topK: number, evaluatedAt = now) => {
      const entered = await scope()(person.authority, (s) => c.readInterestContext.leads(s, { evaluatedAt, topK }));
      if (entered.kind !== 'entered') throw new Error('CI scope refused');
      return entered.value;
    };
    const top = await lead(8);
    expect(top.topics.map((t) => t.topicId)).toEqual(['earth.seasons', 'space.stars']);
    expect(top.topics[0]!.activity).toBeGreaterThan(top.topics[1]!.activity);
    expect((await lead(1)).topics.map((t) => t.topicId)).toEqual(['earth.seasons']);
    // Two hundred days on, both have decayed far under the floor of 0.05: nothing is long-term interest any more.
    expect((await lead(8, new Date(Date.now() + 200 * DAY).toISOString())).topics).toEqual([]);
    // A person who never read anything has no top topics and no planned unit.
    const quiet = await recordingPerson(database);
    const entered = await scope()(quiet.authority, (s) =>
      c.readInterestContext.leads(s, { evaluatedAt: now, topK: 8 }),
    );
    expect(entered).toMatchObject({ kind: 'entered', value: { topics: [], plannedUnitIds: [] } });
  });

  it('reads the roll-ups of the systems asked for and of the person, decayed to the time asked', async () => {
    const person = await recordingPerson(database);
    await qualifiedRead(person, 'earth.tides');
    await qualifiedRead(person, 'space.stars');
    const at = new Date(Date.now() + 14 * DAY).toISOString();
    const entered = await scope()(person.authority, (s) =>
      c.readInterestContext.rollups(s, { evaluatedAt: at, systemIds: ['earth', 'machine-learning'] }),
    );
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    const { person: overall, systems } = entered.value;
    // Only the system asked for that the person has a row for; a system never read is absent, not zero.
    expect(systems.map((s) => s.systemId)).toEqual(['earth']);
    const stored = (await rollupRows(person)).rows;
    const earth = stored.find((r) => r.subject_id === 'earth')!;
    expect(systems[0]!.activity).toBeCloseTo(decayed(earth.activity, earth.evaluated_at, Date.parse(at)), 9);
    expect(systems[0]!.formats).toEqual([
      { kind: 'reel', measured: 0, qualified: 0 },
      { kind: 'scroll', measured: 1, qualified: 1 },
    ]);
    expect(overall?.formats.find((f) => f.kind === 'scroll')).toMatchObject({ measured: 2, qualified: 2 });
  });

  it('is not changed by projecting the same exposure again: a correction replaces, it never adds', async () => {
    const person = await recordingPerson(database);
    const payload = await qualifiedRead(person, 'earth.seasons');
    const before = (await rollupRows(person)).rows;
    const topicBefore = (await topicRows(person)).rows;
    await c.projectActivity(payload);
    await c.projectActivity(payload);
    expect((await rollupRows(person)).rows).toEqual(before);
    expect((await topicRows(person)).rows).toEqual(topicBefore);
  });

  /** Every roll-up equals the sum of the topic rows beneath it (systems by the catalogue, the person over all), compared at one time. */
  async function expectRollupsToSumTheTopics(person: FixturePerson) {
    const topics = (await topicRows(person)).rows;
    const rollups = (await rollupRows(person)).rows;
    const at = Date.now() + 5 * DAY;
    const systemOf = (topic: string) => topic.split('.')[0]!;
    const sum = (
      pick: (topic: string) => boolean,
      field: 'activity' | 'scroll_measured' | 'scroll_qualified' | 'reel_measured',
    ) =>
      topics
        .filter((t) => pick(t.topic_id))
        .reduce((total, t) => total + (field === 'activity' ? decayed(t.activity, t.evaluated_at, at) : t[field]), 0);
    const bySystem = [...new Set(topics.map((t) => systemOf(t.topic_id)))].sort();
    expect(rollups.map((r) => `${r.level}:${r.subject_id}`)).toEqual([
      'person:',
      ...bySystem.map((system) => `system:${system}`),
    ]);
    for (const rollup of rollups) {
      const pick = (topic: string) => rollup.level === 'person' || systemOf(topic) === rollup.subject_id;
      expect(decayed(rollup.activity, rollup.evaluated_at, at)).toBeCloseTo(sum(pick, 'activity'), 9);
      expect(rollup.scroll_measured).toBe(sum(pick, 'scroll_measured'));
      expect(rollup.scroll_qualified).toBe(sum(pick, 'scroll_qualified'));
      expect(rollup.reel_measured).toBe(sum(pick, 'reel_measured'));
    }
  }

  it('corrects a topic an older binary changed without counting it: the next write takes away what was counted and adds what is', async () => {
    const person = await recordingPerson(database);
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'space.stars');
    await expectRollupsToSumTheTopics(person);
    // The older binary writes the topic row (log_weight is still derived by the trigger) and leaves the roll-ups alone.
    await sql`update evidence.topic_context set activity = activity * 3, scroll_measured = scroll_measured + 2, scroll_qualified = scroll_qualified + 2
      where universe_id = ${person.universeId}::uuid and topic_id = 'earth.seasons'`.execute(database.db);
    await qualifiedRead(person, 'earth.seasons');
    await expectRollupsToSumTheTopics(person);
  });

  it('never subtracts what the roll-ups did not add: a topic an older binary wrote, then the new binary reads again', async () => {
    const person = await recordingPerson(database);
    // The system's and the person's roll-ups exist already (a sibling topic was counted), so a wrong subtraction would not be seen as
    // a missing roll-up: it would show as a roll-up short of its topics.
    await qualifiedRead(person, 'earth.tides');
    // The older binary left this topic row with a history and no roll-up and no counted state.
    await sql`insert into evidence.topic_context(universe_id,privacy_epoch,topic_id,channel_values,activity,evaluated_at,scroll_measured,scroll_qualified)
      values(${person.universeId}::uuid,1,'earth.seasons','{"q":2,"L":0,"B":0,"S":0,"H":0,"R":0}'::jsonb,2,now(),2,2)`.execute(
      database.db,
    );
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'earth.seasons');
    await expectRollupsToSumTheTopics(person);
    const topic = (await topicRows(person)).rows[0]!;
    expect(topic.scroll_measured).toBe(4);
  });

  it('rebuilds the roll-ups when they have lost what they are asked to take away', async () => {
    const person = await recordingPerson(database);
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'space.stars');
    await qualifiedRead(person, 'earth.tides');
    // Roll-up rows lost (a restore, a manual delete): the next write cannot subtract from what is not there.
    await sql`delete from evidence.interest_rollups where universe_id = ${person.universeId}::uuid and level = 'system'`.execute(
      database.db,
    );
    await qualifiedRead(person, 'earth.seasons');
    // Every roll-up is whole again, the systems this write did not touch included.
    await expectRollupsToSumTheTopics(person);
    expect((await rollupRows(person)).rows.map((r) => r.subject_id)).toEqual(['', 'earth', 'space']);
  });

  it('is erased with the person: Clear removes the topic keys and both kinds of roll-up', async () => {
    const person = await recordingPerson(database);
    await qualifiedRead(person, 'earth.seasons');
    await qualifiedRead(person, 'space.stars');
    expect((await rollupRows(person)).rows).toHaveLength(3);
    await clearRecordingPerson(database, c.boss, person);
    expect((await rollupRows(person)).rows).toEqual([]);
    expect((await topicRows(person)).rows).toEqual([]);
  });

  it('keeps one person’s roll-ups from another’s', async () => {
    const first = await recordingPerson(database);
    const second = await recordingPerson(database);
    await qualifiedRead(first, 'earth.seasons');
    expect((await rollupRows(second)).rows).toEqual([]);
    const entered = await scope()(second.authority, (s) =>
      c.readInterestContext.rollups(s, { evaluatedAt: new Date().toISOString(), systemIds: ['earth'] }),
    );
    expect(entered).toMatchObject({ kind: 'entered', value: { systems: [] } });
  });
});

describe('the top-K read is an index range scan however many topics a person has met (measured on disposable data)', () => {
  let database: TestDatabase<Database>;
  let person: FixturePerson;
  let c: Awaited<ReturnType<typeof scrollUseCases>>;
  const TOPICS = 20_000;
  const K = 32;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('interest_topk_scale');
    c = await scrollUseCases(database, { composerPolicy: 'v3' });
    person = await seedPerson(database.db);
    // Twenty thousand topics with activities from 0.001 to 3, stored over the last 120 days, as the projection stores them.
    await sql`insert into evidence.topic_context(universe_id,privacy_epoch,topic_id,channel_values,activity,evaluated_at,log_weight)
      select ${person.universeId}::uuid,1,'ci.scale.'||n,'{"q":0,"L":0,"B":0,"S":0,"H":0,"R":0}'::jsonb,a,t,
        ln(a)+ln(2)*(extract(epoch from t)*1000)/1209600000
      from (select n,0.001+random()*3 as a,now()-random()*interval '120 days' as t from generate_series(1,${TOPICS}) n) s`.execute(
      database.db,
    );
    await sql`analyze evidence.topic_context`.execute(database.db);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  it('returns exactly the K strongest topics by decayed activity, strongest first', async () => {
    const now = new Date();
    const entered = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
      c.readInterestContext.leads(scope, { evaluatedAt: now.toISOString(), topK: K }),
    );
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    const rows = (
      await sql<{
        topic_id: string;
        activity: number;
        evaluated_at: Date;
      }>`select topic_id,activity,evaluated_at from evidence.topic_context
        where universe_id=${person.universeId}::uuid`.execute(database.db)
    ).rows;
    const expected = rows
      .map((r) => ({ topicId: r.topic_id, activity: decayed(r.activity, r.evaluated_at, now.getTime()) }))
      .filter((r) => r.activity >= 0.05)
      .sort((a, b) => b.activity - a.activity)
      .slice(0, K);
    expect(entered.value.topics.map((t) => t.topicId)).toEqual(expected.map((t) => t.topicId));
    entered.value.topics.forEach((t, i) => expect(t.activity).toBeCloseTo(expected[i]!.activity, 9));
  });

  it('plans one backward index scan with no sort, and reads about K rows of the 20,000, not all of them', async () => {
    const nowMs = Date.now();
    const floor = Math.log(0.05) + (Math.LN2 * nowMs) / HALF_LIFE_MS;
    const plan = await sql<{ 'QUERY PLAN': { Plan: PlanNode }[] }>`explain (analyze, buffers, format json)
      select topic_id,activity,evaluated_at from evidence.topic_context
      where universe_id=${person.universeId}::uuid and privacy_epoch=1 and log_weight is not null and log_weight>=${floor}
      order by log_weight desc,topic_id limit ${K}`.execute(database.db);
    const root = plan.rows[0]!['QUERY PLAN'][0]!.Plan;
    const nodes = flatten(root);
    expect(nodes.some((n) => n['Node Type'] === 'Sort')).toBe(false);
    const scan = nodes.find((n) => n['Node Type'] === 'Index Scan' || n['Node Type'] === 'Index Only Scan')!;
    expect(scan['Index Name']).toBe('topic_context_top_interest');
    expect(scan['Scan Direction']).toBe('Forward');
    // The index stops at its limit: it returned K rows and read no more than K plus a few.
    expect(scan['Actual Rows']).toBeLessThanOrEqual(K);
    expect(scan['Shared Hit Blocks']! + (scan['Shared Read Blocks'] ?? 0)).toBeLessThan(60);
  });

  it('reads the top topics of a person with 20,000 in milliseconds, scope entry included', async () => {
    // The plan above bounds the work; this only guards against a slow path (measured here at under 2 ms; the bound is loose for hosted runners).
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      const entered = await makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })(person.authority, (scope) =>
        c.readInterestContext.leads(scope, { evaluatedAt: new Date().toISOString(), topK: K }),
      );
      expect(entered.kind).toBe('entered');
    }
    const meanMs = (performance.now() - started) / 20;
    expect(meanMs).toBeLessThan(250);
  });
});

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  'Actual Rows'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}
function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

describe('log_weight is derived by the table, and the roll-ups are rebuilt by one idempotent pass (authored CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let c: Awaited<ReturnType<typeof scrollUseCases>>;
  const channels = (q: number) => JSON.stringify({ q, L: 0, B: 0, S: 0, H: 0, R: 0 });
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const ISO = (ms: number) => new Date(ms).toISOString();
  const logWeight = (activity: number, atMs: number) => Math.log(activity) + (Math.LN2 * atMs) / HALF_LIFE_MS;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('interest_rebuild');
    c = await scrollUseCases(database, { composerPolicy: 'v3' });
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  const insertTopic = (
    person: FixturePerson,
    topic: string,
    activity: number,
    atMs: number,
    counts: [number, number, number, number],
    q = activity,
  ) =>
    sql`insert into evidence.topic_context(universe_id,privacy_epoch,topic_id,channel_values,activity,evaluated_at,reel_qualified,reel_measured,scroll_qualified,scroll_measured)
      values(${person.universeId}::uuid,1,${topic},${channels(q)}::jsonb,${activity},${ISO(atMs)}::timestamptz,${counts[0]},${counts[1]},${counts[2]},${counts[3]})`.execute(
      database.db,
    );
  const keys = (person: FixturePerson) =>
    sql<{
      topic_id: string;
      activity: number;
      evaluated_at: Date;
      log_weight: number | null;
      rollup_counted: unknown;
    }>`select topic_id,activity,evaluated_at,log_weight,rollup_counted
      from evidence.topic_context where universe_id=${person.universeId}::uuid order by topic_id`.execute(database.db);
  const rollups = (person: FixturePerson) =>
    sql<{
      level: string;
      subject_id: string;
      activity: number;
      evaluated_at: Date;
      channel_values: { q: number };
      reel_measured: number;
      reel_qualified: number;
      scroll_measured: number;
      scroll_qualified: number;
      log_weight: number;
    }>`
      select level,subject_id,activity,evaluated_at,channel_values,reel_measured,reel_qualified,scroll_measured,scroll_qualified,log_weight from evidence.interest_rollups
      where universe_id=${person.universeId}::uuid order by level,subject_id`.execute(database.db);

  it('derives log_weight on every write whatever the writer says: an insert, an update, a value it set wrongly, and zero activity', async () => {
    const person = await seedPerson(database.db);
    await insertTopic(person, 'earth.seasons', 2, t0, [0, 0, 1, 1]);
    let row = (await keys(person)).rows[0]!;
    expect(row.log_weight).toBeCloseTo(logWeight(2, t0), 9);
    // An older binary updates the activity and time and knows nothing of the column.
    await sql`update evidence.topic_context set activity = 5, evaluated_at = ${ISO(t0 + DAY)}::timestamptz where universe_id=${person.universeId}::uuid`.execute(
      database.db,
    );
    row = (await keys(person)).rows[0]!;
    expect(row.log_weight).toBeCloseTo(logWeight(5, t0 + DAY), 9);
    // A writer that names a value gets the derived one.
    await sql`update evidence.topic_context set log_weight = 123 where universe_id=${person.universeId}::uuid`.execute(
      database.db,
    );
    expect((await keys(person)).rows[0]!.log_weight).toBeCloseTo(logWeight(5, t0 + DAY), 9);
    await sql`update evidence.topic_context set activity = 0 where universe_id=${person.universeId}::uuid`.execute(
      database.db,
    );
    expect((await keys(person)).rows[0]!.log_weight).toBeNull();
  });

  it('derives it for the roll-up table too, and leaves a row nothing has written since the migration to the rebuild', async () => {
    const person = await seedPerson(database.db);
    await sql`insert into evidence.interest_rollups(universe_id,privacy_epoch,level,subject_id,channel_values,activity,evaluated_at)
      values(${person.universeId}::uuid,1,'person','',${channels(1)}::jsonb,3,${ISO(t0)}::timestamptz)`.execute(
      database.db,
    );
    expect((await rollups(person)).rows[0]!.log_weight).toBeCloseTo(logWeight(3, t0), 9);
    // Rows that existed before the migration have no key: simulate them with the trigger off, as the migration leaves them.
    const stale = await seedPerson(database.db);
    await sql`alter table evidence.topic_context disable trigger topic_context_log_weight`.execute(database.db);
    try {
      await insertTopic(stale, 'earth.seasons', 2, t0, [0, 0, 1, 1]);
    } finally {
      await sql`alter table evidence.topic_context enable trigger topic_context_log_weight`.execute(database.db);
    }
    expect((await keys(stale)).rows[0]!.log_weight).toBeNull();
    await evidenceRebuildInterestRollups(
      database.db,
      makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      makeCatalogue(database.db),
    )({ maxUniverses: 5000 });
    expect((await keys(stale)).rows[0]!.log_weight).toBeCloseTo(logWeight(2, t0), 9);
  });

  it('rebuilds a person’s roll-ups from their topic rows and stamps what each row was counted as, as the writer would', async () => {
    const person = await seedPerson(database.db);
    const rows = [
      { topic: 'earth.seasons', activity: 2, at: t0, reel: [1, 1], scroll: [2, 3], q: 1.5 },
      { topic: 'earth.tides', activity: 1, at: t0 + 7 * DAY, reel: [0, 0], scroll: [1, 1], q: 0.9 },
      { topic: 'space.stars', activity: 0.5, at: t0 + 14 * DAY, reel: [0, 2], scroll: [0, 0], q: 0 },
      { topic: 'ci.not-in-the-catalogue', activity: 3, at: t0 + 14 * DAY, reel: [0, 0], scroll: [3, 3], q: 2 },
      { topic: 'earth.zero', activity: 0, at: t0, reel: [0, 0], scroll: [0, 0], q: 0 },
    ];
    await sql`alter table evidence.topic_context disable trigger topic_context_log_weight`.execute(database.db);
    try {
      for (const r of rows)
        await insertTopic(person, r.topic, r.activity, r.at, [r.reel[0]!, r.reel[1]!, r.scroll[0]!, r.scroll[1]!], r.q);
    } finally {
      await sql`alter table evidence.topic_context enable trigger topic_context_log_weight`.execute(database.db);
    }
    const run = evidenceRebuildInterestRollups(
      database.db,
      makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      makeCatalogue(database.db),
    );
    const first = await run({ maxUniverses: 5000 });
    expect(first.failed).toBe(0);
    const snapshot = async () => ({ keys: (await keys(person)).rows, rollups: (await rollups(person)).rows });
    const once = await snapshot();
    // Every topic row has its key and its counted state; a topic is counted into the person and, when the catalogue holds it, its system.
    for (const row of once.keys) {
      if (row.activity > 0) expect(row.log_weight).toBeCloseTo(logWeight(row.activity, row.evaluated_at.getTime()), 9);
      expect(row.rollup_counted).toMatchObject({ a: row.activity });
    }
    expect(once.rollups.map((r) => `${r.level}:${r.subject_id}`)).toEqual(['person:', 'system:earth', 'system:space']);
    const at = t0 + 60 * DAY;
    const sumAt = (
      pick: (r: (typeof rows)[number]) => boolean,
      field: (r: (typeof rows)[number]) => number = (r) => r.activity,
    ) => rows.filter(pick).reduce((total, r) => total + decayed(field(r), new Date(r.at), at), 0);
    const rollupAt = (level: string, subject: string, field: 'activity' | 'q') => {
      const row = once.rollups.find((r) => r.level === level && r.subject_id === subject)!;
      return decayed(field === 'activity' ? row.activity : row.channel_values.q, row.evaluated_at, at);
    };
    const inEarth = (r: (typeof rows)[number]) => r.topic.startsWith('earth.');
    expect(rollupAt('system', 'earth', 'activity')).toBeCloseTo(sumAt(inEarth), 9);
    expect(rollupAt('system', 'earth', 'q')).toBeCloseTo(
      sumAt(inEarth, (r) => r.q),
      9,
    );
    expect(rollupAt('system', 'space', 'activity')).toBeCloseTo(
      sumAt((r) => r.topic === 'space.stars'),
      9,
    );
    // The person is every topic, whether or not the catalogue holds it.
    expect(rollupAt('person', '', 'activity')).toBeCloseTo(
      sumAt(() => true),
      9,
    );
    expect(once.rollups.find((r) => r.level === 'person')).toMatchObject({
      reel_measured: 3,
      reel_qualified: 1,
      scroll_measured: 7,
      scroll_qualified: 6,
    });
    expect(once.rollups.find((r) => r.subject_id === 'earth')).toMatchObject({
      reel_measured: 1,
      scroll_measured: 4,
      scroll_qualified: 3,
    });
    for (const r of once.rollups) expect(r.log_weight).toBeCloseTo(logWeight(r.activity, r.evaluated_at.getTime()), 9);
    // Idempotent: a second pass writes the same rows.
    await run({ maxUniverses: 5000 });
    expect(await snapshot()).toEqual(once);
  });

  it('visits persons in pages, stops at the cap and says whether it finished, skips a person the root refuses and keeps the others', async () => {
    const people = [await seedPerson(database.db), await seedPerson(database.db), await seedPerson(database.db)];
    for (const person of people) await insertTopic(person, 'earth.tides', 1, t0, [0, 0, 1, 1]);
    // One of them has topic rows of an epoch the universe has left: the personal root refuses it.
    await sql`update evidence.topic_context set privacy_epoch = 2 where universe_id = ${people[2]!.universeId}::uuid`.execute(
      database.db,
    );
    const total = (
      await sql<{ n: string }>`select count(distinct universe_id)::text as n from evidence.topic_context`.execute(
        database.db,
      )
    ).rows[0]!.n;
    const run = evidenceRebuildInterestRollups(
      database.db,
      makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 }),
      makeCatalogue(database.db),
    );
    const capped = await run({ maxUniverses: 1 });
    expect(capped).toMatchObject({ complete: false });
    expect(capped.rebuilt + capped.skipped + capped.failed).toBe(1);
    const all = await run({ maxUniverses: 5000 });
    expect(all.complete).toBe(true);
    expect(all.rebuilt + all.skipped + all.failed).toBe(Number(total));
    expect(all.skipped).toBeGreaterThanOrEqual(1);
    expect((await rollups(people[0]!)).rows).toHaveLength(2);
    expect((await rollups(people[2]!)).rows).toEqual([]);
  });
});
