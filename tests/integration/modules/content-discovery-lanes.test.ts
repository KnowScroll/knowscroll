/**
 * Discovery retrieval reads a rotating sample, not the lowest asset ids (#674, D-408), on real PostgreSQL. Labelled CI
 * fixtures: Reel rows with a valid document and no media, which is all retrieval reads. Nothing here is product data.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { readDiscoveryCandidates } from '@knowscroll/backend/modules/content/nest-providers';
import { rotationCursor } from '../../../packages/backend/src/modules/content/adapters/discovery-store.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { textCapabilities } from '../support/scroll.js';

const capabilities = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };
const TOPIC = 'ci.lanes.topic';

describe('discovery lanes are a rotating sample (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let person: FixturePerson;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });

  /** An admitted Reel row with a valid document and no media, with the given topic attributions. */
  async function admitReel(
    topics: readonly { readonly topicId: string; readonly role: 'primary' | 'supporting' | 'incidental' }[] = [],
    title = '[Fixture] a Reel',
  ): Promise<string> {
    const assetId = randomUUID();
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId,
      revision: 1,
      title,
      summary: 'CI fixture',
      language: 'en',
      truthLabel: 'generated',
      fixture: true,
      captions: 'burned_in',
      mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
      durationMs: 20_000,
      width: 1080,
      height: 1920,
    };
    await sql`insert into content.assets (id, revision, kind, status) values (${assetId}::uuid, 1, 'reel', 'admitted')`.execute(
      database.db,
    );
    await sql`insert into content.asset_revisions
        (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
      values (${assetId}::uuid, 1, 'generated', 'reel-document.v1', ${JSON.stringify(document)}::jsonb,
        ${'0'.repeat(64)}, ${`ci-lanes-${assetId}`}, 'en', ${title}, '{}'::jsonb)`.execute(database.db);
    for (const { topicId, role } of topics)
      await database.db
        .insertInto('content.encounter_topics')
        .values({ asset_id: assetId, asset_revision: 1, topic_id: topicId, role, weight: role === 'primary' ? 1 : 0.2 })
        .execute();
    return assetId;
  }

  const read = async (
    query: Omit<Parameters<typeof readDiscoveryCandidates>[1], 'languages' | 'formats' | 'capabilities'> = {},
  ) => {
    const entered = await withScope()(person.authority, (scope) =>
      readDiscoveryCandidates(scope, { languages: ['en'], formats: ['reel'], capabilities, ...query }),
    );
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    return entered.value.map((candidate) => candidate.assetId);
  };

  const library: string[] = [];
  const primary: string[] = [];
  const supporting: string[] = [];
  const incidental: string[] = [];
  let findable: string;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_lanes');
    person = await seedPerson(database.db);
    for (let n = 0; n < 150; n += 1) library.push(await admitReel());
    for (let n = 0; n < 3; n += 1) primary.push(await admitReel([{ topicId: TOPIC, role: 'primary' }]));
    for (let n = 0; n < 3; n += 1) supporting.push(await admitReel([{ topicId: TOPIC, role: 'supporting' }]));
    // Far more than the topic lane's 40 slots, which the old lane filled first by asset id.
    for (let n = 0; n < 60; n += 1) incidental.push(await admitReel([{ topicId: TOPIC, role: 'incidental' }]));
    findable = await admitReel([], '[Fixture] zzquasar finder');
    // The keys are random by default, so a test could meet an unlucky draw. Pin them: evenly spaced in an order that is
    // unrelated to the asset ids, so every assertion below is about the lanes and none about a lucky or unlucky key.
    await sql`update content.discovery_revisions d set serve_rand = k.rank::float8 / k.total
      from (select asset_id, asset_revision, row_number() over (order by md5(asset_id::text)) - 1 as rank, count(*) over () as total
            from content.discovery_revisions) k
      where d.asset_id = k.asset_id and d.asset_revision = k.asset_revision`.execute(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const everything = () => [...library, ...primary, ...supporting, ...incidental, findable];

  /** A seed whose cursor lies in `[from, to)`, found by search: the hash of a seed is fixed, so this is deterministic. */
  const seedBetween = (from: number, to: number, label: string): string => {
    for (let n = 0; ; n += 1) {
      const seed = `${label}-${String(n)}`;
      const cursor = rotationCursor(seed);
      if (cursor >= from && cursor < to) return seed;
    }
  };

  it('reads at most the cap, and not the lowest asset ids of the library', async () => {
    const found = await read();
    expect(found).toHaveLength(100);
    const lowest = [...everything()].sort().slice(0, 100);
    // Before, lane 2 was `order by asset_id limit 100`: exactly this set, for every person and every decision.
    expect([...found].sort()).not.toEqual(lowest);
    // The order within the result is the lane's rotation, not asset id order.
    expect(found).not.toEqual([...found].sort());
  });

  it('reads the same slice for the same seed and a different slice for another seed', async () => {
    // Two cursors a quarter of the order apart read slices that are shifted by about a quarter of the library: they overlap,
    // but neither holds the other.
    const seedOne = seedBetween(0.05, 0.1, 'one');
    const seedTwo = seedBetween(0.35, 0.4, 'two');
    const one = await read({ rotation: seedOne });
    expect(await read({ rotation: seedOne })).toEqual(one);
    const two = await read({ rotation: seedTwo });
    expect(two).not.toEqual(one);
    expect(two.filter((id) => one.includes(id)).length).toBeLessThan(100);
    expect(two.filter((id) => !one.includes(id)).length).toBeGreaterThan(10);
  });

  it('reaches every asset of a library over decisions, however large it is', async () => {
    // A slice is about 46% of this library and no two of these cursors are 0.45 or more apart (going round), so the three
    // slices cover all of it.
    const seen = new Set<string>();
    for (const seed of [seedBetween(0, 0.1, 'a'), seedBetween(0.3, 0.4, 'b'), seedBetween(0.65, 0.75, 'c')])
      for (const id of await read({ rotation: seed })) seen.add(id);
    expect(everything().filter((id) => !seen.has(id))).toEqual([]);
  });

  it('wraps round at the end of the order, so a cursor near the end still reads a full lane', async () => {
    let seed = 0;
    while (rotationCursor(`wrap-${String(seed)}`) < 0.97) seed += 1;
    expect(await read({ rotation: `wrap-${String(seed)}` })).toHaveLength(100);
  });

  it('puts the topic’s primary assets before its supporting ones and never reads an incidental mention as the topic', async () => {
    for (const rotation of [undefined, 'a', 'b', 'c'] as const) {
      const found = await read({ topicIds: [TOPIC], ...(rotation ? { rotation } : {}) });
      expect(found.slice(0, 3).sort()).toEqual([...primary].sort());
      expect(found.slice(3, 6).sort()).toEqual([...supporting].sort());
      // Sixty assets that merely mention the topic would have filled the old lane's 40 slots, by asset id. Now they are
      // only the library.
      const topicLane = found.slice(0, 6);
      expect(topicLane.some((id) => incidental.includes(id))).toBe(false);
      expect(found).toHaveLength(100);
      expect(new Set(found).size).toBe(100);
    }
  });

  it('searches text only when the person supplied text', async () => {
    const withText = await read({ text: 'zzquasar' });
    expect(withText[0]).toBe(findable);
    // Without text there is no text lane: the read is the rotating sample alone, at the cap.
    expect(await read()).toHaveLength(100);
    // Text that matches nothing adds nothing and breaks nothing.
    expect(await read({ text: 'nomatchatall' })).toHaveLength(100);
  });

  describe('with a condition that holds for an explanation the person has not met (policy v2, D-408)', () => {
    // Content reads no personal table: the condition names a table of this test, as Experience names its own history.
    const unseenFirst = { text: 'not exists (select 1 from ci_met_units m where m.unit = {unit})', values: [] };
    let unseen: string[];

    beforeAll(async () => {
      await sql`create table ci_met_units (unit text primary key)`.execute(database.db);
      unseen = [library[3]!, library[70]!, library[100]!, library[140]!, primary[0]!];
      for (const id of everything().filter((candidate) => !unseen.includes(candidate)))
        await sql`insert into ci_met_units (unit) values (${`ci-lanes-${id}`})`.execute(database.db);
    });

    it('reads the unseen first however the cursor falls, where a plain slice misses some of them', async () => {
      // A plain slice is under half the library, so some seed misses at least one of the five: find one (deterministic).
      const missing = async (): Promise<string> => {
        for (let n = 0; ; n += 1) {
          const candidate = `miss-${String(n)}`;
          const plain = await read({ rotation: candidate });
          if (unseen.some((id) => !plain.includes(id))) return candidate;
        }
      };
      const rotation = await missing();
      const found = await read({ rotation, unseenFirst });
      expect(found).toHaveLength(100);
      expect(new Set(found).size).toBe(100);
      expect(found.slice(0, 5).sort()).toEqual([...unseen].sort());
      // The rest of the cap is filled with what the person has met: the last resort's material is never lost.
      expect(found.slice(5).some((id) => unseen.includes(id))).toBe(false);
    });

    it('reads the unseen of the source’s topic first, then the other unseen, then the rest', async () => {
      const found = await read({ topicIds: [TOPIC], rotation: 'topic-seed', unseenFirst });
      expect(found[0]).toBe(primary[0]);
      expect(found.slice(1, 5).sort()).toEqual(unseen.filter((id) => id !== primary[0]).sort());
      // Then the topic's met primary and supporting ones, ahead of the library's met ones.
      expect(found.slice(5, 7).every((id) => primary.includes(id) || supporting.includes(id))).toBe(true);
    });

    it('always reads the named units first, met or not, so the source’s format twin is found', async () => {
      const found = await read({ rotation: 'any', unseenFirst, alwaysUnits: [`ci-lanes-${library[0]!}`] });
      expect(found[0]).toBe(library[0]);
      expect(found.slice(1, 6).sort()).toEqual([...unseen].sort());
    });

    it('is the plain read, in the same order, when it holds for everything or for nothing', async () => {
      const plain = await read({ rotation: 'same' });
      expect(await read({ rotation: 'same', unseenFirst: { text: 'true', values: [] } })).toEqual(plain);
      expect(await read({ rotation: 'same', unseenFirst: { text: 'false', values: [] } })).toEqual(plain);
    });

    it('refuses a condition that is not plain: a quote, a semicolon or a comment never reaches the database', async () => {
      await expect(read({ unseenFirst: { text: "{unit} = 'x'", values: [] } })).rejects.toThrow(
        'UNIT_CONDITION_INVALID',
      );
      await expect(read({ unseenFirst: { text: '{unit} is null; select 1', values: [] } })).rejects.toThrow(
        'UNIT_CONDITION_INVALID',
      );
    });
  });

  it('gives each revision its own stable key in [0, 1), and keeps the bound on topics', async () => {
    // A revision admitted now is given its key by the column default (the projection trigger never names it).
    const fresh = await admitReel();
    const freshKey = (
      await sql<{
        serve_rand: number;
      }>`select serve_rand from content.discovery_revisions where asset_id=${fresh}::uuid`.execute(database.db)
    ).rows[0]!.serve_rand;
    expect(freshKey).toBeGreaterThanOrEqual(0);
    expect(freshKey).toBeLessThan(1);
    const rows = await sql<{ serve_rand: number }>`select serve_rand from content.discovery_revisions`.execute(
      database.db,
    );
    expect(rows.rows.length).toBeGreaterThan(200);
    expect(rows.rows.every((row) => row.serve_rand >= 0 && row.serve_rand < 1)).toBe(true);
    expect(new Set(rows.rows.map((row) => row.serve_rand)).size).toBe(rows.rows.length);
    const before = await sql<{
      serve_rand: number;
    }>`select serve_rand from content.discovery_revisions where asset_id=${library[0]!}::uuid`.execute(database.db);
    expect(
      (
        await sql<{
          serve_rand: number;
        }>`select serve_rand from content.discovery_revisions where asset_id=${library[0]!}::uuid`.execute(database.db)
      ).rows,
    ).toEqual(before.rows);
    await expect(
      withScope()(person.authority, (scope) =>
        readDiscoveryCandidates(scope, {
          languages: ['en'],
          formats: ['reel'],
          capabilities,
          topicIds: Array.from({ length: 17 }, (_, n) => `ci.t${String(n)}`),
        }),
      ),
    ).rejects.toThrow('DISCOVERY_QUERY_INVALID');
  });

  it('is served from the index on the key', async () => {
    const indexes = await sql<{
      indexdef: string;
    }>`select indexdef from pg_indexes where schemaname='content' and indexname='discovery_serve_rand_idx'`.execute(
      database.db,
    );
    expect(indexes.rows[0]?.indexdef).toContain('(serve_rand, asset_id, asset_revision)');
  });
});
