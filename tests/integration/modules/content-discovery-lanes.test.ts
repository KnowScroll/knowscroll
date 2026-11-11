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

  const read = async (query: { topicIds?: string[]; text?: string; rotation?: string; limit?: number } = {}) => {
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
  });
  afterAll(async () => {
    await database.drop();
  });

  const everything = () => [...library, ...primary, ...supporting, ...incidental, findable];

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
    const one = await read({ rotation: 'decision-one' });
    expect(await read({ rotation: 'decision-one' })).toEqual(one);
    const two = await read({ rotation: 'decision-two' });
    expect(two).not.toEqual(one);
    expect(new Set(two.filter((id) => one.includes(id))).size).toBeLessThan(100);
  });

  it('reaches every asset of a library over decisions, however large it is', async () => {
    const seen = new Set<string>();
    for (let n = 0; n < 20; n += 1) for (const id of await read({ rotation: `command-${String(n)}` })) seen.add(id);
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

  it('gives each revision its own stable key in [0, 1), and keeps the bound on topics', async () => {
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
