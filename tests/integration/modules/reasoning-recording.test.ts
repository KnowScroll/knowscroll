import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  advanceScopeRevision,
  fencePersonalRecording,
  makeWithPersonalScope,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases, recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import type { RecordingScopeTx } from '@knowscroll/backend/modules/identity';
import type { PersonalRecordingPurpose, PersonalRunAccountingBinding } from '@knowscroll/backend/reasoning';
import { personalRecordingReasoningHarnessFor } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import {
  attemptsOf,
  echoRole,
  fixtureContext,
  fixtureHarness,
  fixtureModel,
  fixtureRun,
  fixtureSettings,
  gate,
  receiptsOf,
  signal,
  silent,
  systemAuthority,
} from '../support/fixture-model.js';

/** CI ONLY: real root/account/recording/ledger, synthetic model. No positive Role-owner pipeline is claimed.
 * Required role ports here deliberately deny: actual Planner/Geography composition is a later dependency. */
describe('personal recording Reasoning prerequisite (PostgreSQL hosted fixtures only)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('reasoning_recording');
  });
  afterEach(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const withScope = () => makeWithPersonalScope(db(), { lockTimeoutMs: 5000 });
  const own = () => accountAccessUseCases({ db: db(), lockTimeoutMs: 5000 }).fenceOwnAccount;
  const propose = (h: ReturnType<typeof fixtureHarness>['harness'], p: FixturePerson, runId = randomUUID()) =>
    h.propose(
      { run: fixtureRun(systemAuthority(p.universeId), runId), role: echoRole, context: fixtureContext },
      signal(),
    );
  async function toggle(p: FixturePerson, generation: number, on: boolean) {
    expect(
      await recordingPolicyFor(db(), { lockTimeoutMs: 5000 }).set(p.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration: generation,
        on,
      }),
    ).toMatchObject({ kind: 'ok' });
  }
  function recording() {
    const checkPlanner = vi.fn(() => Promise.resolve('unavailable' as const)),
      checkGeography = vi.fn(() => Promise.resolve('unavailable' as const));
    const model = fixtureModel();
    const harness = personalRecordingReasoningHarnessFor({
      db: db(),
      withPersonalScope: withScope(),
      fenceOwn: own(),
      model,
      logEvent: silent,
      settings: fixtureSettings,
      checkPlanner,
      checkGeography,
    });
    return { harness, model, checkPlanner, checkGeography };
  }
  const purpose = (p: FixturePerson, g: number, id = randomUUID()): PersonalRecordingPurpose => ({
    version: 'personal-role-purpose.v1',
    accountId: p.accountId,
    universeId: p.universeId,
    privacyEpoch: 1,
    ownerModule: 'planner',
    purpose: 'personal-planner',
    businessRunId: id,
    recordingGeneration: g,
    contextSha256: 'a'.repeat(64),
    modelContextSha256: canonicalSha256(fixtureContext),
    claimId: randomUUID(),
  });

  it('never reads a kept initial1 output/issues after off2/on3, and never upgrades that old run', async () => {
    const p = await seedPerson(db()),
      model = fixtureModel(),
      first = fixtureHarness(db(), { model });
    const runId = randomUUID();
    expect(await propose(first.harness, p, runId)).toMatchObject({ kind: 'proposed' });
    const before = await attemptsOf(db(), p.universeId);
    const findLocked = vi.fn(first.ports.ledger.findLocked);
    const replay = fixtureHarness(db(), { model, overrides: { ledger: { ...first.ports.ledger, findLocked } } });
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    expect(await propose(replay.harness, p, runId)).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(findLocked).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
    expect(await attemptsOf(db(), p.universeId)).toEqual(before);
  });

  it.each(['recording', 'epoch', 'account'] as const)(
    'rechecks %s after an actual held-root wait before any private ledger query',
    async (change) => {
      const p = await seedPerson(db()),
        model = fixtureModel(),
        entered = gate(),
        requested = gate(),
        mutate = gate();
      const base = fixtureHarness(db(), { model });
      const findLocked = vi.fn(base.ports.ledger.findLocked);
      const c = fixtureHarness(db(), {
        model,
        overrides: {
          ledger: { ...base.ports.ledger, findLocked },
          withPersonalScope: async (authority, work) => {
            requested.open();
            return withScope()(authority, work);
          },
        },
      });
      const held = withScope()(p.authority, async (scope) => {
        expect((await own()(scope)).kind).toBe('active');
        entered.open();
        await mutate.promise;
        // Deliberate authority-race fixture, under the genuine own-account/root transaction.
        // These transitions are not fake acknowledgements or a production policy writer.
        if (change === 'recording')
          await transactionOf(scope)
            .updateTable('identity.universes')
            .set({ recording_on: false, recording_generation: 2 })
            .where('id', '=', p.universeId)
            .execute();
        if (change === 'epoch')
          await transactionOf(scope)
            .updateTable('identity.universes')
            .set({ privacy_epoch: 2 })
            .where('id', '=', p.universeId)
            .execute();
        if (change === 'account')
          await transactionOf(scope)
            .updateTable('identity.accounts')
            .set({ status: 'suspended' })
            .where('id', '=', p.accountId)
            .execute();
      });
      await entered.promise;
      const pending = propose(c.harness, p);
      await requested.promise;
      mutate.open();
      expect((await held).kind).toBe('entered');
      expect((await pending).kind).toBe('refused');
      expect(findLocked).not.toHaveBeenCalled();
      expect(await attemptsOf(db(), p.universeId)).toEqual([]);
      expect(model.calls).toHaveLength(0);
    },
  );

  it.each([false, true])(
    'accounts an in-flight %s reply while off without private re-read or a repair',
    async (invalid) => {
      const p = await seedPerson(db()),
        started = gate(),
        release = gate();
      const model = fixtureModel(async () => {
        started.open();
        await release.promise;
        return { kind: 'success', text: invalid ? '{"ok":false}' : '{"ok":true,"echo":"paused-late-fixture"}' };
      });
      const base = fixtureHarness(db(), { model });
      let afterPause = false;
      const privateReads = vi.fn(async (...args: Parameters<typeof base.ports.ledger.findLocked>) => {
        if (afterPause) throw new Error('CI_PRIVATE_READ_AFTER_PAUSE');
        return base.ports.ledger.findLocked(...args);
      });
      const c = fixtureHarness(db(), {
        model,
        overrides: { ledger: { ...base.ports.ledger, findLocked: privateReads } },
      });
      const running = propose(c.harness, p);
      await started.promise;
      await toggle(p, 1, false);
      afterPause = true;
      release.open();
      expect(await running).toMatchObject({ kind: 'refused', reason: 'output_ineligible' });
      expect(model.calls).toHaveLength(1);
      const rows = await attemptsOf(db(), p.universeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'succeeded' });
      expect((await receiptsOf(db(), [rows[0]!.id]))[0]).toMatchObject({ state: 'settled' });
      // Reply storage/usage accounting stays unchanged; it is never handed back or used for repair while off.
      const reads = privateReads.mock.calls.length;
      expect(await propose(c.harness, p)).toEqual({ kind: 'refused', reason: 'scope_refused' });
      expect(privateReads).toHaveBeenCalledTimes(reads);
    },
  );

  it('keeps exact legacy request mismatch private: changed same-ref text is rejected before kept output selection', async () => {
    const p = await seedPerson(db()),
      model = fixtureModel(),
      c = fixtureHarness(db(), { model }),
      runId = randomUUID();
    expect(await propose(c.harness, p, runId)).toMatchObject({ kind: 'proposed' });
    const findLocked = vi.fn(c.ports.ledger.findLocked);
    const second = fixtureHarness(db(), { model, overrides: { ledger: { ...c.ports.ledger, findLocked } } });
    expect(
      await second.harness.propose(
        {
          run: fixtureRun(systemAuthority(p.universeId), runId),
          role: echoRole,
          context: {
            ...fixtureContext,
            items: fixtureContext.items.map((x) => ({ ...x, text: 'changed-same-ref-fixture' })),
          },
        },
        signal(),
      ),
    ).toEqual({ kind: 'refused', reason: 'request_mismatch' });
    expect(findLocked).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });

  it('requires a real current owner proof even for a syntactically complete resumed purpose', async () => {
    const p = await seedPerson(db()),
      c = recording();
    await toggle(p, 1, false);
    await toggle(p, 2, true);
    const proof = purpose(p, 3);
    expect(
      await c.harness.proposePersonal(
        {
          recordingPurpose: proof,
          run: {
            id: proof.businessRunId,
            authority: systemAuthority(p.universeId),
            ownerModule: 'planner',
            purpose: 'personal-planner',
            policyVersion: 'fixture.v1',
          },
          role: echoRole,
          context: fixtureContext,
        },
        signal(),
      ),
    ).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(c.checkPlanner).toHaveBeenCalledOnce();
    expect(c.checkGeography).not.toHaveBeenCalled();
    expect(c.model.calls).toHaveLength(0);
    expect(await attemptsOf(db(), p.universeId)).toEqual([]);
    const work = vi.fn();
    expect(await c.harness.withPersonalApply(p.authority, proof, work)).toMatchObject({ kind: 'refused' });
    expect(work).not.toHaveBeenCalled();
  });

  /** Accounting adapter fixture only: real gated ledger writes, no successful Role owner adapter/model pipeline. */
  async function accountingRun(p: FixturePerson, steps: readonly string[] = ['primary']) {
    const c = fixtureHarness(db(), { model: undefined }),
      runId = randomUUID(),
      ids = steps.map(() => randomUUID());
    const binding: PersonalRunAccountingBinding = {
      ownerModule: 'planner',
      purpose: 'personal-planner',
      accountId: p.accountId,
      privacyEpoch: 1,
      recordingGeneration: 1,
    };
    expect(
      await withScope()(p.authority, async (scope) => {
        expect((await own()(scope)).kind).toBe('active');
        expect((await fencePersonalRecording(scope, 1)).kind).toBe('recording');
        expect(
          await c.ports.ledger.admitRun(scope, {
            id: runId,
            ownerModule: 'planner',
            purpose: 'personal-planner',
            roleId: 'fixture.echo',
            roleVersion: 'v1',
            policyVersion: 'fixture.v1',
            provider: 'fixture',
            model: 'fixture',
            contextBundleRef: fixtureContext.bundleRef,
            contextRefs: fixtureContext.items.map((x) => x.ref),
            recording: {
              accountId: p.accountId,
              generation: 1,
              contextSha256: 'a'.repeat(64),
              modelContextSha256: canonicalSha256(fixtureContext),
            },
          }),
        ).toMatchObject({ kind: 'admitted' });
        for (const [n, step] of steps.entries())
          await c.ports.ledger.reserve(scope, {
            id: ids[n]!,
            runId,
            step,
            provider: 'fixture',
            model: 'fixture',
            roleId: 'fixture.echo',
            roleVersion: 'v1',
            promptVersion: 'fixture.v1',
            requestHash: 'b'.repeat(64),
            requestBody: new Uint8Array([1]),
            maxOutputTokens: 1,
            reservedTokens: 2,
            requestRetentionSeconds: 60,
          });
      }),
    ).toMatchObject({ kind: 'entered' });
    return { runId, ids, binding, ledger: c.ports.ledger };
  }

  it('reads bound accounting while off, before any owner growth proof, and never promotes legacy NULL', async () => {
    const p = await seedPerson(db()),
      seeded = await accountingRun(p),
      c = recording();
    await toggle(p, 1, false);
    const expected = vi.fn(() => Promise.resolve(seeded.binding));
    const read = () =>
      withScope()(p.authority, (scope) => c.harness.readPersonalRunAccounting(scope, seeded.runId, expected));
    expect(await read()).toMatchObject({ kind: 'entered', value: { kind: 'accounted', disposition: 'unresolved' } });
    expect(expected).toHaveBeenCalledOnce();
    expect(
      await seeded.ledger.settle({ scopeId: p.universeId, attemptId: seeded.ids[0]! }, 'reserved', 'not_sent'),
    ).toBe(true);
    const done = await read();
    expect(done).toMatchObject({ kind: 'entered', value: { kind: 'accounted', disposition: 'conclusive' } });
    expect(JSON.stringify(done)).not.toMatch(/context|output|issues|hash/u);
    expect(
      await withScope()(p.authority, (scope) =>
        c.harness.readPersonalRunAccounting(scope, seeded.runId, () =>
          Promise.resolve({ ...seeded.binding, recordingGeneration: null }),
        ),
      ),
    ).toMatchObject({ kind: 'entered', value: { kind: 'unavailable', reason: 'unproved' } });
    expect(
      await withScope()(p.authority, (scope) =>
        c.harness.readPersonalRunAccounting(scope, seeded.runId, () =>
          Promise.resolve({ ...seeded.binding, purpose: 'personal-cartographer' }),
        ),
      ),
    ).toMatchObject({ kind: 'entered', value: { kind: 'unavailable', reason: 'unproved' } });
    expect(
      await withScope()(p.authority, (scope) =>
        c.harness.readPersonalRunAccounting(scope, randomUUID(), () => Promise.resolve(seeded.binding)),
      ),
    ).toMatchObject({ kind: 'entered', value: { kind: 'not_found' } });
    const fk = await sql<{
      convalidated: boolean;
      definition: string;
    }>`select convalidated,pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid='reasoning.external_attempts'::regclass and conname='external_attempts_run_fkey'`.execute(
      db(),
    );
    expect(fk.rows).toEqual([
      {
        convalidated: true,
        definition:
          'FOREIGN KEY (universe_id, run_id) REFERENCES reasoning.business_runs(universe_id, id) ON DELETE RESTRICT',
      },
    ]);
    expect(c.checkPlanner).not.toHaveBeenCalled();
    expect(c.checkGeography).not.toHaveBeenCalled();
    expect(c.model.calls).toHaveLength(0);
  });

  it('seals original ledger proof and redacts it while retaining an actual unknown liability', async () => {
    const p = await seedPerson(db()),
      seeded = await accountingRun(p),
      c = recording(),
      attemptId = seeded.ids[0]!;
    await expect(
      withScope()(p.authority, async (scope) => {
        expect((await own()(scope)).kind).toBe('active');
        await transactionOf(scope)
          .updateTable('reasoning.business_runs')
          .set({ recording_generation: 3 })
          .where('universe_id', '=', p.universeId)
          .where('id', '=', seeded.runId)
          .execute();
      }),
    ).rejects.toThrow('PERSONAL_REASONING_RECORDING_PROOF_IMMUTABLE');
    expect(
      await withScope()(p.authority, async (scope) => {
        expect((await own()(scope)).kind).toBe('active');
        return seeded.ledger.commitDispatch(scope, attemptId, {
          dispatchId: randomUUID(),
          dispatchedBy: 'ci-fixture',
          quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
        });
      }),
    ).toMatchObject({ kind: 'entered', value: true });
    expect(await seeded.ledger.settle({ scopeId: p.universeId, attemptId }, 'dispatched', 'unknown')).toBe(true);
    await toggle(p, 1, false);
    const expected = () => Promise.resolve(seeded.binding);
    expect(
      await withScope()(p.authority, (scope) => c.harness.readPersonalRunAccounting(scope, seeded.runId, expected)),
    ).toMatchObject({ kind: 'entered', value: { kind: 'accounted', disposition: 'unresolved' } });
    const store = personalStores.find((s) => s.module === 'reasoning')!;
    expect(await withScope()(p.authority, (scope) => eraseUniverse(scope, [store]))).toMatchObject({ kind: 'entered' });
    expect(
      await db()
        .selectFrom('reasoning.business_runs')
        .select([
          'universe_id',
          'id',
          'owner_module',
          'privacy_epoch',
          'recording_account_id',
          'recording_generation',
          'recording_context_sha256',
          'recording_model_context_sha256',
        ])
        .where('universe_id', '=', p.universeId)
        .where('id', '=', seeded.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      universe_id: p.universeId,
      id: seeded.runId,
      owner_module: 'planner',
      privacy_epoch: 1,
      recording_account_id: null,
      recording_generation: null,
      recording_context_sha256: null,
      recording_model_context_sha256: null,
    });
    expect(await attemptsOf(db(), p.universeId)).toMatchObject([
      { id: attemptId, state: 'unknown', output: null, output_issues: null },
    ]);
    expect((await receiptsOf(db(), [attemptId]))[0]).toMatchObject({ state: 'unknown' });
    expect(
      await withScope()(p.authority, (scope) => c.harness.readPersonalRunAccounting(scope, seeded.runId, expected)),
    ).toMatchObject({ kind: 'entered', value: { kind: 'unavailable', reason: 'unproved' } });
    expect(c.model.calls).toHaveLength(0);
  });

  it('bounds accounting by a raw nine-row sentinel, before any logical sequence selection', async () => {
    const p = await seedPerson(db()),
      seeded = await accountingRun(p, [
        'primary',
        'primary.2',
        'primary.3',
        'primary.4',
        'repair',
        'repair.2',
        'repair.3',
        'repair.4',
        'primary.5',
      ]),
      c = recording();
    expect(
      await withScope()(p.authority, (scope) =>
        c.harness.readPersonalRunAccounting(scope, seeded.runId, () => Promise.resolve(seeded.binding)),
      ),
    ).toMatchObject({ kind: 'entered', value: { kind: 'unavailable', reason: 'limit' } });
    expect(await attemptsOf(db(), p.universeId)).toHaveLength(9);
  });

  it.each(['epoch', 'account'] as const)(
    'does not invoke the accounting owner-header callback after a waited %s refusal',
    async (change) => {
      const p = await seedPerson(db()),
        c = recording(),
        entered = gate(),
        mutate = gate(),
        requested = gate();
      const expected = vi.fn(() => Promise.resolve('unavailable' as const));
      const held = withScope()(p.authority, async (scope) => {
        expect((await own()(scope)).kind).toBe('active');
        entered.open();
        await mutate.promise;
        if (change === 'epoch')
          await transactionOf(scope)
            .updateTable('identity.universes')
            .set({ privacy_epoch: 2 })
            .where('id', '=', p.universeId)
            .execute();
        else
          await transactionOf(scope)
            .updateTable('identity.accounts')
            .set({ status: 'suspended' })
            .where('id', '=', p.accountId)
            .execute();
      });
      await entered.promise;
      const pending = (async () => {
        requested.open();
        return withScope()(p.authority, (scope) => c.harness.readPersonalRunAccounting(scope, randomUUID(), expected));
      })();
      await requested.promise;
      mutate.open();
      await held;
      const result = await pending;
      expect(result.kind === 'refused' || (result.kind === 'entered' && result.value.kind === 'unavailable')).toBe(
        true,
      );
      expect(expected).not.toHaveBeenCalled();
    },
  );

  it('rolls back old legacy application effects when pause occurs after its accepted answer', async () => {
    const p = await seedPerson(db()),
      c = fixtureHarness(db(), { model: fixtureModel() }),
      runId = randomUUID();
    expect(await propose(c.harness, p, runId)).toMatchObject({ kind: 'proposed' });
    await toggle(p, 1, false);
    const before = await db()
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    await expect(
      withScope()(p.authority, async (scope) => {
        await advanceScopeRevision(scope);
        return c.harness.closeRun(scope, { runId, state: 'completed' });
      }),
    ).rejects.toThrow('PERSONAL_REASONING_AUTHORITY_REFUSED');
    expect(
      await db()
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      await db()
        .selectFrom('reasoning.business_runs')
        .select('state')
        .where('universe_id', '=', p.universeId)
        .where('id', '=', runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'admitted' });
  });

  it('a genuine common cap, its copy and its expired reference cannot close a facade-owned apply run', async () => {
    const p = await seedPerson(db()),
      c = recording(),
      proof = purpose(p, 1);
    let expired: RecordingScopeTx | undefined;
    await withScope()(p.authority, async (scope) => {
      expect((await own()(scope)).kind).toBe('active');
      const gate = await fencePersonalRecording(scope, 1);
      if (gate.kind !== 'recording') throw new Error('CI_RECORDING_CAP_REQUIRED');
      expired = gate.scope;
      await expect(
        c.harness.closePersonalRun(gate.scope, {
          runId: proof.businessRunId,
          state: 'completed',
          recordingPurpose: proof,
        }),
      ).rejects.toThrow('PERSONAL_REASONING_AUTHORITY_REFUSED');
      await expect(
        c.harness.closePersonalRun(
          { ...gate.scope },
          { runId: proof.businessRunId, state: 'completed', recordingPurpose: proof },
        ),
      ).rejects.toThrow();
    });
    await expect(
      c.harness.closePersonalRun(expired!, { runId: proof.businessRunId, state: 'completed', recordingPurpose: proof }),
    ).rejects.toThrow();
    expect(c.checkPlanner).not.toHaveBeenCalled();
    expect(
      await sql<{ count: string }>`select count(*)::text as count from reasoning.business_runs
      where universe_id=${p.universeId}::uuid`.execute(db()),
    ).toMatchObject({ rows: [{ count: '0' }] });
  });
});
