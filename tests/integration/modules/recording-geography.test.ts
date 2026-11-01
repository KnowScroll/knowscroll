import type { PgBoss } from 'pg-boss';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { createBoss, makeEnqueueJob, deadLetterQueueName } from '@knowscroll/backend/infrastructure/jobs';
import {
  FENCE_OWN_ACCOUNT,
  FENCE_PERSONAL_RECORDING,
  CHECK_PERSONAL_OWNER_ACTIVE,
} from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
  recordingPolicyFor,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { READ_COVERAGE_INPUTS, READ_TRUSTED_COVERAGE } from '@knowscroll/backend/modules/personal-context';
import { GEOGRAPHY_APPLIED, type RequestCartography } from '@knowscroll/backend/modules/geography';
import {
  geographyProviders,
  GEOGRAPHY_PORTS,
  geographyStore,
  makeRequestCartography,
  makeRunCartographer,
  makeCheckGeographyRecordingRun,
  type GeographyPorts,
} from '@knowscroll/backend/modules/geography/nest-providers';
import { sceneAppliedProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { CartographyJobSchema, cartographyQueue } from '@knowscroll/backend/modules/geography';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { fixtureHarness } from '../support/fixture-model.js';
/** Actual isolated PG/queue/source factories. Throw-only seams prove no PC/context/provider
 * access on negative paths; they never supply a successful role proof or positive acceptance. */
describe('Geography original generation and exact wake ownership (Actions only)', () => {
  let database: TestDatabase<Database>, boss: PgBoss, p: GeographyPorts, request: RequestCartography;
  const never = () => {
    throw new Error('CI forbidden private/economic work');
  };
  beforeAll(async () => {
    database = await createTestDatabase<Database>('recording_geography');
    boss = createBoss(database.settings, 'producer', { onError: never, onWarning: () => undefined });
    await boss.start();
    const SCOPE = Symbol('scope'),
      ENQUEUE = Symbol('enqueue'),
      providers = [
        ...sceneAppliedProviders({ enqueueJob: ENQUEUE }),
        ...geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE }),
      ];
    const values = new Map<symbol, unknown>([
      [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
      [ENQUEUE, makeEnqueueJob(boss)],
      [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount],
      [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
      [READ_COVERAGE_INPUTS, never],
      [READ_TRUSTED_COVERAGE, never],
      ...identityScopeOwnerProviders().map((x) => [x.provide, x.useValue] as const),
    ]);
    expect(values.has(CHECK_PERSONAL_OWNER_ACTIVE)).toBe(true);
    values.set(GEOGRAPHY_APPLIED, buildFromProviders(providers, GEOGRAPHY_APPLIED, values));
    p = buildFromProviders(providers, GEOGRAPHY_PORTS, values) as GeographyPorts;
    request = makeRequestCartography(p);
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await database.drop();
  });
  const worker = (accounting = false) =>
    makeRunCartographer({
      ...p,
      enabled: () => false,
      harness: {
        contextDigest: never,
        currentOwner: never,
        proposePersonal: never,
        withPersonalApply: never,
        closePersonalRun: never,
        // Actual payload-free accounting adapter; no successful counterpart checker/proposal/apply seam.
        readPersonalRunAccounting: accounting
          ? (scope, runId, binding) =>
              fixtureHarness(database.db, { model: undefined }).ports.personalAccess.readAccounting(
                scope,
                runId,
                binding,
              )
          : never,
      },
    });
  const header = (u: string, id: string) =>
    database.db
      .selectFrom('geography.runs')
      .selectAll()
      .where('universe_id', '=', u)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  /** A run parked by earlier code: wake consumed, status blocked, outcome disabled. Still a state to resume or retire. */
  const park = (u: string, id: string) =>
    sql`update geography.runs set status='blocked',outcome='disabled',normal_wake_id=null where universe_id=${u}::uuid and id=${id}::uuid`.execute(
      database.db,
    );
  const jobCount = async (u: string) =>
    (
      await sql<{ n: number }>`select count(*)::int n from pgboss.job where data->>'universeId'=${u}`.execute(
        database.db,
      )
    ).rows[0]!.n;
  it('creates only fresh queued marked runs and refuses missing or foreign metadata headers without recreating them', async () => {
    const a = await seedPerson(database.db),
      b = await seedPerson(database.db),
      commandId = randomUUID(),
      first = await request(a.authority, { commandId, recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI actual new-run request');
    const created = await header(a.universeId, first.runId);
    expect(created).toMatchObject({
      status: 'queued',
      recording_account_id: a.accountId,
      recording_generation: 1,
      recording_origin_kind: 'command',
      recording_origin_command_id: commandId,
      context: null,
      recording_context_sha256: null,
      recording_model_context_sha256: null,
    });
    const read = await p.withScope(a.authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
      if ((await p.fenceRecording(scope, 1)).kind !== 'recording') throw new Error('CI original generation');
      return geographyStore.header(scope, first.runId);
    });
    if (read.kind !== 'entered' || !read.value) throw new Error('CI actual header');
    const existing = read.value;
    const missingId = randomUUID();
    await expect(
      p.withScope(a.authority, async (scope) => {
        if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
        if ((await p.fenceRecording(scope, 1)).kind !== 'recording') throw new Error('CI original generation');
        await geographyStore.writeRun(scope, { ...existing, id: missingId });
      }),
    ).rejects.toThrow('GEOGRAPHY_NEW_RUN_SHAPE_INVALID');
    await expect(
      p.withScope(b.authority, async (scope) => {
        if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
        if ((await p.fenceRecording(scope, 1)).kind !== 'recording') throw new Error('CI original generation');
        await geographyStore.writeRun(scope, existing);
      }),
    ).rejects.toThrow('GEOGRAPHY_NEW_RUN_SHAPE_INVALID');
    await expect(
      p.withScope(a.authority, async (scope) => {
        if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
        if ((await p.fenceRecording(scope, 1)).kind !== 'recording') throw new Error('CI original generation');
        await geographyStore.writeRun(scope, {
          id: missingId,
          desiredRevision: 1,
          status: 'queued',
          recording: existing.recording,
          contextSha256: 'a'.repeat(64),
          modelContextSha256: 'b'.repeat(64),
        });
      }),
    ).rejects.toThrow('GEOGRAPHY_NEW_RUN_SHAPE_INVALID');
    expect(await header(a.universeId, first.runId)).toEqual(created);
    expect(await database.db.selectFrom('geography.runs').select('id').where('id', '=', missingId).execute()).toEqual(
      [],
    );
    expect(
      await database.db.selectFrom('geography.runs').select('id').where('universe_id', '=', b.universeId).execute(),
    ).toEqual([]);
  });

  it('retains omitted original receipt through pause, refuses malformed own generation and creates no future intent', async () => {
    const a = await seedPerson(database.db),
      command = { commandId: randomUUID() };
    const first = await request(a.authority, command);
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('CI source request');
    const before = await header(a.universeId, first.runId),
      jobs = await jobCount(a.universeId);
    expect(before.recording_generation).toBe(1);
    expect(before.recording_origin_kind).toBe('command');
    await recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(a.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: 1,
      on: false,
    });
    expect(await request(a.authority, command)).toEqual(first);
    expect(await request(a.authority, { ...command, recordingGeneration: 1 })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    const off = { commandId: randomUUID(), recordingGeneration: 2 };
    expect(await request(a.authority, off)).toEqual({ kind: 'refused', reason: 'recording_required' });
    expect(await header(a.universeId, first.runId)).toEqual(before);
    expect(await jobCount(a.universeId)).toBe(jobs);
    for (const recordingGeneration of [undefined, null, 0, 1.5, '1', 2147483648])
      await expect(request(a.authority, { commandId: randomUUID(), recordingGeneration } as never)).rejects.toThrow();
  });
  it('a disabled delivery releases its own run without private work; a stale wake cannot touch a newer pending run', async () => {
    const a = await seedPerson(database.db),
      first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI request');
    const hA = await header(a.universeId, first.runId),
      A = {
        v: 2 as const,
        universeId: a.universeId,
        privacyEpoch: 1,
        runId: first.runId,
        recordingGeneration: 1,
        wakeId: hA.normal_wake_id!,
      };
    await worker()(A, new AbortController().signal);
    const released = {
      status: 'insufficient',
      outcome: 'disabled',
      normal_wake_id: null,
      context: null,
      recording_context_sha256: null,
      recording_model_context_sha256: null,
    };
    expect(await header(a.universeId, first.runId)).toMatchObject(released);
    expect(
      (
        await database.db
          .selectFrom('geography.state')
          .select('active_run_id')
          .where('universe_id', '=', a.universeId)
          .executeTakeFirstOrThrow()
      ).active_run_id,
    ).toBeNull();
    // The released run is not resumable; new reading or a new request starts another run.
    expect(
      await request(a.authority, { commandId: randomUUID(), resumeRunId: first.runId, recordingGeneration: 1 }),
    ).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    const next = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (next.kind !== 'accepted') throw new Error('CI request');
    expect(next.runId).not.toBe(first.runId);
    const before = await header(a.universeId, next.runId),
      jobs = await jobCount(a.universeId);
    expect(before.normal_wake_id).not.toBe(A.wakeId);
    expect(before.normal_wake_id).not.toBeNull();
    await worker()(A, new AbortController().signal);
    await worker()(A, new AbortController().signal);
    expect(await header(a.universeId, next.runId)).toEqual(before);
    expect(await header(a.universeId, first.runId)).toMatchObject(released);
    expect(await jobCount(a.universeId)).toBe(jobs);
    await worker()({ ...A, runId: next.runId, wakeId: before.normal_wake_id! }, new AbortController().signal);
    expect(await header(a.universeId, next.runId)).toMatchObject(released);
    expect(await jobCount(a.universeId)).toBe(jobs);
  });
  it('revoked unproved accounting consumes only its own retirement UUID and never starts a successor', async () => {
    const a = await seedPerson(database.db),
      first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI request');
    await park(a.universeId, first.runId);
    // Present legacy/NULL proof is deliberately unproved, not zero retained.
    await database.db
      .insertInto('reasoning.business_runs')
      .values({
        universe_id: a.universeId,
        id: first.runId,
        privacy_epoch: 1,
        owner_module: 'geography',
        purpose: 'personal-cartographer',
      })
      .execute();
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (const [expectedRecordingGeneration, on] of [
      [1, false],
      [2, true],
    ] as const)
      await policy.set(a.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration,
        on,
      });
    await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
    const pending = await header(a.universeId, first.runId),
      A = {
        v: 2 as const,
        kind: 'retire' as const,
        universeId: a.universeId,
        privacyEpoch: 1,
        runId: first.runId,
        recordingGeneration: 1,
        wakeId: pending.normal_wake_id!,
      };
    expect(A.wakeId).not.toBeNull();
    const jobs = await jobCount(a.universeId);
    await worker(true)(A, new AbortController().signal);
    const blocked = await header(a.universeId, first.runId);
    expect(blocked).toMatchObject({ status: 'blocked', recording_generation: 1, normal_wake_id: null, context: null });
    expect(
      (
        await database.db
          .selectFrom('geography.state')
          .select('active_run_id')
          .where('universe_id', '=', a.universeId)
          .executeTakeFirstOrThrow()
      ).active_run_id,
    ).toBe(first.runId);
    expect(await jobCount(a.universeId)).toBe(jobs);
    await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
    const B = await header(a.universeId, first.runId);
    expect(B.normal_wake_id).not.toBeNull();
    expect(B.normal_wake_id).not.toBe(A.wakeId);
    await worker(true)(A, new AbortController().signal);
    expect(await header(a.universeId, first.runId)).toEqual(B);
    expect(
      (
        await database.db
          .selectFrom('reasoning.business_runs')
          .select('state')
          .where('universe_id', '=', a.universeId)
          .where('id', '=', first.runId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('admitted');
  });
  it('actual accounting proves zero RETAINED and only fresh desired provenance creates a new original-generation successor', async () => {
    const a = await seedPerson(database.db),
      first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI request');
    await park(a.universeId, first.runId);
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (const [expectedRecordingGeneration, on] of [
      [1, false],
      [2, true],
    ] as const)
      await policy.set(a.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration,
        on,
      });
    expect((await header(a.universeId, first.runId)).normal_wake_id).toBeNull();
    const commandId = randomUUID();
    await request(a.authority, { commandId, recordingGeneration: 3 });
    const pending = await header(a.universeId, first.runId);
    await worker(true)(
      {
        v: 2,
        kind: 'retire',
        universeId: a.universeId,
        privacyEpoch: 1,
        runId: first.runId,
        recordingGeneration: 1,
        wakeId: pending.normal_wake_id!,
      },
      new AbortController().signal,
    );
    expect(await header(a.universeId, first.runId)).toMatchObject({
      status: 'stale',
      recording_generation: 1,
      normal_wake_id: null,
      context: null,
    });
    const state = await database.db
      .selectFrom('geography.state')
      .selectAll()
      .where('universe_id', '=', a.universeId)
      .executeTakeFirstOrThrow();
    expect(state.active_run_id).not.toBe(first.runId);
    const next = await header(a.universeId, state.active_run_id!);
    expect(next).toMatchObject({
      status: 'queued',
      recording_generation: 3,
      recording_origin_kind: 'command',
      recording_origin_command_id: commandId,
      context: null,
    });
    expect(next.normal_wake_id).not.toBeNull();
    expect(
      await database.db
        .selectFrom('reasoning.business_runs')
        .select('id')
        .where('universe_id', '=', a.universeId)
        .execute(),
    ).toEqual([]);
  });
  it('actual marker equals queue PK; live/mismatched rows block and exact terminal or missing rows allow same-business resume', async () => {
    for (const disposition of ['completed', 'cancelled', 'failed', 'missing'] as const) {
      const a = await seedPerson(database.db),
        first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
      if (first.kind !== 'accepted') throw new Error('CI request');
      const A = await header(a.universeId, first.runId),
        wakeId = A.normal_wake_id!;
      const row = await sql<{
        id: string;
        state: string;
        data: unknown;
        retry_limit: number;
      }>`select id,state,data,retry_limit from pgboss.job where name=${cartographyQueue.name} and id=${wakeId}::uuid`.execute(
        database.db,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]).toMatchObject({
        id: wakeId,
        state: 'created',
        retry_limit: 3,
        data: { v: 2, universeId: a.universeId, runId: first.runId, recordingGeneration: 1, wakeId },
      });
      expect(
        await request(a.authority, { commandId: randomUUID(), resumeRunId: first.runId, recordingGeneration: 1 }),
      ).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
      expect(await header(a.universeId, first.runId)).toEqual(A);
      if (disposition === 'completed')
        await boss.complete(cartographyQueue.name, wakeId, undefined, { includeQueued: true });
      else if (disposition === 'cancelled') await boss.cancel(cartographyQueue.name, wakeId);
      else if (disposition === 'missing') await boss.deleteJob(cartographyQueue.name, wakeId);
      else {
        // Exact authored lifecycle position at the unchanged declared retry ceiling; real boss fail/DLQ transition.
        await sql`update pgboss.job set retry_count=retry_limit where name=${cartographyQueue.name} and id=${wakeId}::uuid`.execute(
          database.db,
        );
        await boss.fail(cartographyQueue.name, wakeId, { code: 'CI retry ceiling' });
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pgboss.job where name=${deadLetterQueueName(cartographyQueue.name)} and source_name=${cartographyQueue.name} and source_id=${wakeId}::uuid`.execute(
              database.db,
            )
          ).rows[0]!.n,
        ).toBe(1);
      }
      expect(
        await request(a.authority, { commandId: randomUUID(), resumeRunId: first.runId, recordingGeneration: 1 }),
      ).toMatchObject({ kind: 'accepted', runId: first.runId });
      const B = await header(a.universeId, first.runId);
      expect(B.normal_wake_id).not.toBe(wakeId);
      expect(B.recording_origin_command_id).toBe(A.recording_origin_command_id);
      expect(B.recording_generation).toBe(1);
      expect(
        (
          await sql<{
            id: string;
          }>`select id from pgboss.job where name=${cartographyQueue.name} and id=${B.normal_wake_id}::uuid`.execute(
            database.db,
          )
        ).rows,
      ).toEqual([{ id: B.normal_wake_id }]);
      await worker()(
        { v: 2, universeId: a.universeId, privacyEpoch: 1, runId: first.runId, recordingGeneration: 1, wakeId },
        new AbortController().signal,
      );
      expect(await header(a.universeId, first.runId)).toEqual(B);
    }
    const a = await seedPerson(database.db),
      first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI request');
    const A = await header(a.universeId, first.runId),
      wakeId = A.normal_wake_id!;
    await boss.complete(cartographyQueue.name, wakeId, undefined, { includeQueued: true });
    await sql`update pgboss.job set data=jsonb_set(data,'{universeId}',to_jsonb(${randomUUID()}::text)) where name=${cartographyQueue.name} and id=${wakeId}::uuid`.execute(
      database.db,
    );
    expect(
      await request(a.authority, { commandId: randomUUID(), resumeRunId: first.runId, recordingGeneration: 1 }),
    ).toEqual({ kind: 'refused', reason: 'run_not_resumable' });
    expect(await header(a.universeId, first.runId)).toEqual(A);
  });
  it('fresh same-generation source recovers only queued/prepared terminal or missing wakes with no live claim', async () => {
    for (const status of ['queued', 'prepared', 'blocked', 'unknown'] as const) {
      for (const disposition of ['created', 'completed', 'missing', 'mismatch', 'live', 'expired'] as const) {
        const a = await seedPerson(database.db),
          first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
        if (first.kind !== 'accepted') throw new Error('CI request');
        const original = await header(a.universeId, first.runId),
          wakeId = original.normal_wake_id!;
        await sql`update geography.runs set status=${status} where universe_id=${a.universeId}::uuid and id=${first.runId}::uuid`.execute(
          database.db,
        );
        if (disposition === 'completed' || disposition === 'mismatch')
          await boss.complete(cartographyQueue.name, wakeId, undefined, { includeQueued: true });
        if (disposition === 'missing') await boss.deleteJob(cartographyQueue.name, wakeId);
        if (disposition === 'expired') {
          await boss.deleteJob(cartographyQueue.name, wakeId);
          const claimId = randomUUID();
          await sql`update geography.runs set claim_id=${claimId}::uuid,claim_until=now()-interval '1 second',claim_wake_claim_id=${claimId}::uuid where universe_id=${a.universeId}::uuid and id=${first.runId}::uuid`.execute(
            database.db,
          );
        }

        if (disposition === 'mismatch')
          await sql`update pgboss.job set data=jsonb_set(data,'{wakeId}',to_jsonb(${randomUUID()}::text)) where name=${cartographyQueue.name} and id=${wakeId}::uuid`.execute(
            database.db,
          );
        if (disposition === 'live')
          await sql`update geography.runs set claim_id=${randomUUID()}::uuid,claim_until=now()+interval '1 minute' where universe_id=${a.universeId}::uuid and id=${first.runId}::uuid`.execute(
            database.db,
          );
        const before = await header(a.universeId, first.runId),
          jobs = await jobCount(a.universeId);
        await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
        const after = await header(a.universeId, first.runId),
          recover =
            (status === 'queued' || status === 'prepared') &&
            (disposition === 'completed' || disposition === 'missing' || disposition === 'expired');
        if (recover) {
          expect(after.normal_wake_id).not.toBe(wakeId);
          expect(after.normal_wake_id).not.toBeNull();
          expect(await jobCount(a.universeId)).toBe(jobs + 1);
          expect(after.recording_origin_command_id).toBe(original.recording_origin_command_id);
        } else {
          expect(after).toEqual(before);
          expect(await jobCount(a.universeId)).toBe(jobs);
        }
      }
    }
  });
  it('stale retirement/ordinary/claim deliveries cannot retire newer pending B under actual zero-retained accounting', async () => {
    for (const retained of [false, true]) {
      const a = await seedPerson(database.db),
        first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
      if (first.kind !== 'accepted') throw new Error('CI request');
      await park(a.universeId, first.runId);
      if (retained)
        await p.withScope(a.authority, async (scope) => {
          if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
          const gate = await p.fenceRecording(scope, 1);
          if (gate.kind !== 'recording') throw new Error('CI cap');
          // Real ledger adapter, fixed synthetic accounting descriptor; no proposal/output/Role acceptance.
          const admitted = await fixtureHarness(database.db, { model: undefined }).ports.ledger.admitRun(scope, {
            id: first.runId,
            ownerModule: 'geography',
            purpose: 'personal-cartographer',
            roleId: 'ci.accounting',
            roleVersion: 'v1',
            policyVersion: 'geography-passive.v1',
            provider: 'ci',
            model: 'none',
            contextBundleRef: 'ci-accounting',
            contextRefs: [],
            recording: {
              accountId: a.accountId,
              generation: 1,
              contextSha256: 'a'.repeat(64),
              modelContextSha256: 'b'.repeat(64),
            },
          });
          expect(admitted.kind).toBe('admitted');
        });

      const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
      for (const [expectedRecordingGeneration, on] of [
        [1, false],
        [2, true],
      ] as const)
        await policy.set(a.authority, {
          version: 'recording-policy.v1',
          commandId: randomUUID(),
          expectedPrivacyEpoch: 1,
          expectedRecordingGeneration,
          on,
        });
      await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
      const A = await header(a.universeId, first.runId);
      await boss.cancel(cartographyQueue.name, A.normal_wake_id!);
      await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
      const B = await header(a.universeId, first.runId),
        jobs = await jobCount(a.universeId);
      expect(B.normal_wake_id).not.toBe(A.normal_wake_id);
      const base = { universeId: a.universeId, privacyEpoch: 1, runId: first.runId };
      for (const delivery of [
        { v: 2 as const, kind: 'retire' as const, ...base, recordingGeneration: 1, wakeId: A.normal_wake_id! },
        { v: 2 as const, ...base, recordingGeneration: 1, wakeId: A.normal_wake_id! },
        { v: 2 as const, ...base, recordingGeneration: 1, expectedClaimId: randomUUID() },
        { v: 1 as const, ...base },
      ]) {
        await worker(true)(delivery, new AbortController().signal);
        expect(await header(a.universeId, first.runId)).toEqual(B);
        expect(await jobCount(a.universeId)).toBe(jobs);
      }
      await worker(true)(
        { v: 2, kind: 'retire', ...base, recordingGeneration: 1, wakeId: B.normal_wake_id! },
        new AbortController().signal,
      );
      expect((await header(a.universeId, first.runId)).status).toBe('stale');
      expect(
        (
          await database.db
            .selectFrom('geography.state')
            .select('active_run_id')
            .where('universe_id', '=', a.universeId)
            .executeTakeFirstOrThrow()
        ).active_run_id,
      ).not.toBe(first.runId);
    }
  });
  it('revoked delayed A cannot retire current claim C even with no normal marker; only exact C owns cleanup', async () => {
    const a = await seedPerson(database.db),
      first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI request');
    const claimA = randomUUID(),
      claimC = randomUUID();
    await p.withScope(a.authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
      const gate = await p.fenceRecording(scope, 1);
      if (gate.kind !== 'recording') throw new Error('CI cap');
      const h = await geographyStore.header(scope, first.runId);
      if (!h) throw new Error('CI header');
      await geographyStore.writeRun(scope, {
        ...h,
        status: 'prepared',
        normalWakeId: undefined,
        claimId: claimA,
        claimUntil: new Date(Date.now() - 2000).toISOString(),
      });
      await p.enqueue(gate.scope, first.runId, { expectedClaimId: claimA, startAfter: new Date(Date.now() - 1000) });
      const prior = await geographyStore.header(scope, first.runId);
      if (!prior) throw new Error('CI header');
      await geographyStore.writeRun(scope, {
        ...prior,
        claimId: claimC,
        claimWakeClaimId: undefined,
        claimUntil: new Date(Date.now() + 60000).toISOString(),
      });
      await p.enqueue(gate.scope, first.runId, { expectedClaimId: claimC, startAfter: new Date() });
    });
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (const [expectedRecordingGeneration, on] of [
      [1, false],
      [2, true],
    ] as const)
      await policy.set(a.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration,
        on,
      });
    await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
    const B = await header(a.universeId, first.runId),
      jobs = await jobCount(a.universeId);
    expect(B.normal_wake_id).toBeNull();
    expect(B.claim_id).toBe(claimC);
    expect(B.claim_wake_claim_id).toBe(claimC);
    const base = {
      v: 2 as const,
      universeId: a.universeId,
      privacyEpoch: 1,
      runId: first.runId,
      recordingGeneration: 1,
    };
    await worker(true)({ ...base, expectedClaimId: claimA }, new AbortController().signal);
    expect(await header(a.universeId, first.runId)).toEqual(B);
    expect(await jobCount(a.universeId)).toBe(jobs);
    await worker(true)({ ...base, expectedClaimId: claimC }, new AbortController().signal);
    expect((await header(a.universeId, first.runId)).status).toBe('stale');
  });
  it('expired-before-first-claim legacy resume preserves NULL birth and only actual initial1 permits literal1 replacement', async () => {
    const a = await seedPerson(database.db),
      runId = randomUUID();
    await p.withScope(a.authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
      // Authored CI snapshot of a pre-existing all-NULL legacy row, not a new production run.
      await transactionOf(scope)
        .insertInto('geography.runs')
        .values({
          universe_id: a.universeId,
          privacy_epoch: 1,
          id: runId,
          desired_revision: 1,
          status: 'blocked',
        })
        .execute();
      await geographyStore.writeState(scope, {
        ...(await geographyStore.state(scope)),
        desiredRevision: 1,
        activeRunId: runId,
      });
    });
    expect(
      await request(a.authority, { commandId: randomUUID(), resumeRunId: runId, recordingGeneration: 1 }),
    ).toMatchObject({ kind: 'accepted', runId });
    const A = await header(a.universeId, runId);
    expect(A).toMatchObject({
      recording_account_id: null,
      recording_generation: null,
      recording_origin_kind: null,
      recording_origin_command_id: null,
      recording_origin_source_revision: null,
      recording_context_sha256: null,
      recording_model_context_sha256: null,
      context: null,
    });
    expect(A.normal_wake_id).not.toBeNull();
    await boss.cancel(cartographyQueue.name, A.normal_wake_id!);
    expect(
      await request(a.authority, { commandId: randomUUID(), resumeRunId: runId, recordingGeneration: 1 }),
    ).toMatchObject({ kind: 'accepted', runId });
    const B = await header(a.universeId, runId);
    expect(B.recording_generation).toBeNull();
    expect(B.normal_wake_id).not.toBe(A.normal_wake_id);
    const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    for (const [expectedRecordingGeneration, on] of [
      [1, false],
      [2, true],
    ] as const)
      await policy.set(a.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration,
        on,
      });
    expect(await request(a.authority, { commandId: randomUUID(), resumeRunId: runId, recordingGeneration: 3 })).toEqual(
      { kind: 'refused', reason: 'run_not_resumable' },
    );
    expect(await header(a.universeId, runId)).toEqual(B);
    await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
    expect((await header(a.universeId, runId)).normal_wake_id).toBe(B.normal_wake_id);
    await worker(true)(
      { v: 2, universeId: a.universeId, privacyEpoch: 1, runId, recordingGeneration: 1, wakeId: B.normal_wake_id! },
      new AbortController().signal,
    );
    expect(await header(a.universeId, runId)).toMatchObject({
      status: 'stale',
      recording_generation: null,
      recording_account_id: null,
      context: null,
    });
    const next = (
      await database.db
        .selectFrom('geography.state')
        .select('active_run_id')
        .where('universe_id', '=', a.universeId)
        .executeTakeFirstOrThrow()
    ).active_run_id!;
    expect(next).not.toBe(runId);
    expect(await header(a.universeId, next)).toMatchObject({
      status: 'queued',
      recording_generation: 3,
      context: null,
    });
  });
  it('terminal legacy literal1 wake may become exact NULL retirement; present NULL ledger is never adopted', async () => {
    for (const retained of [false, true]) {
      const a = await seedPerson(database.db),
        runId = randomUUID();
      await p.withScope(a.authority, async (scope) => {
        if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
        // Authored CI snapshot of a pre-existing all-NULL legacy row, not a new production run.
        await transactionOf(scope)
          .insertInto('geography.runs')
          .values({
            universe_id: a.universeId,
            privacy_epoch: 1,
            id: runId,
            desired_revision: 1,
            status: 'blocked',
          })
          .execute();
        await geographyStore.writeState(scope, {
          ...(await geographyStore.state(scope)),
          desiredRevision: 1,
          activeRunId: runId,
        });
      });
      await request(a.authority, { commandId: randomUUID(), resumeRunId: runId, recordingGeneration: 1 });
      const A = await header(a.universeId, runId);
      await boss.cancel(cartographyQueue.name, A.normal_wake_id!);
      if (retained)
        await database.db
          .insertInto('reasoning.business_runs')
          .values({
            universe_id: a.universeId,
            id: runId,
            owner_module: 'geography',
            purpose: 'personal-cartographer',
            privacy_epoch: 1,
          })
          .execute();
      const policy = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
      for (const [expectedRecordingGeneration, on] of [
        [1, false],
        [2, true],
      ] as const)
        await policy.set(a.authority, {
          version: 'recording-policy.v1',
          commandId: randomUUID(),
          expectedPrivacyEpoch: 1,
          expectedRecordingGeneration,
          on,
        });
      await request(a.authority, { commandId: randomUUID(), recordingGeneration: 3 });
      const B = await header(a.universeId, runId);
      expect(B.normal_wake_id).not.toBe(A.normal_wake_id);
      const data = (
        await sql<{
          data: unknown;
        }>`select data from pgboss.job where name=${cartographyQueue.name} and id=${B.normal_wake_id}::uuid`.execute(
          database.db,
        )
      ).rows[0]!.data;
      expect(data).toEqual({
        v: 2,
        kind: 'retire',
        universeId: a.universeId,
        privacyEpoch: 1,
        runId,
        recordingGeneration: null,
        wakeId: B.normal_wake_id,
      });
      await worker(true)({ v: 1, universeId: a.universeId, privacyEpoch: 1, runId }, new AbortController().signal);
      expect(await header(a.universeId, runId)).toEqual(B);
      await worker(true)(CartographyJobSchema.parse(data), new AbortController().signal);
      const after = await header(a.universeId, runId),
        state = await database.db
          .selectFrom('geography.state')
          .select('active_run_id')
          .where('universe_id', '=', a.universeId)
          .executeTakeFirstOrThrow();
      expect(after.recording_generation).toBeNull();
      expect(after.recording_account_id).toBeNull();
      expect(after.context).toBeNull();
      expect(after.normal_wake_id).toBeNull();
      expect(after.status).toBe(retained ? 'queued' : 'stale');
      if (retained) expect(state.active_run_id).toBe(runId);
      else {
        expect(state.active_run_id).not.toBe(runId);
        expect(await header(a.universeId, state.active_run_id!)).toMatchObject({
          recording_generation: 3,
          status: 'queued',
        });
      }
    }
  });
  it('early exact claim wake retries unchanged; copied capability and missing frozen pair refuse before body', async () => {
    const a = await seedPerson(database.db),
      first = await request(a.authority, { commandId: randomUUID(), recordingGeneration: 1 });
    if (first.kind !== 'accepted') throw new Error('CI request');
    const claimId = randomUUID();
    await p.withScope(a.authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('CI own');
      const gate = await p.fenceRecording(scope, 1);
      if (gate.kind !== 'recording') throw new Error('CI cap');
      const h = await geographyStore.header(scope, first.runId);
      if (!h) throw new Error('CI header');
      await geographyStore.writeRun(scope, {
        ...h,
        status: 'prepared',
        normalWakeId: undefined,
        claimId,
        claimUntil: new Date(Date.now() + 60000).toISOString(),
      });
      await p.enqueue(gate.scope, first.runId, { expectedClaimId: claimId, startAfter: new Date(Date.now() + 61000) });
      const check = makeCheckGeographyRecordingRun({
        store: { ...geographyStore, context: never },
        now: () => new Date(),
      });
      const purpose = {
        version: 'personal-role-purpose.v1' as const,
        accountId: a.accountId,
        universeId: a.universeId,
        privacyEpoch: 1,
        ownerModule: 'geography' as const,
        purpose: 'personal-cartographer' as const,
        businessRunId: first.runId,
        recordingGeneration: 1,
        contextSha256: 'a'.repeat(64),
        modelContextSha256: 'b'.repeat(64),
        claimId,
      };
      expect(await check(gate.scope, purpose)).toBe('unavailable');
      await expect(check({ ...gate.scope }, purpose)).rejects.toThrow();
      expect(
        (
          await transactionOf(scope)
            .selectFrom('geography.runs')
            .select('claim_wake_claim_id')
            .where('universe_id', '=', a.universeId)
            .where('id', '=', first.runId)
            .executeTakeFirstOrThrow()
        ).claim_wake_claim_id,
      ).toBe(claimId);
    });
    const before = await header(a.universeId, first.runId),
      jobs = await jobCount(a.universeId);
    await expect(
      worker()(
        {
          v: 2,
          universeId: a.universeId,
          privacyEpoch: 1,
          runId: first.runId,
          recordingGeneration: 1,
          expectedClaimId: claimId,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('GEOGRAPHY_CLAIM_WAKE_EARLY');
    expect(await header(a.universeId, first.runId)).toEqual(before);
    expect(await jobCount(a.universeId)).toBe(jobs);
  });
});
it('cartography queue retains inventory shape and refuses reserved-field downgrade/ambiguous wakes', () => {
  const base = { universeId: randomUUID(), privacyEpoch: 1, runId: randomUUID() };
  expect(CartographyJobSchema.shape.universeId).toBeDefined();
  expect(CartographyJobSchema.parse({ v: 1, ...base })).toEqual({ v: 1, ...base });
  for (const fields of [
    { recordingGeneration: undefined },
    { recordingGeneration: 1 },
    { wakeId: undefined },
    { wakeId: randomUUID() },
    { kind: 'retire' },
  ])
    expect(CartographyJobSchema.safeParse({ v: 1, ...base, ...fields }).success).toBe(false);
  for (const fields of [
    {},
    { recordingGeneration: 1 },
    { recordingGeneration: 1, wakeId: undefined },
    { recordingGeneration: 1, expectedClaimId: undefined },
    { recordingGeneration: 1, wakeId: randomUUID(), expectedClaimId: randomUUID() },
    { recordingGeneration: 2, wakeId: randomUUID() },
  ])
    expect(CartographyJobSchema.safeParse({ v: 2, ...base, ...fields }).success).toBe(false);
  for (const recordingGeneration of [null, 1, 3])
    expect(
      CartographyJobSchema.parse({ v: 2, kind: 'retire', ...base, recordingGeneration, wakeId: base.runId }),
    ).toMatchObject({ kind: 'retire', recordingGeneration });
  for (const fields of [
    { kind: 'retire', wakeId: base.runId },
    { kind: 'retire', recordingGeneration: null, wakeId: base.runId, expectedClaimId: undefined },
    { kind: 'retire', recordingGeneration: 2, wakeId: base.runId },
    { kind: undefined, recordingGeneration: 1, wakeId: base.runId },
    { recordingGeneration: null, wakeId: base.runId },
  ])
    expect(CartographyJobSchema.safeParse({ v: 2, ...base, ...fields }).success).toBe(false);
  for (const fields of [{ wakeId: randomUUID() }, { expectedClaimId: randomUUID() }])
    expect(CartographyJobSchema.parse({ v: 2, ...base, recordingGeneration: 3, ...fields })).toEqual({
      v: 2,
      ...base,
      recordingGeneration: 3,
      ...fields,
    });
});
