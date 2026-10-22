import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  recordingTransactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases, recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { readDiscoveryCandidates, readExactEncounter } from '@knowscroll/backend/modules/content/nest-providers';
import {
  REQUEST_PLANNER,
  PLANNER_MATERIAL_CHANGE,
  PlannerJobSchema,
  type RequestPlanner,
  type PlannerMaterialChange,
} from '@knowscroll/backend/modules/planner';
import {
  plannerRequestProviders,
  plannerStore,
  makeRunPlanner,
  makeMaterialChange,
  type PlannerPorts,
} from '@knowscroll/backend/modules/planner/nest-providers';
import { CHECK_PLANNER_RECORDING_RUN, type CheckPersonalRecordingRun } from '@knowscroll/backend/reasoning';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases } from '../support/scroll.js';
import { fixtureModel, fixtureSettings, silent, signal, attemptsOf } from '../support/fixture-model.js';

/** Hosted PostgreSQL negative protocol fixtures. Geo explicitly DENIES: this graph cannot certify
 * a positive complete role pipeline. Throwing fault injections never impersonate successful effects. */
describe('Planner original recording provenance and exact wake ownership', () => {
  let database: TestDatabase<Database>, c: Awaited<ReturnType<typeof scrollUseCases>>;
  let base: PlannerPorts, request: RequestPlanner, material: PlannerMaterialChange;
  const scope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
  beforeAll(async () => {
    database = await createTestDatabase<Database>('recording_planner');
    c = await scrollUseCases(database);
    const SCOPE = Symbol('CI.scope'),
      ENQUEUE = Symbol('CI.enqueue');
    const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount;
    const values = new Map<symbol, unknown>([
      [SCOPE, scope()],
      [ENQUEUE, makeEnqueueJob(c.boss)],
      [FENCE_OWN_ACCOUNT, own],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    ]);
    const providers = plannerRequestProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
    for (const provider of providers)
      values.set(provider.provide, buildFromProviders(providers, provider.provide, values));
    request = values.get(REQUEST_PLANNER) as RequestPlanner;
    material = values.get(PLANNER_MATERIAL_CHANGE) as PlannerMaterialChange;
    const model = fixtureModel(() => {
      throw new Error('CI negative protocol must not invoke a model');
    });
    const harness = personalRecordingReasoningHarnessFor({
      db: database.db,
      withPersonalScope: scope(),
      fenceOwn: own,
      model,
      logEvent: silent,
      settings: fixtureSettings,
      checkPlanner: values.get(CHECK_PLANNER_RECORDING_RUN) as CheckPersonalRecordingRun,
      checkGeography: () => Promise.resolve('unavailable' as const),
    });
    base = {
      ...(values.get(providers[0]!.provide) as PlannerPorts),
      store: plannerStore,
      readSnapshot: c.readExploration,
      readRecentTopics: c.readRecentTopics,
      readInventory: readDiscoveryCandidates,
      readExact: readExactEncounter,
      capabilities: { ...FULL_V1_CAPABILITIES, documentSchemas: ['scroll-document.v1', 'reel-document.v1'] },
      harness,
      enabled: () => true,
      hash: (x) => requestHash('personal-planner.v0', x as Parameters<typeof requestHash>[1]),
      newId: randomUUID,
      now: () => new Date(),
    };
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });
  async function rows(p: FixturePerson) {
    return {
      state: await database.db
        .selectFrom('planner.state')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute(),
      runs: await database.db.selectFrom('planner.runs').selectAll().where('universe_id', '=', p.universeId).execute(),
    };
  }
  async function requestJob(p: FixturePerson) {
    const accepted = await request(p.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (accepted.kind !== 'accepted') throw new Error('CI genuine Planner request refused');
    const row = await database.db
      .selectFrom('planner.runs')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .where('id', '=', accepted.runId)
      .executeTakeFirstOrThrow();
    return PlannerJobSchema.parse({
      v: 2,
      universeId: p.universeId,
      privacyEpoch: 1,
      runId: accepted.runId,
      recordingGeneration: 1,
      wakeId: row.normal_wake_id,
    });
  }
  async function toggle(p: FixturePerson, g: number, on: boolean) {
    const result = await recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(p.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: g,
      on,
    });
    expect(result.kind).toBe('ok');
  }
  it('rejects malformed/reserved generation and ordinary/delayed wake ambiguity', () => {
    const shared = { universeId: randomUUID(), privacyEpoch: 1, runId: randomUUID() };
    expect(PlannerJobSchema.parse({ ...shared, v: 1 })).toEqual({ ...shared, v: 1 });
    for (const extra of [
      { v: 1, recordingGeneration: undefined },
      { v: 1, recordingGeneration: 1 },
      { v: 1, wakeId: randomUUID() },
      { v: 2, recordingGeneration: 1 },
      { v: 2, recordingGeneration: undefined, wakeId: randomUUID() },
      { v: 2, recordingGeneration: 1, wakeId: randomUUID(), expectedClaimId: randomUUID() },
    ])
      expect(PlannerJobSchema.safeParse({ ...shared, ...extra }).success).toBe(false);
  });
  it('rejects a forged current-generation payload over an old run before frozen context or PC capture', async () => {
    const p = await seedPerson(database.db),
      job = await requestJob(p);
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    let privateReads = 0;
    const forbidden = () => {
      privateReads++;
      return Promise.reject(new Error('CI forbidden private capture'));
    };
    const run = makeRunPlanner({ ...base, store: { ...plannerStore, context: forbidden }, readSnapshot: forbidden });
    const before = await rows(p);
    expect(await run({ ...job, recordingGeneration: 3 }, signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'generation_mismatch' },
    });
    expect(privateReads).toBe(0);
    expect(await rows(p)).toEqual(before);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('records no desired source for paused/stale/missing-after-toggle requests, preserving exact historical ACK', async () => {
    const p = await seedPerson(database.db),
      commandId = randomUUID();
    const ack = await request(p.authority, { commandId, recordingGeneration: 1 });
    expect(ack.kind).toBe('accepted');
    await toggle(p, 1, false);
    const before = await rows(p);
    expect(await request(p.authority, { commandId, recordingGeneration: 1 })).toEqual(ack);
    expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 1 })).toEqual({
      kind: 'refused',
      reason: 'recording_required',
    });
    await toggle(p, 2, true);
    expect(await request(p.authority, { commandId: randomUUID() })).toEqual({
      kind: 'refused',
      reason: 'recording_required',
    });
    expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 1 })).toEqual({
      kind: 'refused',
      reason: 'recording_required',
    });
    expect(await rows(p)).toEqual(before);
  });
  it('blocks explicitly unavailable PC proof without freezing a context, claiming or reserving', async () => {
    const p = await seedPerson(database.db),
      job = await requestJob(p);
    const run = makeRunPlanner({
      ...base,
      readSnapshot: async (...args) => ({
        ...(await c.readExploration(...args)),
        proofAvailability: 'unavailable',
        proofReason: 'limit',
        qualified: [],
        supportingEvidence: [],
      }),
    });
    expect(await run(job, signal())).toMatchObject({ kind: 'entered', value: { kind: 'proof_unavailable' } });
    const current = (await rows(p)).runs[0]!;
    expect(current).toMatchObject({
      status: 'blocked',
      context: null,
      recording_context_sha256: null,
      recording_model_context_sha256: null,
      claim_id: null,
      claim_wake_claim_id: null,
      normal_wake_id: null,
    });
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('rolls actual original-generation material state/job/root changes back on required enqueue failure', async () => {
    const p = await seedPerson(database.db);
    const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount;
    const failing = makeMaterialChange({
      ...base,
      enqueue: async (...args) => {
        await base.enqueue(...args);
        throw new Error('CI_MATERIAL_JOB_FAILURE');
      },
    });
    const rootBefore = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    await expect(
      scope()(p.authority, async (s) => {
        expect((await own(s)).kind).toBe('active');
        const gate = await fencePersonalRecording(s, 1);
        if (gate.kind !== 'recording') throw new Error('CI genuine cap unavailable');
        await sql`update identity.universes set revision=revision+1 where id=${p.universeId}::uuid`.execute(
          recordingTransactionOf(gate.scope),
        );
        await failing(gate.scope, { sourceRevision: s.revisionAtEntry + 1, recordingGeneration: 1 });
      }),
    ).rejects.toThrow('CI_MATERIAL_JOB_FAILURE');
    expect(await rows(p)).toEqual({ state: [], runs: [] });
    expect(
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(rootBefore);
    expect(
      (
        await database.pool.query("select id from pgboss.job where name='planner.run' and data->>'universeId'=$1", [
          p.universeId,
        ])
      ).rows,
    ).toEqual([]);
    await expect(
      material({} as Parameters<PlannerMaterialChange>[0], { sourceRevision: 1, recordingGeneration: 1 }),
    ).rejects.toThrow();
  });
  it('durably recovers a crashed ordinary and crashed delayed renewal; stale A cannot steal pending B', async () => {
    const p = await seedPerson(database.db),
      ordinary = await requestJob(p);
    const crash = makeRunPlanner({
      ...base,
      harness: {
        ...base.harness,
        withPersonalApply: () => Promise.reject(new Error('CI_CRASH_AFTER_DURABLE_CLAIM')),
      },
    });
    await expect(crash(ordinary, signal())).rejects.toThrow('CI_CRASH_AFTER_DURABLE_CLAIM');
    let current = (await rows(p)).runs[0]!;
    expect(current.status).toBe('prepared');
    expect(current.normal_wake_id).toBeNull();
    expect(current.claim_wake_claim_id).toBe(current.claim_id);
    const firstClaim = current.claim_id!;
    const delayedA = PlannerJobSchema.parse({
      v: 2,
      universeId: p.universeId,
      privacyEpoch: 1,
      runId: ordinary.runId,
      recordingGeneration: 1,
      expectedClaimId: firstClaim,
    });
    const before = await rows(p);
    expect(await crash(ordinary, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_wake' } });
    await expect(crash(delayedA, signal())).rejects.toThrow('PLANNER_CLAIM_WAKE_EARLY');
    expect(await rows(p)).toEqual(before);
    await database.db
      .updateTable('planner.runs')
      .set({ claim_until: new Date(Date.now() - 1000) })
      .where('universe_id', '=', p.universeId)
      .where('id', '=', ordinary.runId)
      .execute();
    await expect(crash(delayedA, signal())).rejects.toThrow('CI_CRASH_AFTER_DURABLE_CLAIM');
    current = (await rows(p)).runs[0]!;
    expect(current.claim_id).not.toBe(firstClaim);
    expect(current.claim_wake_claim_id).toBe(current.claim_id);
    const jobs = await database.pool.query<{ data: { expectedClaimId?: string } }>(
      "select data from pgboss.job where name='planner.run' and data->>'universeId'=$1",
      [p.universeId],
    );
    expect(jobs.rows.filter((r) => r.data.expectedClaimId === firstClaim)).toHaveLength(1);
    expect(jobs.rows.filter((r) => r.data.expectedClaimId === current.claim_id)).toHaveLength(1);
    await database.db
      .updateTable('planner.runs')
      .set({ claim_until: new Date(Date.now() - 1000) })
      .where('universe_id', '=', p.universeId)
      .where('id', '=', ordinary.runId)
      .execute();
    expect(
      await request(p.authority, { commandId: randomUUID(), resumeRunId: ordinary.runId, recordingGeneration: 1 }),
    ).toMatchObject({ kind: 'accepted' });
    const pendingB = await rows(p);
    expect(pendingB.runs[0]!.normal_wake_id).not.toBeNull();
    expect(
      await request(p.authority, { commandId: randomUUID(), resumeRunId: ordinary.runId, recordingGeneration: 1 }),
    ).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    expect(await crash(delayedA, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_claim_wake' } });
    expect(await crash(ordinary, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_wake' } });
    expect(await rows(p)).toEqual(pendingB);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
});
