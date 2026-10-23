import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_V1_CAPABILITIES } from '@knowscroll/scroll-model';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  recordingTransactionOf,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { makeEnqueueJob, deadLetterQueueName } from '@knowscroll/backend/infrastructure/jobs';
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
  type FrozenContext,
} from '@knowscroll/backend/modules/planner/nest-providers';
import { CHECK_PLANNER_RECORDING_RUN, type CheckPersonalRecordingRun } from '@knowscroll/backend/reasoning';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases } from '../support/scroll.js';
import { fixtureModel, fixtureHarness, fixtureSettings, silent, signal, attemptsOf } from '../support/fixture-model.js';

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
    expect(
      PlannerJobSchema.parse({ ...shared, v: 2, kind: 'retire', recordingGeneration: null, wakeId: shared.runId }),
    ).toMatchObject({ kind: 'retire', recordingGeneration: null });
    for (const extra of [
      { v: 1, recordingGeneration: undefined },
      { v: 1, recordingGeneration: 1 },
      { v: 1, wakeId: randomUUID() },
      { v: 2, recordingGeneration: 1 },
      { v: 2, recordingGeneration: 2, wakeId: randomUUID() },
      { v: 2, recordingGeneration: 1, wakeId: randomUUID(), expectedClaimId: undefined },
      { v: 2, kind: 'retire', recordingGeneration: null },
      { v: 2, kind: 'retire', recordingGeneration: undefined, wakeId: randomUUID() },
      { v: 2, kind: 'retire', recordingGeneration: null, wakeId: randomUUID(), expectedClaimId: randomUUID() },
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
      // Actual empty-context accounting finalizer rolls back; the earlier durable claim remains.
      store: { ...plannerStore, clearActiveRun: () => Promise.reject(new Error('CI_CRASH_AFTER_DURABLE_CLAIM')) },
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
  it('updates metadata-only frozen headers without an invalid insert candidate, retaining every hash/body guard', async () => {
    const p = await seedPerson(database.db),
      ordinary = await requestJob(p);
    const crash = makeRunPlanner({
      ...base,
      store: { ...plannerStore, clearActiveRun: () => Promise.reject(new Error('CI_KEEP_PREPARED_FOR_METADATA')) },
    });
    await expect(crash(ordinary, signal())).rejects.toThrow('CI_KEEP_PREPARED_FOR_METADATA');
    const frozen = (await rows(p)).runs[0]!;
    expect(frozen.context_version).toBe('planner-context.v0');
    expect(frozen.context).not.toBeNull();
    expect(frozen.recording_context_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.recording_model_context_sha256).toMatch(/^[0-9a-f]{64}$/);
    const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount;
    const update = (
      change: (
        header: NonNullable<Awaited<ReturnType<typeof plannerStore.header>>>,
      ) => Parameters<typeof plannerStore.writeRun>[1],
    ) =>
      scope()(p.authority, async (s) => {
        expect((await own(s)).kind).toBe('active');
        const gate = await fencePersonalRecording(s, 1);
        if (gate.kind !== 'recording') throw new Error('CI genuine recording authority unavailable');
        const header = await plannerStore.header(s, ordinary.runId);
        if (!header) throw new Error('CI exact prepared header missing');
        expect(header.hasContext).toBe(true);
        expect(header).not.toHaveProperty('context');
        await plannerStore.writeRun(s, change(header));
      });
    expect(await update((header) => ({ ...header, status: 'blocked', outcome: 'CI_METADATA_ONLY' }))).toMatchObject({
      kind: 'entered',
    });
    const metadata = (await rows(p)).runs[0]!;
    expect(metadata).toMatchObject({
      status: 'blocked',
      outcome: 'CI_METADATA_ONLY',
      context_version: frozen.context_version,
      context: frozen.context,
      recording_context_sha256: frozen.recording_context_sha256,
      recording_model_context_sha256: frozen.recording_model_context_sha256,
      recording_account_id: frozen.recording_account_id,
      recording_generation: frozen.recording_generation,
      claim_id: frozen.claim_id,
      claim_wake_claim_id: frozen.claim_wake_claim_id,
    });
    await expect(update((header) => ({ ...header, contextSha256: '0'.repeat(64) }))).rejects.toThrow(
      'PERSONAL_ROLE_RECORDING_CONTEXT_IMMUTABLE',
    );
    await expect(
      scope()(p.authority, async (s) => {
        expect((await own(s)).kind).toBe('active');
        const gate = await fencePersonalRecording(s, 1);
        if (gate.kind !== 'recording') throw new Error('CI genuine recording authority unavailable');
        const header = await plannerStore.header(s, ordinary.runId);
        const context: FrozenContext | undefined = await plannerStore.context(s, ordinary.runId);
        if (!header || !context) throw new Error('CI real frozen body missing');
        await plannerStore.writeRun(s, {
          ...header,
          context: { ...context, desiredRevision: context.desiredRevision + 1 },
        });
      }),
    ).rejects.toThrow('PERSONAL_ROLE_RECORDING_CONTEXT_IMMUTABLE');
    await expect(update((header) => ({ ...header, id: randomUUID() }))).rejects.toThrow(
      'PLANNER_NEW_RUN_SHAPE_INVALID',
    );
    expect((await rows(p)).runs[0]).toEqual(metadata);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
    const unprepared = await seedPerson(database.db),
      queued = await requestJob(unprepared);
    const untouched = await rows(unprepared);
    await expect(
      scope()(unprepared.authority, async (s) => {
        expect((await own(s)).kind).toBe('active');
        const gate = await fencePersonalRecording(s, 1);
        if (gate.kind !== 'recording') throw new Error('CI genuine recording authority unavailable');
        const header = await plannerStore.header(s, queued.runId);
        if (!header) throw new Error('CI exact queued header missing');
        expect(header.hasContext).toBe(false);
        await plannerStore.writeRun(s, {
          ...header,
          contextSha256: '0'.repeat(64),
          modelContextSha256: '1'.repeat(64),
        });
      }),
    ).rejects.toThrow('planner_run_recording_hash_shape');
    expect(await rows(unprepared)).toEqual(untouched);
  });
  it('wakes metadata-only retirement of a disabled revoked head, without a toggle-only successor or private capture', async () => {
    const p = await seedPerson(database.db),
      old = await requestJob(p);
    const disabled = makeRunPlanner({ ...base, enabled: () => false });
    expect(await disabled(old, signal())).toMatchObject({ kind: 'entered', value: { kind: 'blocked_disabled' } });
    const blocked = await rows(p);
    expect(blocked.runs[0]).toMatchObject({ status: 'blocked', normal_wake_id: null, claim_id: null, context: null });
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    expect(await rows(p)).toEqual(blocked); // Toggle alone produces no work/source.
    expect(
      await request(p.authority, { commandId: randomUUID(), resumeRunId: old.runId, recordingGeneration: 3 }),
    ).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    expect(await rows(p)).toEqual(blocked);
    expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 3 })).toMatchObject({
      kind: 'accepted',
      runId: old.runId,
    });
    const retirement = (await rows(p)).runs[0]!;
    const payload = PlannerJobSchema.parse({
      v: 2,
      kind: 'retire',
      universeId: p.universeId,
      privacyEpoch: 1,
      runId: old.runId,
      recordingGeneration: 1,
      wakeId: retirement.normal_wake_id,
    });
    const forbidden = () => Promise.reject(new Error('CI_RETIREMENT_PRIVATE_READ'));
    const run = makeRunPlanner({
      ...base,
      store: { ...plannerStore, context: forbidden, state: forbidden },
      readSnapshot: forbidden,
    });
    const revision = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(await run(payload, signal())).toMatchObject({ kind: 'entered', value: { kind: 'recording_ineligible' } });
    const after = await rows(p),
      successor = after.runs.find((x) => x.id !== old.runId)!;
    expect(after.runs.find((x) => x.id === old.runId)).toMatchObject({
      status: 'stale',
      recording_generation: 1,
      normal_wake_id: null,
      context: null,
    });
    expect(successor).toMatchObject({ status: 'queued', recording_generation: 3, context: null, claim_id: null });
    expect(successor.normal_wake_id).toBeTruthy();
    expect(after.state[0]!.active_run_id).toBe(successor.id);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
    expect(
      await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(revision);
    expect(await run(payload, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_wake' } });
    expect(await rows(p)).toEqual(after);
  });
  it('keeps actual adapter-seeded unknown accounting blocking, consuming only delivered retirement UUID A and preserving later B', async () => {
    const p = await seedPerson(database.db),
      old = await requestJob(p);
    expect(await makeRunPlanner({ ...base, enabled: () => false })(old, signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'blocked_disabled' },
    });
    // Explicit accounting-adapter fixture, not a successful Role/model pipeline: actual ledger/receipt transitions.
    const ledger = fixtureHarness(database.db, { model: undefined }).ports.ledger,
      attemptId = randomUUID();
    await scope()(p.authority, async (s) => {
      expect((await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(s)).kind).toBe(
        'active',
      );
      expect(
        await ledger.admitRun(s, {
          id: old.runId,
          ownerModule: 'planner',
          purpose: 'personal-planner',
          roleId: 'fixture.planner',
          roleVersion: 'v1',
          policyVersion: 'fixture.v1',
          provider: 'fixture',
          model: 'fixture',
          contextBundleRef: 'fixture.accounting',
          contextRefs: [],
          recording: {
            accountId: p.accountId,
            generation: 1,
            contextSha256: 'a'.repeat(64),
            modelContextSha256: 'b'.repeat(64),
          },
        }),
      ).toMatchObject({ kind: 'admitted' });
      await ledger.reserve(s, {
        id: attemptId,
        runId: old.runId,
        step: 'primary',
        provider: 'fixture',
        model: 'fixture',
        roleId: 'fixture.planner',
        roleVersion: 'v1',
        promptVersion: 'fixture.v1',
        requestHash: createHash('sha256')
          .update(new Uint8Array([1]))
          .digest('hex'),
        requestBody: new Uint8Array([1]),
        maxOutputTokens: 1,
        reservedTokens: 2,
        requestRetentionSeconds: 60,
      });
      expect(
        await ledger.commitDispatch(s, attemptId, {
          dispatchId: randomUUID(),
          dispatchedBy: 'ci-accounting-fixture',
          quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
        }),
      ).toBe(true);
    });
    expect(await ledger.settle({ scopeId: p.universeId, attemptId }, 'dispatched', 'unknown')).toBe(true);
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    await request(p.authority, { commandId: randomUUID(), recordingGeneration: 3 });
    const payload = () => ({
      v: 2 as const,
      kind: 'retire' as const,
      universeId: p.universeId,
      privacyEpoch: 1,
      runId: old.runId,
      recordingGeneration: 1,
      wakeId: '',
    });
    const a = { ...payload(), wakeId: (await rows(p)).runs[0]!.normal_wake_id! };
    const forbidden = () => Promise.reject(new Error('CI_UNKNOWN_RETIREMENT_PRIVATE_READ'));
    const run = makeRunPlanner({
      ...base,
      store: { ...plannerStore, context: forbidden, state: forbidden },
      readSnapshot: forbidden,
    });
    const attempts = await attemptsOf(database.db, p.universeId);
    expect(await run(a, signal())).toMatchObject({ kind: 'entered', value: { kind: 'revoked_accounting_unresolved' } });
    expect((await rows(p)).runs).toHaveLength(1);
    expect((await rows(p)).runs[0]!.normal_wake_id).toBeNull();
    await request(p.authority, { commandId: randomUUID(), recordingGeneration: 3 });
    const pending = await rows(p),
      b = { ...payload(), wakeId: pending.runs[0]!.normal_wake_id! };
    expect(b.wakeId).not.toBe(a.wakeId);
    expect(await run(a, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_wake' } });
    expect(await run(old, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_wake' } });
    expect(await rows(p)).toEqual(pending);
    expect(await run(b, signal())).toMatchObject({ kind: 'entered', value: { kind: 'revoked_accounting_unresolved' } });
    expect(await attemptsOf(database.db, p.universeId)).toEqual(attempts);
    expect((await rows(p)).state[0]!.active_run_id).toBe(old.runId);
  });
  it.each([false, true])(
    'keeps original legacy NULL provenance during metadata cleanup (present NULL ledger=%s)',
    async (present) => {
      const p = await seedPerson(database.db),
        runId = randomUUID();
      // Explicit historical header adapter fixture: no fabricated eligible recording origin/certificate.
      await scope()(p.authority, async (s) => {
        expect((await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(s)).kind).toBe(
          'active',
        );
        await transactionOf(s)
          .insertInto('planner.runs')
          .values({ universe_id: p.universeId, privacy_epoch: 1, id: runId, revision: 1, status: 'blocked' })
          .execute();
        await transactionOf(s)
          .insertInto('planner.state')
          .values({ universe_id: p.universeId, privacy_epoch: 1, desired_revision: 1, active_run_id: runId })
          .execute();
        if (present)
          expect(
            await fixtureHarness(database.db, { model: undefined }).ports.ledger.admitRun(s, {
              id: runId,
              ownerModule: 'planner',
              purpose: 'personal-planner',
              roleId: 'fixture.planner',
              roleVersion: 'v1',
              policyVersion: 'fixture.v1',
              provider: 'fixture',
              model: 'fixture',
              contextBundleRef: 'fixture.legacy',
              contextRefs: [],
            }),
          ).toMatchObject({ kind: 'admitted' });
      });
      await toggle(p, 1, false);
      await toggle(p, 2, true);
      expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 3 })).toMatchObject({
        kind: 'accepted',
        runId,
      });
      const wakeId = (await rows(p)).runs[0]!.normal_wake_id!;
      const forbidden = () => Promise.reject(new Error('CI_LEGACY_RETIRE_PRIVATE_READ'));
      const run = makeRunPlanner({
        ...base,
        store: { ...plannerStore, context: forbidden, state: forbidden },
        readSnapshot: forbidden,
      });
      expect(
        await run(
          { v: 2, kind: 'retire', universeId: p.universeId, privacyEpoch: 1, runId, recordingGeneration: null, wakeId },
          signal(),
        ),
      ).toMatchObject({
        kind: 'entered',
        value: { kind: present ? 'accounting_unavailable' : 'recording_ineligible' },
      });
      const after = await rows(p),
        old = after.runs.find((x) => x.id === runId)!;
      expect(old).toMatchObject({
        recording_account_id: null,
        recording_generation: null,
        normal_wake_id: null,
        status: present ? 'blocked' : 'stale',
        context: null,
      });
      expect(after.runs).toHaveLength(present ? 1 : 2);
      if (present) expect(after.state[0]!.active_run_id).toBe(runId);
      else
        expect(after.runs.find((x) => x.id !== runId)).toMatchObject({
          recording_generation: 3,
          status: 'queued',
          context: null,
        });
      expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
    },
  );
  it('binds normal markers to real boss PKs, preserves live/mismatched jobs, and recovers terminal/missing markers through a fresh source', async () => {
    const p = await seedPerson(database.db),
      original = await requestJob(p);
    const marker = async () => (await rows(p)).runs.find((x) => x.id === original.runId)!.normal_wake_id!;
    const producer = () => request(p.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    expect(
      (await database.pool.query('select id from pgboss.job where name=$1 and id=$2', ['planner.run', original.wakeId]))
        .rows,
    ).toHaveLength(1);
    for (const state of ['created', 'retry', 'active']) {
      await database.pool.query('update pgboss.job set state=$3 where name=$1 and id=$2', [
        'planner.run',
        await marker(),
        state,
      ]);
      const before = await marker();
      await producer();
      expect(await marker()).toBe(before);
    }
    // Exact malformed payload refuses without casting private/untrusted JSON text or altering the marker/state.
    const prior = await marker();
    await database.pool.query(
      "update pgboss.job set state='failed',data=jsonb_set(data,'{recordingGeneration}',$3::jsonb) where name=$1 and id=$2",
      ['planner.run', prior, JSON.stringify('malformed')],
    );
    const before = await rows(p);
    await expect(producer()).rejects.toThrow('PLANNER_NORMAL_WAKE_UNPROVED');
    expect(await rows(p)).toEqual(before);
    await database.pool.query('update pgboss.job set data=$3::jsonb where name=$1 and id=$2', [
      'planner.run',
      prior,
      JSON.stringify(original),
    ]);
    await producer();
    expect(await marker()).not.toBe(prior);
    const failedReplacement = await marker();
    expect(
      (
        await database.pool.query('select id from pgboss.job where name=$1 and id=$2', [
          'planner.run',
          failedReplacement,
        ])
      ).rows,
    ).toHaveLength(1);
    for (const terminal of ['completed', 'cancelled']) {
      const old = await marker();
      // Explicit admin lifecycle fixture on the actual queue row, leaving Role header/claims untouched.
      await database.pool.query('update pgboss.job set state=$3,completed_on=now() where name=$1 and id=$2', [
        'planner.run',
        old,
        terminal,
      ]);
      await producer();
      expect(await marker()).not.toBe(old);
    }
    const absent = await marker();
    await database.pool.query('delete from pgboss.job where name=$1 and id=$2', ['planner.run', absent]);
    await producer();
    expect(await marker()).not.toBe(absent);
    const pending = await rows(p);
    expect(await makeRunPlanner(base)(original, signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'obsolete_wake' },
    });
    expect(await rows(p)).toEqual(pending);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('recovers an actually expired/deadlettered ordinary marker by exact PK despite a 1001-job unrelated prefix', async () => {
    await database.pool.query("delete from pgboss.job where name='planner.run'");
    const p = await seedPerson(database.db),
      original = await requestJob(p);
    const [taken] = await c.boss.fetch('planner.run');
    expect(taken!.id).toBe(original.wakeId);
    // Documented CI/admin time override: run the REAL supervisor expiry/dead-letter transition, no wait/timeout change.
    await database.pool.query(
      "update pgboss.job set started_on=now()-interval '1 hour',retry_limit=0 where name=$1 and id=$2",
      ['planner.run', original.wakeId],
    );
    await c.boss.supervise('planner.run');
    expect(
      (
        await database.pool.query('select state from pgboss.job where name=$1 and id=$2', [
          'planner.run',
          original.wakeId,
        ])
      ).rows,
    ).toEqual([{ state: 'failed' }]);
    expect(
      (
        await database.pool.query("select id from pgboss.job where name=$1 and data->>'runId'=$2", [
          deadLetterQueueName('planner.run'),
          original.runId,
        ])
      ).rows,
    ).toHaveLength(1);
    const foreign = randomUUID();
    await c.boss.insert(
      'planner.run',
      Array.from({ length: 1001 }, (_, n) => ({
        id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
        data: {
          v: 2,
          universeId: foreign,
          privacyEpoch: 1,
          runId: randomUUID(),
          recordingGeneration: 1,
          wakeId: randomUUID(),
        },
      })),
    );
    expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 1 })).toMatchObject({
      kind: 'accepted',
      runId: original.runId,
    });
    const after = await rows(p),
      renewed = after.runs[0]!.normal_wake_id!;
    expect(renewed).not.toBe(original.wakeId);
    expect(
      (await database.pool.query('select id from pgboss.job where name=$1 and id=$2', ['planner.run', renewed])).rows,
    ).toHaveLength(1);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]!.recording_generation).toBe(1);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('recovers a same-business explicit queued resume only after its exact pending delivery becomes terminal', async () => {
    const p = await seedPerson(database.db),
      old = await requestJob(p);
    const command = () =>
      request(p.authority, { commandId: randomUUID(), recordingGeneration: 1, resumeRunId: old.runId });
    expect(await command()).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    expect(await c.boss.cancel('planner.run', old.wakeId!)).toMatchObject({ affected: 1 });
    expect(await command()).toMatchObject({ kind: 'accepted', runId: old.runId });
    const after = await rows(p);
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]!.normal_wake_id).not.toBe(old.wakeId);
    expect(after.runs[0]).toMatchObject({ recording_generation: 1, claim_id: null, context: null });
    expect(await command()).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    expect(await rows(p)).toEqual(after);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('recovers an expired-before-first-claim initial1 resume without adopting the legacy header in the PK probe', async () => {
    const p = await seedPerson(database.db),
      runId = randomUUID();
    await scope()(p.authority, async (s) => {
      expect((await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(s)).kind).toBe(
        'active',
      );
      await transactionOf(s)
        .insertInto('planner.runs')
        .values({ universe_id: p.universeId, privacy_epoch: 1, id: runId, revision: 1, status: 'blocked' })
        .execute();
      await transactionOf(s)
        .insertInto('planner.state')
        .values({ universe_id: p.universeId, privacy_epoch: 1, desired_revision: 1, active_run_id: runId })
        .execute();
    });
    const resume = () => request(p.authority, { commandId: randomUUID(), resumeRunId: runId });
    expect(await resume()).toMatchObject({ kind: 'accepted', runId });
    const first = (await rows(p)).runs[0]!;
    const assertNull = (r: typeof first) =>
      expect(r).toMatchObject({
        recording_account_id: null,
        recording_generation: null,
        recording_origin_kind: null,
        recording_origin_command_id: null,
        recording_origin_source_revision: null,
        recording_context_sha256: null,
        recording_model_context_sha256: null,
        claim_id: null,
        context: null,
      });
    assertNull(first);
    const job = (
      await database.pool.query<{ data: unknown }>('select data from pgboss.job where name=$1 and id=$2', [
        'planner.run',
        first.normal_wake_id,
      ])
    ).rows[0]!.data;
    expect(job).toEqual({
      v: 2,
      universeId: p.universeId,
      privacyEpoch: 1,
      runId,
      recordingGeneration: 1,
      wakeId: first.normal_wake_id,
    });
    expect(await resume()).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    expect(await c.boss.cancel('planner.run', first.normal_wake_id!)).toMatchObject({ affected: 1 });
    expect(await resume()).toMatchObject({ kind: 'accepted', runId });
    const second = (await rows(p)).runs[0]!;
    assertNull(second);
    expect(second.normal_wake_id).not.toBe(first.normal_wake_id);
    expect((await rows(p)).runs).toHaveLength(1);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('keeps a zero-retained all-NULL legacy head and pending v2 retirement B exact when old v1 is delivered', async () => {
    const p = await seedPerson(database.db),
      runId = randomUUID();
    await scope()(p.authority, async (s) => {
      expect((await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(s)).kind).toBe(
        'active',
      );
      await transactionOf(s)
        .insertInto('planner.runs')
        .values({ universe_id: p.universeId, privacy_epoch: 1, id: runId, revision: 1, status: 'blocked' })
        .execute();
      await transactionOf(s)
        .insertInto('planner.state')
        .values({ universe_id: p.universeId, privacy_epoch: 1, desired_revision: 1, active_run_id: runId })
        .execute();
    });
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 3 })).toMatchObject({
      kind: 'accepted',
      runId,
    });
    const before = await rows(p),
      marker = before.runs[0]!.normal_wake_id!;
    expect(marker).toBeTruthy();
    const queueBefore = (
      await database.pool.query(
        "select id,data,state from pgboss.job where name='planner.run' and data->>'universeId'=$1 order by id",
        [p.universeId],
      )
    ).rows;
    expect(queueBefore).toHaveLength(1);
    const forbidden = () => Promise.reject(new Error('CI_OLD_V1_PRIVATE_READ'));
    const run = makeRunPlanner({
      ...base,
      store: { ...plannerStore, context: forbidden, state: forbidden },
      readSnapshot: forbidden,
    });
    expect(await run({ v: 1, universeId: p.universeId, privacyEpoch: 1, runId }, signal())).toMatchObject({
      kind: 'entered',
      value: { kind: 'obsolete_wake' },
    });
    expect(await rows(p)).toEqual(before);
    expect(
      (
        await database.pool.query(
          "select id,data,state from pgboss.job where name='planner.run' and data->>'universeId'=$1 order by id",
          [p.universeId],
        )
      ).rows,
    ).toEqual(queueBefore);
    expect(
      await database.db
        .selectFrom('reasoning.business_runs')
        .select('id')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it('refuses stale delayed A against an actually renewed current claim C after toggle with zero retained ledger rows', async () => {
    const p = await seedPerson(database.db),
      old = await requestJob(p);
    const crash = makeRunPlanner({
      ...base,
      store: { ...plannerStore, clearActiveRun: () => Promise.reject(new Error('CI_CRASH_BEFORE_EMPTY_TERMINAL')) },
    });
    await expect(crash(old, signal())).rejects.toThrow('CI_CRASH_BEFORE_EMPTY_TERMINAL');
    const claimA = (await rows(p)).runs[0]!.claim_id!;
    const delayedA = PlannerJobSchema.parse({
      v: 2,
      universeId: p.universeId,
      privacyEpoch: 1,
      runId: old.runId,
      recordingGeneration: 1,
      expectedClaimId: claimA,
    });
    await database.db
      .updateTable('planner.runs')
      .set({ claim_until: new Date(Date.now() - 1000) })
      .where('universe_id', '=', p.universeId)
      .where('id', '=', old.runId)
      .execute();
    await expect(crash(delayedA, signal())).rejects.toThrow('CI_CRASH_BEFORE_EMPTY_TERMINAL');
    const claimC = (await rows(p)).runs[0]!.claim_id!;
    expect(claimC).not.toBe(claimA);
    expect((await rows(p)).runs[0]!.claim_wake_claim_id).toBe(claimC);
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    const before = await rows(p),
      forbidden = () => Promise.reject(new Error('CI_STALE_DELAY_PRIVATE_READ'));
    const jobsBefore = (
      await database.pool.query(
        "select id,data,state from pgboss.job where name='planner.run' and data->>'universeId'=$1 order by id",
        [p.universeId],
      )
    ).rows;
    const run = makeRunPlanner({
      ...base,
      store: { ...plannerStore, context: forbidden, state: forbidden },
      readSnapshot: forbidden,
    });
    expect(await run(delayedA, signal())).toMatchObject({ kind: 'entered', value: { kind: 'obsolete_claim_wake' } });
    expect(await rows(p)).toEqual(before);
    expect(
      (
        await database.pool.query(
          "select id,data,state from pgboss.job where name='planner.run' and data->>'universeId'=$1 order by id",
          [p.universeId],
        )
      ).rows,
    ).toEqual(jobsBefore);
    expect(
      await database.db
        .selectFrom('reasoning.business_runs')
        .select('id')
        .where('universe_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
    expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
  });
  it.each(['delivered', 'terminal'] as const)(
    'retires a literal1 all-NULL legacy wake after toggle by metadata only (%s)',
    async (mode) => {
      const p = await seedPerson(database.db),
        runId = randomUUID();
      await scope()(p.authority, async (s) => {
        expect((await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(s)).kind).toBe(
          'active',
        );
        await transactionOf(s)
          .insertInto('planner.runs')
          .values({ universe_id: p.universeId, privacy_epoch: 1, id: runId, revision: 1, status: 'blocked' })
          .execute();
        await transactionOf(s)
          .insertInto('planner.state')
          .values({ universe_id: p.universeId, privacy_epoch: 1, desired_revision: 1, active_run_id: runId })
          .execute();
      });
      expect(await request(p.authority, { commandId: randomUUID(), resumeRunId: runId })).toMatchObject({
        kind: 'accepted',
        runId,
      });
      const originalMarker = (await rows(p)).runs[0]!.normal_wake_id!;
      await toggle(p, 1, false);
      await toggle(p, 2, true);
      if (mode === 'terminal')
        expect(await c.boss.cancel('planner.run', originalMarker)).toMatchObject({ affected: 1 });
      expect(await request(p.authority, { commandId: randomUUID(), recordingGeneration: 3 })).toMatchObject({
        kind: 'accepted',
        runId,
      });
      const currentMarker = (await rows(p)).runs[0]!.normal_wake_id!;
      if (mode === 'delivered') expect(currentMarker).toBe(originalMarker);
      else expect(currentMarker).not.toBe(originalMarker);
      const delivery = (
        await database.pool.query<{ data: unknown }>('select data from pgboss.job where name=$1 and id=$2', [
          'planner.run',
          currentMarker,
        ])
      ).rows[0]!.data;
      expect(delivery).toMatchObject(
        mode === 'delivered' ? { v: 2, recordingGeneration: 1 } : { v: 2, kind: 'retire', recordingGeneration: null },
      );
      const forbidden = () => Promise.reject(new Error('CI_POSTTOGGLE_LEGACY_PRIVATE_READ'));
      const run = makeRunPlanner({
        ...base,
        store: { ...plannerStore, state: forbidden, context: forbidden },
        readSnapshot: forbidden,
      });
      expect(await run(PlannerJobSchema.parse(delivery), signal())).toMatchObject({
        kind: 'entered',
        value: { kind: 'recording_ineligible' },
      });
      const after = await rows(p);
      expect(after.runs.find((x) => x.id === runId)).toMatchObject({
        status: 'stale',
        recording_account_id: null,
        recording_generation: null,
        recording_context_sha256: null,
        recording_model_context_sha256: null,
      });
      expect(after.runs.find((x) => x.id !== runId)).toMatchObject({
        status: 'queued',
        recording_generation: 3,
        context: null,
        claim_id: null,
      });
      expect(await attemptsOf(database.db, p.universeId)).toEqual([]);
    },
  );
});
