import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InteractionEvent } from '@knowscroll/contracts';
import { type Database, makeWithPersonalScope, transactionOf } from '@knowscroll/backend/infrastructure/postgres';
import { recordingPolicyFor, accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  ApplyActionEvidencePayloadSchema,
  ProjectScrollReadingPayloadSchema,
} from '@knowscroll/backend/modules/evidence';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { admitStarter, scrollUseCases } from '../support/scroll.js';
import { activatedAgo, dwell, event, openActive } from '../support/observations.js';
import { gate } from '../support/fixture-model.js';

/** Actions-only disposable PG. These fixtures prove intake/qualification fences; full positive
 * Evidence→PC→Roles material change remains pending its separately allocated real owner. */
describe('recording Evidence intake and queued provenance', () => {
  let database: TestDatabase<Database>;
  let useCases: Awaited<ReturnType<typeof scrollUseCases>>;
  let starter: { assetId: string; revision: number };
  beforeAll(async () => {
    database = await createTestDatabase<Database>('recording_pipeline');
    useCases = await scrollUseCases(database);
    starter = await admitStarter(useCases.importScroll);
  });
  afterAll(async () => {
    await useCases.close();
    await database.drop();
  });
  async function reader() {
    const person = await seedPerson(database.db);
    const exposure = await openActive(useCases, person, starter);
    await activatedAgo(database.db, exposure.exposureId, 30);
    return { person, exposure };
  }
  async function snapshot(universeId: string) {
    const r = (
      await sql<{
        observations: number;
        qualifications: number;
        activities: number;
        jobs: number;
        revision: number;
      }>`select
      (select count(*)::int from evidence.observations where universe_id=${universeId}::uuid) observations,
      (select count(*)::int from evidence.encounter_evidence where universe_id=${universeId}::uuid) qualifications,
      (select count(*)::int from evidence.activity_revisions where universe_id=${universeId}::uuid) activities,
      (select count(*)::int from pgboss.job where data->>'universeId'=${universeId}) jobs,
      revision from identity.universes where id=${universeId}::uuid`.execute(database.db)
    ).rows[0];
    return r;
  }
  const legacy = (person: Awaited<ReturnType<typeof seedPerson>>, events: readonly InteractionEvent[]) =>
    useCases.ingestObservations(person.authority, { instrumentationVersion: 1, events });
  const toggle = (person: Awaited<ReturnType<typeof seedPerson>>, g: number, on: boolean) =>
    recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(person.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: g,
      on,
    });
  it('retains the original wire digest despite clamping, exact retries do not change counts, changed wire refuses', async () => {
    const { person, exposure } = await reader();
    const e = event(exposure, dwell([0, 86400000]), { occurredAt: new Date(Date.now() + 86400000).toISOString() });
    expect(await legacy(person, [e])).toMatchObject({ kind: 'ingested', accepted: 1, duplicates: 0 });
    const before = await snapshot(person.universeId);
    const stored = await database.db
      .selectFrom('evidence.observations')
      .select(['payload', 'bounded', 'occurred_at'])
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(stored.bounded).toBe(true);
    expect(stored.payload).toMatchObject({
      recording: { v: 1, clockDomain: 'legacy', wireSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown },
      body: { activeIntervalsMs: expect.any(Array) as unknown },
    });
    expect(new Date(stored.occurred_at).getTime()).toBeLessThan(Date.parse(e.occurredAt));
    expect(await legacy(person, [e])).toMatchObject({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(
      await legacy(person, [{ ...e, occurredAt: new Date(Date.parse(e.occurredAt) + 1).toISOString() }]),
    ).toMatchObject({
      accepted: 0,
      duplicates: 0,
      rejected: 1,
      results: [{ status: 'rejected', reason: 'lineage_mismatch' }],
    });
    expect(await snapshot(person.universeId)).toEqual(before);
    expect(
      await database.db
        .selectFrom('evidence.observations')
        .select(['payload', 'bounded', 'occurred_at'])
        .where('universe_id', '=', person.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(stored);
  });
  it('fails closed for a real pre-envelope shape whose original body cannot be reconstructed after clamping', async () => {
    const { person, exposure } = await reader();
    const e = event(exposure, dwell([0, 86400000]), { occurredAt: new Date(Date.now() + 86400000).toISOString() });
    await legacy(person, [e]);
    // Deliberate historical-fixture conversion, never migration/backfill: discard unavailable digest.
    await sql`update evidence.observations set payload=payload->'body' where universe_id=${person.universeId}::uuid and event_id=${e.eventId}::uuid`.execute(
      database.db,
    );
    const row = await database.db
      .selectFrom('evidence.observations')
      .selectAll()
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(row.bounded).toBe(true);
    expect(new Date(row.occurred_at).getTime()).toBeLessThan(Date.parse(e.occurredAt));
    const before = await snapshot(person.universeId);
    for (const retry of [
      e,
      { ...e, occurredAt: new Date().toISOString(), payload: { activeIntervalsMs: [[0, 1000]] } } as InteractionEvent,
    ])
      expect(await legacy(person, [retry])).toMatchObject({
        accepted: 0,
        duplicates: 0,
        rejected: 1,
        results: [{ status: 'rejected', reason: 'lineage_mismatch' }],
      });
    expect(await snapshot(person.universeId)).toEqual(before);
    expect(
      await database.db
        .selectFrom('evidence.observations')
        .selectAll()
        .where('universe_id', '=', person.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(row);
    expect(await legacy(person, [event(exposure, dwell([0, 1000]))])).toMatchObject({ accepted: 1, duplicates: 0 });
  });
  it('checks current recording before any duplicate outcome and never relabels pending work after resume', async () => {
    const { person, exposure } = await reader();
    const e = event(exposure, dwell([0, 2000]));
    await legacy(person, [e]);
    expect(await toggle(person, 1, false)).toMatchObject({ kind: 'ok' });
    const paused = await snapshot(person.universeId);
    expect(
      await useCases.ingestObservations(person.authority, {
        version: 'observation-batch.v2',
        recordingGeneration: 1,
        instrumentationVersion: 1,
        events: [e],
      }),
    ).toMatchObject({ kind: 'not_recorded', reason: 'recording_paused', recordingGeneration: 1, currentGeneration: 2 });
    expect(await legacy(person, [e])).toEqual({ kind: 'refused', reason: 'recording_required' });
    expect(await snapshot(person.universeId)).toEqual(paused);
    expect(await toggle(person, 2, true)).toMatchObject({ kind: 'ok' });
    const resumed = await snapshot(person.universeId);
    for (const payload of [{ v: 1 as const }, { v: 2 as const, recordingGeneration: 1 }])
      expect(
        await useCases.projectScrollReading({
          ...payload,
          universeId: person.universeId,
          privacyEpoch: 1,
          exposureId: exposure.exposureId,
        }),
      ).toEqual({ kind: 'skipped', reason: 'recording_ineligible' });
    expect(
      await useCases.ingestObservations(person.authority, {
        version: 'observation-batch.v2',
        recordingGeneration: 3,
        instrumentationVersion: 1,
        events: [e],
      }),
    ).toMatchObject({ accepted: 0, duplicates: 0, rejected: 1, results: [{ reason: 'lineage_mismatch' }] });
    expect(await snapshot(person.universeId)).toEqual(resumed);
  });
  it('requires an actual activation session and refuses malformed protocol without legacy downgrade', async () => {
    const { person, exposure } = await reader();
    const e = event(exposure, dwell([0, 1000]));
    expect(
      await useCases.ingestObservations(person.authority, {
        version: 'observation-batch.v2',
        recordingGeneration: 1,
        instrumentationVersion: 1,
        events: [e],
      }),
    ).toMatchObject({ accepted: 0, rejected: 1, results: [{ reason: 'lineage_mismatch' }] });
    expect(
      await useCases.ingestObservations(person.authority, {
        recordingGeneration: undefined,
        instrumentationVersion: 1,
        events: [e],
      }),
    ).toEqual({ kind: 'refused', reason: 'invalid_input' });
    expect(await legacy(person, [e])).toMatchObject({ accepted: 1 });
  });
  it('keeps exact duplicates harmless at the lifetime cap and probes all generations before the sentinel decision', async () => {
    const { person, exposure } = await reader();
    const events = Array.from({ length: 1000 }, () => event(exposure, dwell([0, 1000])));
    for (let i = 0; i < events.length; i += 50)
      expect(await legacy(person, events.slice(i, i + 50))).toMatchObject({ accepted: 50, rejected: 0 });
    const before = await snapshot(person.universeId);
    expect(await legacy(person, [events[0]!])).toMatchObject({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(await legacy(person, [event(exposure, dwell([0, 1000]))])).toMatchObject({
      accepted: 0,
      rejected: 1,
      results: [{ reason: 'exposure_event_limit' }],
    });
    expect(await snapshot(person.universeId)).toEqual(before);
    await toggle(person, 1, false);
    await toggle(person, 2, true);
    // Deliberately inconsistent oversized fixture: one current-g row after 1000 old-g rows.
    await sql`insert into evidence.observations(universe_id,id,event_id,session_id,device_sequence,exposure_id,seq,asset_id,asset_revision,schema_version,kind,instrumentation_version,occurred_at,received_at,bounded,payload,privacy_epoch,recording_generation)
      select universe_id,${randomUUID()}::uuid,${randomUUID()}::uuid,session_id,1001,exposure_id,1001,asset_id,asset_revision,schema_version,kind,instrumentation_version,occurred_at,received_at,bounded,payload,privacy_epoch,3 from evidence.observations where universe_id=${person.universeId}::uuid order by seq limit 1`.execute(
      database.db,
    );
    const oversized = await snapshot(person.universeId);
    expect(
      await useCases.projectScrollReading({
        v: 2,
        recordingGeneration: 3,
        universeId: person.universeId,
        privacyEpoch: 1,
        exposureId: exposure.exposureId,
      }),
    ).toEqual({ kind: 'skipped', reason: 'observation_limit' });
    expect(await snapshot(person.universeId)).toEqual(oversized);
  });
  it('rechecks the epoch after an observed root lock wait before accepting an exact retry', async () => {
    const { person, exposure } = await reader();
    const e = event(exposure, dwell([0, 1000]));
    await legacy(person, [e]);
    const held = gate(),
      release = gate();
    let holderPid = 0;
    let pending: ReturnType<typeof legacy> | undefined;
    const holding = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(person.authority, async (scope) => {
      expect((await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope)).kind).toBe(
        'active',
      );
      const trx = transactionOf(scope);
      holderPid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(trx)).rows[0]!.pid;
      held.open();
      await release.promise;
      await trx
        .updateTable('identity.universes')
        .set({ privacy_epoch: 2 })
        .where('id', '=', person.universeId)
        .execute();
    });
    try {
      await held.promise;
      pending = legacy(person, [e]);
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const r = (
          await sql<{
            blocked: boolean;
          }>`select exists(select 1 from pg_stat_activity a where ${holderPid}=any(pg_blocking_pids(a.pid))) blocked`.execute(
            database.db,
          )
        ).rows[0];
        if (r?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      release.open();
      await holding;
      expect(await pending).toEqual({ kind: 'refused', reason: 'epoch_changed' });
      expect(await snapshot(person.universeId)).toMatchObject({ observations: 1, qualifications: 0, activities: 0 });
    } finally {
      release.open();
      await Promise.allSettled([holding, ...(pending ? [pending] : [])]);
    }
  });
  it('rechecks current own-account authority after an observed UPDATE wait before revealing a duplicate', async () => {
    const { person, exposure } = await reader();
    const e = event(exposure, dwell([0, 1000]));
    await legacy(person, [e]);
    const held = gate(),
      release = gate();
    let holderPid = 0;
    let pending: ReturnType<typeof legacy> | undefined;
    const holding = database.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('identity.accounts')
        .select('id')
        .where('id', '=', person.accountId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      holderPid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(trx)).rows[0]!.pid;
      held.open();
      await release.promise;
      await trx
        .updateTable('identity.accounts')
        .set({ status: 'suspended' })
        .where('id', '=', person.accountId)
        .execute();
    });
    try {
      await held.promise;
      pending = legacy(person, [e]);
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const r = (
          await sql<{
            blocked: boolean;
          }>`select exists(select 1 from pg_stat_activity a where ${holderPid}=any(pg_blocking_pids(a.pid))) blocked`.execute(
            database.db,
          )
        ).rows[0];
        if (r?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
      release.open();
      await holding;
      expect(await pending).toEqual({ kind: 'refused', reason: 'universe_unavailable' });
      expect(await snapshot(person.universeId)).toMatchObject({ observations: 1, qualifications: 0, activities: 0 });
    } finally {
      release.open();
      await Promise.allSettled([holding, ...(pending ? [pending] : [])]);
    }
  });
  it('keeps queue schemas as objects with inventory fields and rejects stripped or missing original generations', () => {
    const shared = { universeId: randomUUID(), privacyEpoch: 1 };
    for (const [schema, id] of [
      [ApplyActionEvidencePayloadSchema, { actionId: randomUUID() }],
      [ProjectScrollReadingPayloadSchema, { exposureId: randomUUID() }],
    ] as const) {
      expect(schema.shape.universeId).toBeDefined();
      expect(schema.parse({ ...shared, ...id, v: 1, unrelated: 'stripped' })).toEqual({ ...shared, ...id, v: 1 });
      for (const wire of [
        { v: 1, recordingGeneration: undefined },
        { v: 1, recordingGeneration: 1 },
        { v: 2 },
        { v: 2, recordingGeneration: undefined },
        { v: 2, recordingGeneration: 0 },
        { v: 3, recordingGeneration: 3 },
      ])
        expect(schema.safeParse({ ...shared, ...id, ...wire }).success).toBe(false);
      expect(schema.parse({ ...shared, ...id, v: 2, recordingGeneration: 3 })).toEqual({
        ...shared,
        ...id,
        v: 2,
        recordingGeneration: 3,
      });
    }
  });
});
