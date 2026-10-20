import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import type { EnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { projectScrollReadingQueue } from '@knowscroll/backend/modules/evidence';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { activatedAgo, coverage, dwell, event, openActive, type OpenedFixture } from '../support/observations.js';
import { admitStarter, scrollUseCases, starterSource } from '../support/scroll.js';

describe('observation intake (real database)', () => {
  let database: TestDatabase<Database>;
  let useCases: Awaited<ReturnType<typeof scrollUseCases>>;
  let starter: { assetId: string; revision: number };
  let blocks: string[];
  beforeAll(async () => {
    database = await createTestDatabase<Database>('observations');
    useCases = await scrollUseCases(database);
    starter = await admitStarter(useCases.importScroll);
    const facts = await database.db
      .selectFrom('content.asset_revisions')
      .select('reading_facts')
      .where('asset_id', '=', starter.assetId)
      .executeTakeFirstOrThrow();
    blocks = (facts.reading_facts as { blocks: { id: string }[] }).blocks.map((block) => block.id);
  });
  afterAll(async () => {
    await useCases.close();
    await database.drop();
  });

  const ingest = (person: FixturePerson, events: readonly InteractionEvent[], instrumentationVersion = 1) =>
    useCases.ingestObservations(person.authority, { instrumentationVersion, events });

  async function observationCount(universeId: string, exposureId?: string): Promise<number> {
    let query = database.db
      .selectFrom('evidence.observations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('universe_id', '=', universeId);
    if (exposureId !== undefined) query = query.where('exposure_id', '=', exposureId);
    return Number((await query.executeTakeFirstOrThrow()).n);
  }

  async function projectionJobs(universeId: string): Promise<number> {
    const result = await sql<{
      n: number;
    }>`select count(*)::int as n from pgboss.job where name = ${projectScrollReadingQueue.name} and data ->> 'universeId' = ${universeId}`.execute(
      database.db,
    );
    return result.rows[0]?.n ?? 0;
  }

  async function setup(): Promise<{ person: FixturePerson; exposure: OpenedFixture }> {
    const person = await seedPerson(database.db);
    return { person, exposure: await openActive(useCases, person, starter) };
  }

  it('stores a valid batch, acknowledges it as stored, and enqueues one projection job for the exposure', async () => {
    const { person, exposure } = await setup();
    await activatedAgo(database.db, exposure.exposureId, 10);
    const events = [
      event(exposure, coverage(blocks.slice(0, 3), 4_000)),
      event(exposure, dwell([0, 12_000])),
      event(exposure, {
        kind: 'scroll.block_interaction',
        payload: { blockId: 'violet-eye', kind: 'expanded', atMs: 8_000 },
      }),
    ];
    const result = await ingest(person, events);
    expect(result).toMatchObject({
      kind: 'ingested',
      accepted: 3,
      duplicates: 0,
      rejected: 0,
      revision: expect.any(Number) as unknown,
    });
    if (result.kind !== 'ingested') return;
    expect(result.results.map((entry) => entry.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const stored = await database.db
      .selectFrom('evidence.observations')
      .select([
        'seq',
        'kind',
        'event_id',
        'session_id',
        'device_sequence',
        'privacy_epoch',
        'instrumentation_version',
        'bounded',
      ])
      .where('universe_id', '=', person.universeId)
      .orderBy('seq')
      .execute();
    expect(
      stored.map((row) => [row.seq, row.kind, row.privacy_epoch, row.instrumentation_version, row.bounded]),
    ).toEqual([
      [1, 'scroll.block_coverage', 1, 1, false],
      [2, 'scroll.active_dwell', 1, 1, false],
      [3, 'scroll.block_interaction', 1, 1, false],
    ]);
    expect(stored.map((row) => row.event_id)).toEqual(events.map((entry) => entry.eventId));
    // Intake changes nothing a client reads: the universe revision is the projection's to advance.
    const universe = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(universe.revision).toBe(0);
    expect(await projectionJobs(person.universeId)).toBe(1);
  });

  it('validates canonical interaction kinds against the immutable block type, including nested blocks', async () => {
    const { person, exposure } = await setup();
    const result = await ingest(person, [
      event(exposure, {
        kind: 'scroll.block_interaction',
        payload: { blockId: 'violet-eye', kind: 'expanded', atMs: 100 },
      }),
      event(exposure, {
        kind: 'scroll.block_interaction',
        payload: { blockId: 'violet-eye', kind: 'param-changed', atMs: 100 },
      }),
      event(exposure, {
        kind: 'scroll.block_interaction',
        payload: { blockId: 'violet-eye-cones', kind: 'expanded', atMs: 100 },
      }),
    ]);
    expect(result).toMatchObject({ accepted: 1, rejected: 2 });
    if (result.kind === 'ingested')
      expect(result.results.slice(1)).toEqual([
        { eventId: expect.any(String), status: 'rejected', reason: 'interaction_kind_invalid' },
        { eventId: expect.any(String), status: 'rejected', reason: 'interaction_kind_invalid' },
      ]);
  });

  it('continues intake from an immutable document when stored derived facts have an older version', async () => {
    const source = starterSource() as { assetId: string };
    source.assetId = randomUUID();
    const imported = await useCases.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture import refused');
    const person = await seedPerson(database.db);
    const exposure = await openActive(useCases, person, imported);
    await sql`update content.asset_revisions set reading_facts = '{"v":1}'::jsonb where asset_id = ${source.assetId}`.execute(
      database.db,
    );
    expect(await ingest(person, [event(exposure, dwell([0, 500]))])).toMatchObject({ accepted: 1, rejected: 0 });
    expect(await useCases.importScroll(source)).toMatchObject({ outcome: 'facts_refreshed' });
  });

  it('counts nothing twice when the same batch is retried, and enqueues no second job', async () => {
    const { person, exposure } = await setup();
    await activatedAgo(database.db, exposure.exposureId, 10);
    const events = [event(exposure, coverage(blocks.slice(0, 2), 3_000)), event(exposure, dwell([0, 6_000]))];
    expect(await ingest(person, events)).toMatchObject({ accepted: 2, duplicates: 0 });
    const retried = await ingest(person, events);
    expect(retried).toMatchObject({ kind: 'ingested', accepted: 0, duplicates: 2, rejected: 0 });
    expect(await observationCount(person.universeId)).toBe(2);
    expect(await projectionJobs(person.universeId)).toBe(1);
    // A partially retried batch: only the new event is stored.
    const extra = event(exposure, dwell([6_000, 9_000]));
    expect(await ingest(person, [...events, extra])).toMatchObject({ accepted: 1, duplicates: 2 });
    expect(await observationCount(person.universeId)).toBe(3);
  });

  it('keeps the first writer when an event ID arrives again with other content', async () => {
    const { person, exposure } = await setup();
    await activatedAgo(database.db, exposure.exposureId, 10);
    const eventId = randomUUID();
    await ingest(person, [event(exposure, dwell([0, 2_000]), { eventId })]);
    const second = await ingest(person, [event(exposure, dwell([0, 9_000]), { eventId })]);
    expect(second).toMatchObject({ accepted: 0, duplicates: 1 });
    const row = await database.db
      .selectFrom('evidence.observations')
      .select('payload')
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual({ activeIntervalsMs: [[0, 2_000]] });
  });

  it('serialises concurrent retries of one batch: every event is accepted once in total', async () => {
    const { person, exposure } = await setup();
    await activatedAgo(database.db, exposure.exposureId, 10);
    const events = [event(exposure, coverage(blocks.slice(0, 2), 2_000)), event(exposure, dwell([0, 4_000]))];
    const [a, b] = await Promise.all([ingest(person, events), ingest(person, events)]);
    const total = [a, b].map((result) => (result.kind === 'ingested' ? result.accepted : -1));
    expect(total.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(await observationCount(person.universeId)).toBe(2);
  });

  it("refuses another person's exposure and an unknown one the same way, and stores nothing", async () => {
    const owner = await setup();
    const stranger = await seedPerson(database.db);
    const foreign = await ingest(stranger, [event(owner.exposure, dwell([0, 1_000]))]);
    expect(foreign).toMatchObject({ kind: 'ingested', accepted: 0, rejected: 1 });
    const unknown = await ingest(owner.person, [
      event({ ...owner.exposure, exposureId: randomUUID() }, dwell([0, 1_000])),
    ]);
    expect(unknown).toMatchObject({ kind: 'ingested', accepted: 0, rejected: 1 });
    for (const result of [foreign, unknown])
      if (result.kind === 'ingested')
        expect(result.results[0]).toMatchObject({ status: 'rejected', reason: 'exposure_unknown' });
    expect(await observationCount(owner.person.universeId)).toBe(0);
    expect(await observationCount(stranger.universeId)).toBe(0);
    expect(await projectionJobs(owner.person.universeId)).toBe(0);
  });

  it('refuses a block the revision does not have, a wrong revision, and an exposure that was never activated', async () => {
    const { person, exposure } = await setup();
    const unknownBlock = await ingest(person, [
      event(exposure, {
        kind: 'scroll.block_coverage',
        payload: { blocks: [{ blockId: 'no-such-block', intervalsMs: [[0, 1_000]], peakFraction: 1 }] },
      }),
      event(exposure, {
        kind: 'scroll.block_interaction',
        payload: { blockId: 'no-such-block', kind: 'token-dropped', atMs: 100 },
      }),
    ]);
    expect(unknownBlock).toMatchObject({ accepted: 0, rejected: 2 });
    if (unknownBlock.kind === 'ingested')
      expect(unknownBlock.results.map((entry) => (entry.status === 'rejected' ? entry.reason : entry.status))).toEqual([
        'block_unknown',
        'block_unknown',
      ]);
    const wrongRevision = await ingest(person, [
      { ...event(exposure, dwell([0, 1_000])), assetRevision: starter.revision + 1 },
    ]);
    if (wrongRevision.kind === 'ingested')
      expect(wrongRevision.results[0]).toMatchObject({ status: 'rejected', reason: 'lineage_mismatch' });
    const otherAsset = await ingest(person, [{ ...event(exposure, dwell([0, 1_000])), assetId: randomUUID() }]);
    if (otherAsset.kind === 'ingested')
      expect(otherAsset.results[0]).toMatchObject({ status: 'rejected', reason: 'lineage_mismatch' });

    const inactive = await seedPerson(database.db);
    const idle = await openActive(useCases, inactive, starter, { activate: false });
    const early = await ingest(inactive, [event(idle, dwell([0, 1_000]))]);
    if (early.kind === 'ingested')
      expect(early.results[0]).toMatchObject({ status: 'rejected', reason: 'exposure_not_active' });
    expect(await observationCount(person.universeId)).toBe(0);
    expect(await observationCount(inactive.universeId)).toBe(0);
  });

  it('bounds claims instead of trusting them: no interval can reach past the wall time since activation', async () => {
    const { person, exposure } = await setup();
    // Activated moments ago, so one hour of claimed reading is beyond what the clock allows.
    const result = await ingest(person, [
      event(exposure, dwell([0, 3_600_000])),
      event(exposure, coverage([blocks[0] ?? ''], 3_600_000)),
      event(exposure, dwell([2_000_000, 2_100_000])),
      event(exposure, {
        kind: 'scroll.block_interaction',
        payload: { blockId: 'violet-eye', kind: 'expanded', atMs: 3_000_000 },
      }),
    ]);
    expect(result).toMatchObject({ kind: 'ingested', accepted: 4 });
    const rows = await database.db
      .selectFrom('evidence.observations')
      .select(['kind', 'bounded', 'payload'])
      .where('universe_id', '=', person.universeId)
      .orderBy('seq')
      .execute();
    expect(rows.every((row) => row.bounded)).toBe(true);
    const firstDwell = rows[0]?.payload as { activeIntervalsMs: [number, number][] };
    expect(firstDwell.activeIntervalsMs).toHaveLength(1);
    expect(firstDwell.activeIntervalsMs[0]?.[0]).toBe(0);
    // Elapsed since activation plus the 2 s allowance: seconds, not an hour.
    expect(firstDwell.activeIntervalsMs[0]?.[1]).toBeLessThan(30_000);
    expect((rows[2]?.payload as { activeIntervalsMs: unknown[] }).activeIntervalsMs).toEqual([]);
    expect((rows[3]?.payload as { atMs: number }).atMs).toBeLessThan(30_000);
  });

  it('clamps a claimed future time and refuses an event older than a week', async () => {
    const { person, exposure } = await setup();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const old = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    const result = await ingest(person, [
      event(exposure, dwell([0, 500]), { occurredAt: future }),
      event(exposure, dwell([0, 500]), { occurredAt: old }),
    ]);
    expect(result).toMatchObject({ kind: 'ingested', accepted: 1, rejected: 1 });
    if (result.kind === 'ingested') expect(result.results[1]).toMatchObject({ status: 'rejected', reason: 'too_old' });
    const row = await database.db
      .selectFrom('evidence.observations')
      .select(['occurred_at', 'received_at', 'bounded'])
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(row.bounded).toBe(true);
    expect(new Date(row.occurred_at).getTime()).toBe(new Date(row.received_at).getTime());
  });

  it("refuses the rest of an exposure's events once its intake limit is reached", async () => {
    const { person, exposure } = await setup();
    await sql`insert into evidence.observations (universe_id, id, event_id, session_id, device_sequence, exposure_id, seq, asset_id, asset_revision, schema_version, kind, instrumentation_version, occurred_at, received_at, payload, privacy_epoch)
      select ${person.universeId}::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, ${exposure.exposureId}::uuid, n, ${exposure.assetId}::uuid, ${exposure.assetRevision}, 'interaction.v1', 'scroll.active_dwell', 1, now(), now(), '{"activeIntervalsMs":[]}'::jsonb, 1
      from generate_series(1, 1000) as n`.execute(database.db);
    const result = await ingest(person, [event(exposure, dwell([0, 500]))]);
    if (result.kind === 'ingested')
      expect(result.results[0]).toMatchObject({ status: 'rejected', reason: 'exposure_event_limit' });
    expect(await observationCount(person.universeId, exposure.exposureId)).toBe(1000);
  });

  it('refuses a batch from an older privacy epoch and one that is too large, writing nothing', async () => {
    const { person, exposure } = await setup();
    await sql`update identity.universes set privacy_epoch = 2 where id = ${person.universeId}`.execute(database.db);
    expect(await ingest(person, [event(exposure, dwell([0, 500]))])).toEqual({
      kind: 'refused',
      reason: 'epoch_changed',
    });
    expect(await observationCount(person.universeId)).toBe(0);

    const large = await setup();
    const heavy = blocks.slice(0, 16).map((blockId) => ({
      blockId,
      intervalsMs: Array.from({ length: 8 }, (_, index): [number, number] => [
        index * 2_000_000,
        index * 2_000_000 + 1_999_999,
      ]),
      peakFraction: 0.123456789012345,
    }));
    const events = Array.from({ length: 20 }, () =>
      event(large.exposure, { kind: 'scroll.block_coverage', payload: { blocks: heavy } }),
    );
    expect(await ingest(large.person, events)).toEqual({ kind: 'refused', reason: 'batch_too_large' });
    expect(await observationCount(large.person.universeId)).toBe(0);
  });

  it('commits the observations and their projection job together: a failure after the job is written rolls both back', async () => {
    const failing = await scrollUseCases(database, {
      wrapEnqueue:
        (enqueue: EnqueueJob): EnqueueJob =>
        async (scope, queue, payload) => {
          await enqueue(scope, queue, payload);
          throw new Error('simulated failure after the job was written');
        },
    });
    try {
      const { person, exposure } = await setup();
      await expect(
        failing.ingestObservations(person.authority, {
          instrumentationVersion: 1,
          events: [event(exposure, dwell([0, 500]))],
        }),
      ).rejects.toThrow('simulated failure');
      expect(await observationCount(person.universeId)).toBe(0);
      expect(await projectionJobs(person.universeId)).toBe(0);
    } finally {
      await failing.close();
    }
  });
});
