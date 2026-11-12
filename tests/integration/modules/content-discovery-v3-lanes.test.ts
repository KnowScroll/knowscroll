/**
 * Named retrieval lanes (policy v3, #674 slice 4.2, D-420) on real PostgreSQL: `source`, `planned`, `continue` (the person's top
 * interest topics, with a per-system quota), `adjacent` (siblings in the source's systems) and `explore` (a sample stratified
 * by system), each candidate carrying the lane that read it first, with the unseen-first bands and the rotation cursor of D-408
 * applying to every lane. Labelled CI fixtures: Reel rows with a valid document and no media, which is all retrieval reads.
 * Nothing here is product data.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { fixtureSnapshot, planSnapshot } from '@knowscroll/backend/modules/content';
import { readDiscoveryCandidates } from '@knowscroll/backend/modules/content/nest-providers';
import { rotationCursor } from '../../../packages/backend/src/modules/content/adapters/discovery-store.js';
import { continueLane } from '../../../packages/backend/src/modules/content/adapters/discovery-lanes.js';
import { DISCOVERY_LANE_QUOTAS } from '../../../packages/backend/src/modules/content/domain/discovery-lanes.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { textCapabilities } from '../support/scroll.js';

/** The catalogue release the lanes read (the one the test database was seeded with: release 1, the library plan). */
const catalogue = planSnapshot();
const capabilities = { ...textCapabilities, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] };

/** The topics of the fixture library, how many assets each has, and the catalogue system each belongs to. */
const SHAPE: readonly { readonly topic: string; readonly count: number; readonly system: string }[] = [
  { topic: 'earth.seasons', count: 8, system: 'earth' },
  { topic: 'earth.tides', count: 6, system: 'earth' },
  { topic: 'earth.greenhouse-effect', count: 4, system: 'earth' },
  { topic: 'space.stars', count: 12, system: 'space' },
  { topic: 'space.black-holes', count: 8, system: 'space' },
  { topic: 'space.exoplanets', count: 6, system: 'space' },
  { topic: 'computing.browsers', count: 8, system: 'computing' },
  { topic: 'computing.algorithms', count: 6, system: 'computing' },
  { topic: 'machine-learning.attention', count: 10, system: 'machine-learning' },
  { topic: 'human-body.immune-system', count: 6, system: 'human-body' },
  { topic: 'history.industrial-revolution', count: 6, system: 'history' },
];
const SOURCE_TOPIC = 'earth.seasons';
const CONTINUE = [
  'space.stars',
  'space.black-holes',
  'space.exoplanets',
  'computing.browsers',
  'machine-learning.attention',
  'human-body.immune-system',
];

describe('retrieval lanes (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let person: FixturePerson;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  /** asset id -> its topic (a fixture asset has one primary topic, or none). */
  const topicOf = new Map<string, string | undefined>();
  const unitOf = (id: string) => `ci-lanes3-${id}`;

  async function admitReel(topic?: string): Promise<string> {
    const assetId = randomUUID();
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId,
      revision: 1,
      title: '[Fixture] a Reel',
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
        ${'0'.repeat(64)}, ${unitOf(assetId)}, 'en', '[Fixture] a Reel', '{}'::jsonb)`.execute(database.db);
    if (topic !== undefined)
      await database.db
        .insertInto('content.encounter_topics')
        .values({ asset_id: assetId, asset_revision: 1, topic_id: topic, role: 'primary', weight: 1 })
        .execute();
    topicOf.set(assetId, topic);
    return assetId;
  }

  interface Found {
    readonly assetId: string;
    readonly lane?: string;
    readonly explanationUnitId: string;
  }
  const read = async (
    query: Omit<Parameters<typeof readDiscoveryCandidates>[1], 'languages' | 'formats' | 'capabilities'> = {},
  ): Promise<readonly Found[]> => {
    const entered = await withScope()(person.authority, (scope) =>
      readDiscoveryCandidates(scope, { languages: ['en'], formats: ['reel'], capabilities, ...query }),
    );
    if (entered.kind !== 'entered') throw new Error('CI scope refused');
    return entered.value;
  };
  const systemOf = (assetId: string): string => SHAPE.find((s) => s.topic === topicOf.get(assetId))?.system ?? 'none';
  const ofLane = (found: readonly Found[], lane: string) => found.filter((c) => c.lane === lane).map((c) => c.assetId);

  let planned: string;
  const sourceAssets: string[] = [];
  const lanes = { continueTopicIds: CONTINUE, plannedUnitIds: [] as string[], catalogue };

  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_lanes_v3');
    person = await seedPerson(database.db);
    for (const { topic, count } of SHAPE)
      for (let n = 0; n < count; n += 1) {
        const id = await admitReel(topic);
        if (topic === SOURCE_TOPIC) sourceAssets.push(id);
        if (topic === 'history.industrial-revolution' && n === 0) planned = id;
      }
    for (let n = 0; n < 20; n += 1) await admitReel();
    lanes.plannedUnitIds = [unitOf(planned)];
    // Evenly spaced keys in an order unrelated to the asset ids, so every assertion below is about the lanes and not about a lucky key.
    await sql`update content.discovery_revisions d set serve_rand = k.rank::float8 / k.total
      from (select asset_id, asset_revision, row_number() over (order by md5(asset_id::text)) - 1 as rank, count(*) over () as total
            from content.discovery_revisions) k
      where d.asset_id = k.asset_id and d.asset_revision = k.asset_revision`.execute(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  const laned = (extra: Parameters<typeof read>[0] = {}) =>
    read({ topicIds: [SOURCE_TOPIC], rotation: 'seed-a', lanes, ...extra });

  it('names no lane without lanes, so v0 to v2 read as they did', async () => {
    const plain = await read({ topicIds: [SOURCE_TOPIC], rotation: 'seed-a' });
    expect(plain.length).toBeGreaterThan(50);
    expect(plain.every((c) => c.lane === undefined)).toBe(true);
  });

  it('labels every candidate with a lane, reads each asset once and stays within the cap', async () => {
    const found = await laned();
    expect(found.length).toBe(100);
    expect(new Set(found.map((c) => c.assetId)).size).toBe(found.length);
    expect(found.every((c) => c.lane !== undefined)).toBe(true);
    expect(new Set(found.map((c) => c.lane))).toEqual(
      new Set(['source', 'planned', 'continue', 'adjacent', 'explore']),
    );
  });

  it('reads the source’s own topic first, as the source lane, and then the planned unit', async () => {
    const found = await laned();
    expect(
      found
        .slice(0, 8)
        .map((c) => c.assetId)
        .sort(),
    ).toEqual([...sourceAssets].sort());
    expect(found.slice(0, 8).every((c) => c.lane === 'source')).toBe(true);
    expect(found[8]).toMatchObject({ assetId: planned, lane: 'planned' });
    expect(ofLane(found, 'planned')).toEqual([planned]);
  });

  it('reads the continue lane from the person’s top topics, at most five of any one system, so one loved system cannot take it all', async () => {
    const found = await laned();
    const continued = ofLane(found, 'continue');
    expect(continued.length).toBeGreaterThan(8);
    expect(continued.every((id) => CONTINUE.includes(topicOf.get(id)!))).toBe(true);
    const perSystem = new Map<string, number>();
    for (const id of continued) perSystem.set(systemOf(id), (perSystem.get(systemOf(id)) ?? 0) + 1);
    for (const count of perSystem.values()) expect(count).toBeLessThanOrEqual(5);
    // Space has 26 assets on three of the top topics and the lane still reaches the other systems.
    expect([...perSystem.keys()].sort()).toEqual(['computing', 'human-body', 'machine-learning', 'space']);
    expect(perSystem.get('space')).toBe(5);
  });

  it('ranks the continue lane by how strong the person’s interest in the topic is: the strongest topic’s assets come first', async () => {
    const found = await laned({ lanes: { ...lanes, continueTopicIds: ['space.exoplanets', 'space.stars'] } });
    const continued = ofLane(found, 'continue');
    // Five from Space, taken from the strongest topic first: every Exoplanets asset (six, five fit) before any Stars one.
    expect(continued).toHaveLength(5);
    expect(continued.every((id) => topicOf.get(id) === 'space.exoplanets')).toBe(true);
  });

  it('reads the adjacent lane from the other topics of the source’s system, never the source’s own', async () => {
    const found = await laned();
    const adjacent = ofLane(found, 'adjacent');
    expect(adjacent).toHaveLength(10);
    expect(adjacent.every((id) => ['earth.tides', 'earth.greenhouse-effect'].includes(topicOf.get(id)!))).toBe(true);
  });

  it('reads the adjacent lane from the release it is given: a sibling still waiting for supply or retired is not adjacent', async () => {
    const plan = planSnapshot();
    const concepts = plan.all().map((concept) => ({
      id: concept.id,
      parent: concept.parent,
      facets: concept.facets.map((facet) => facet.id),
    }));
    // A later release that retires Greenhouse effect and a topic of the system that is waiting for supply: only servable, active topics count.
    const later = fixtureSnapshot(concepts, 2, { waiting: ['earth.tides'], retired: ['earth.greenhouse-effect'] });
    expect(ofLane(await laned({ lanes: { ...lanes, catalogue: later } }), 'adjacent')).toEqual([]);
    // Only Greenhouse effect retired: its sibling, Tides, is still adjacent, and the retired topic never is.
    const retired = fixtureSnapshot(concepts, 2, { retired: ['earth.greenhouse-effect'] });
    const adjacent = ofLane(await laned({ lanes: { ...lanes, catalogue: retired } }), 'adjacent');
    expect(adjacent).toHaveLength(6);
    expect(adjacent.every((id) => topicOf.get(id) === 'earth.tides')).toBe(true);
    // The read of the release before it is unchanged: a later release changes only the reads that name it.
    expect(ofLane(await laned(), 'adjacent')).toHaveLength(10);
  });

  it('stratifies the explore lane by system: round-robin, so a few of every system come before many of one, and it fills the rest of the cap', async () => {
    const found = await laned();
    const explored = ofLane(found, 'explore');
    expect(explored.length).toBeGreaterThan(20);
    // The lane reaches most systems (the library has six, and unattributed assets), though the other lanes have claimed some of its rows.
    expect(new Set(explored.map(systemOf)).size).toBeGreaterThanOrEqual(5);
    // A person with no history and no source still gets a full read: the explore lane takes what no other lane claims.
    const cold = await read({ rotation: 'seed-a', lanes: { continueTopicIds: [], plannedUnitIds: [], catalogue } });
    expect(cold.every((c) => c.lane === 'explore')).toBe(true);
    expect(cold).toHaveLength(100);
    expect(new Set(cold.slice(0, 7).map((c) => systemOf(c.assetId))).size).toBe(7);
  });

  it('gives a candidate the first of the lanes that read it: an asset of the source’s topic that is also a top topic is `source`', async () => {
    const found = await laned({ lanes: { ...lanes, continueTopicIds: [SOURCE_TOPIC, ...CONTINUE] } });
    expect(ofLane(found, 'source').sort()).toEqual([...sourceAssets].sort());
    expect(found.filter((c) => topicOf.get(c.assetId) === SOURCE_TOPIC).every((c) => c.lane === 'source')).toBe(true);
  });

  it('reads the same slice for the same seed and moves the explore lane with the cursor', async () => {
    const one = await laned({ rotation: 'seed-one' });
    expect(await laned({ rotation: 'seed-one' })).toEqual(one);
    const apart = (seed: string) => {
      const gap = Math.abs(rotationCursor(seed) - rotationCursor('seed-one'));
      return Math.min(gap, 1 - gap);
    };
    let other = 'seed-two';
    while (apart(other) < 0.3) other += 'x';
    const two = await laned({ rotation: other });
    const explore = (found: readonly Found[]) => ofLane(found, 'explore').sort();
    expect(explore(two)).not.toEqual(explore(one));
  });

  describe('with the explanation units the person has met (the unseen-first bands of D-408 apply to every lane)', () => {
    it('reads every unseen candidate before any met one, and a met one keeps its lane', async () => {
      const metIds = [
        ...sourceAssets.slice(0, 5),
        ...[...topicOf.keys()].filter((id) => topicOf.get(id) === 'space.stars').slice(0, 6),
      ];
      const unseenFirst = { metUnitIds: metIds.map(unitOf) };
      const found = await laned({ unseenFirst });
      const firstMet = found.findIndex((c) => metIds.includes(c.assetId));
      expect(firstMet).toBeGreaterThan(0);
      expect(found.slice(firstMet).every((c) => metIds.includes(c.assetId))).toBe(true);
      expect(found.slice(0, firstMet).some((c) => metIds.includes(c.assetId))).toBe(false);
      // The met source assets are still read (the last resort's material), still as the source lane.
      for (const id of sourceAssets.slice(0, 5)) expect(found.find((c) => c.assetId === id)?.lane).toBe('source');
    });

    it('reads the unseen planned unit and the unseen of the source’s topic first, and always reads the named units first', async () => {
      const unseenFirst = { metUnitIds: [unitOf(sourceAssets[0]!)] };
      const found = await laned({ unseenFirst });
      expect(found[0]!.assetId).not.toBe(sourceAssets[0]);
      expect(found.findIndex((c) => c.assetId === sourceAssets[0])).toBeGreaterThan(
        found.findIndex((c) => c.lane === 'explore'),
      );
      const twin = [...topicOf.keys()].find((id) => topicOf.get(id) === undefined)!;
      const named = await laned({ unseenFirst, alwaysUnits: [unitOf(twin)] });
      expect(named[0]).toMatchObject({ assetId: twin, lane: 'source' });
    });

    it('is the same read, lanes and all, when the person has met nothing', async () => {
      const plain = await laned();
      expect(await laned({ unseenFirst: { metUnitIds: [] } })).toEqual(plain);
    });
  });

  it('reads nothing of a lane with no input: no continue topics and no planned units leave the other lanes alone', async () => {
    const found = await laned({ lanes: { continueTopicIds: [], plannedUnitIds: [], catalogue } });
    expect(ofLane(found, 'continue')).toEqual([]);
    expect(ofLane(found, 'planned')).toEqual([]);
    expect(ofLane(found, 'source').length).toBe(8);
    expect(ofLane(found, 'adjacent').length).toBe(10);
  });

  it('treats a topic the catalogue does not hold as its own stratum, and takes lane input as data', async () => {
    const found = await laned({
      lanes: {
        continueTopicIds: ["x'; drop table content.assets; --", 'ci.unknown.topic'],
        plannedUnitIds: ["unit'; drop table content.assets; --"],
        catalogue,
      },
    });
    expect(ofLane(found, 'continue')).toEqual([]);
    expect(found.length).toBeGreaterThan(40);
    expect(
      (await sql<{ n: string }>`select count(*)::text as n from content.assets`.execute(database.db)).rows[0]!.n,
    ).not.toBe('0');
  });

  it('refuses lane input that is not a bounded list of ids, and honours the limit', async () => {
    const tooMany = Array.from({ length: 65 }, (_, n) => `ci.topic.${String(n)}`);
    await expect(laned({ lanes: { continueTopicIds: tooMany, plannedUnitIds: [], catalogue } })).rejects.toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    await expect(laned({ lanes: { continueTopicIds: [''], plannedUnitIds: [], catalogue } })).rejects.toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(await laned({ limit: 12 })).toHaveLength(12);
  });
});

describe('the continue lane reads a capped window of each top topic, however large the topics are (real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  let person: FixturePerson;
  const TOPICS = [
    'earth.seasons',
    'earth.tides',
    'space.stars',
    'space.exoplanets',
    'computing.browsers',
    'machine-learning.attention',
    'human-body.immune-system',
    'history.industrial-revolution',
  ];
  const PER_TOPIC = 800;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('content_lanes_v3_window');
    person = await seedPerson(database.db);
    // Eight topics of 800 admitted Reels each (6,400 in all): the shape a large library gives a person's top topics.
    // Ids are derived, so one statement of each kind creates the library.
    const total = TOPICS.length * PER_TOPIC;
    const document = JSON.stringify({
      schemaVersion: 'reel-document.v1',
      assetId: '00000000-0000-4000-8000-000000000000',
      revision: 1,
      title: 'Fixture',
      summary: 'CI fixture',
      language: 'en',
      truthLabel: 'generated',
      fixture: true,
      captions: 'burned_in',
      mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
      durationMs: 20_000,
      width: 1080,
      height: 1920,
    });
    await sql`insert into content.assets(id, revision, kind, status)
      select md5('ci-window-' || n)::uuid, 1, 'reel', 'admitted' from generate_series(1, ${total}) n`.execute(
      database.db,
    );
    await sql`insert into content.asset_revisions(asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
      select md5('ci-window-' || n)::uuid, 1, 'generated', 'reel-document.v1', ${document}::jsonb, ${'0'.repeat(64)}, 'ci-window-' || n, 'en', 'Fixture', '{}'::jsonb
      from generate_series(1, ${total}) n`.execute(database.db);
    await sql`insert into content.encounter_topics(asset_id, asset_revision, topic_id, role, weight)
      select md5('ci-window-' || n)::uuid, 1, (${TOPICS}::text[])[1 + (n % ${TOPICS.length})], 'primary', 1 from generate_series(1, ${total}) n`.execute(
      database.db,
    );
    // Autovacuum would have analysed a library of this size; a test database has not had the time.
    for (const table of ['assets', 'asset_revisions', 'discovery_revisions', 'encounter_topics'])
      await sql`analyze ${sql.table(`content.${table}`)}`.execute(database.db);
  });
  afterAll(async () => {
    await database.drop();
  });

  interface PlanNode {
    'Node Type': string;
    'Index Name'?: string;
    'Actual Rows'?: number;
    'Actual Loops'?: number;
    'Shared Hit Blocks'?: number;
    'Shared Read Blocks'?: number;
    Plans?: PlanNode[];
  }
  const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

  it('plans an index scan of each topic’s window, so what it reads is the windows and not the 6,400 assets', async () => {
    const eligible = sql`a.status='admitted' and r.language='en' and a.kind='reel'`;
    const plan = await sql<{
      'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[];
    }>`explain (analyze, buffers, format json)
      select asset_id from ((select null::uuid as asset_id,0 as band,0 as priority,0 as role_rank,0::float8 as rot,'source'::text as lane where false)
        ${continueLane(catalogue, TOPICS, 0.37, 1, eligible)}) lanes`.execute(database.db);
    const nodes = flatten(plan.rows[0]!['QUERY PLAN'][0]!.Plan);
    const scans = nodes.filter((n) => n['Index Name'] === 'encounter_topics_rand_idx');
    expect(scans.length).toBeGreaterThan(0);
    // The attributions it read: at most the windows (eight topics, two sides, six each), whatever the topics hold.
    const read = scans.reduce((sum, n) => sum + (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1), 0);
    expect(read).toBeLessThanOrEqual(TOPICS.length * 2 * DISCOVERY_LANE_QUOTAS.continuePerTopic);
    // Nothing reads the table: no sequential scan anywhere in the lane.
    expect(
      nodes.some(
        (n) => n['Node Type'] === 'Seq Scan' && n['Index Name'] === undefined && (n['Actual Rows'] ?? 0) > 100,
      ),
    ).toBe(false);
    const buffers = nodes.reduce((sum, n) => sum + (n['Shared Hit Blocks'] ?? 0) + (n['Shared Read Blocks'] ?? 0), 0);
    expect(buffers).toBeLessThan(40_000);
  });

  it('still gives each top topic its candidates, at most five of any one system, from a window that moves with the cursor', async () => {
    const read = async (rotation: string) => {
      const entered = await withScope()(person.authority, (scope) =>
        readDiscoveryCandidates(scope, {
          languages: ['en'],
          formats: ['reel'],
          capabilities,
          rotation,
          lanes: { continueTopicIds: TOPICS, plannedUnitIds: [], catalogue },
        }),
      );
      if (entered.kind !== 'entered') throw new Error('CI scope refused');
      return entered.value.filter((c) => c.lane === 'continue');
    };
    const one = await read('window-one');
    expect(one.length).toBeGreaterThan(10);
    expect(one.length).toBeLessThanOrEqual(DISCOVERY_LANE_QUOTAS.continue);
    const perTopic = new Map<string, number>();
    for (const c of one) perTopic.set(c.topics[0]!.topicId, (perTopic.get(c.topics[0]!.topicId) ?? 0) + 1);
    for (const count of perTopic.values()) expect(count).toBeLessThanOrEqual(DISCOVERY_LANE_QUOTAS.continuePerTopic);
    expect(await read('window-one')).toEqual(one);
    // Another cursor reads another window of the same topics.
    let other = 'window-two';
    const apart = (seed: string) => {
      const gap = Math.abs(rotationCursor(seed) - rotationCursor('window-one'));
      return Math.min(gap, 1 - gap);
    };
    while (apart(other) < 0.3) other += 'x';
    expect((await read(other)).map((c) => c.assetId)).not.toEqual(one.map((c) => c.assetId));
  });
});
