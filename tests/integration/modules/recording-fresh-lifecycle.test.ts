import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eraseCurrentExploration, explorationStores, personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse, eraseExploration, clearExplorationRegistry } from '@knowscroll/backend/infrastructure/erasure';
import {
  makeWithPersonalScope,
  fencePersonalRecording,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { createBoss, applyQueueDeclarations } from '@knowscroll/backend/infrastructure/jobs';
import {
  RECORDING_LIFECYCLE_PROTOCOL_SHA256,
  clearExplorationQueue,
  recoverClearOperationsQueue,
  type RecordingScopeTx,
} from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  operatorSignInUseCase,
  readRecordingLifecycle,
  recordingPolicyFor,
  clearExplorationFor,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning, makeAttemptLedger } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { gate } from '../support/fixture-model.js';
import { experienceUseCases } from '../support/experience.js';
import { seedPerson, seedAsset, type FixturePerson } from '../support/fixtures.js';
import { admitStarter, scrollUseCases, textCapabilities } from '../support/scroll.js';

/** Actions-only real disposable lifecycle/required graph. No synthetic empty certificate,
 * direct pointer seed, provider output, owner Clear or installed Pause acceptance. */
describe('fresh recording lifecycle certification (Actions only)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recording_fresh');
  });
  afterEach(async () => {
    await database.drop();
  });
  async function born(): Promise<FixturePerson> {
    const result = await operatorSignInUseCase({
      db: database.db,
      publicOrigin: 'https://ci.invalid',
      lockTimeoutMs: 5000,
      pattern: '*@fresh.test',
      world: 'ci',
      operatorSource: 'cli:ci-fresh-lifecycle',
    })({ email: `${randomUUID()}@fresh.test` });
    if (result.kind !== 'issued') throw new Error('CI actual createAccount failed');
    const { accountId, universeId } = result.outcome;
    return { accountId, universeId, authority: { universeId, privacyEpoch: 1, actor: { kind: 'account', accountId } } };
  }
  async function inRecording<T>(p: FixturePerson, g: number, work: (cap: RecordingScopeTx) => Promise<T>) {
    return makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
      const own = await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope);
      if (own.kind !== 'active') throw new Error('CI own unavailable');
      const recording = await fencePersonalRecording(scope, g);
      if (recording.kind !== 'recording') throw new Error('CI recording unavailable');
      return work(recording.scope);
    });
  }
  const policy = (p: FixturePerson, g: number, on: boolean) =>
    recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(p.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: p.authority.privacyEpoch,
      expectedRecordingGeneration: g,
      on,
    });
  const certificates = (p: FixturePerson) =>
    database.db
      .selectFrom('experience.recording_channel_certificates')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .orderBy('channel')
      .execute();
  const witnesses = (p: FixturePerson) =>
    database.db
      .selectFrom('identity.recording_lifecycle_witnesses')
      .selectAll()
      .where('universe_id', '=', p.universeId)
      .execute();
  async function clear(p: FixturePerson, eraseCore = eraseCurrentExploration) {
    const boss = createBoss(database.settings, 'install', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    try {
      await applyQueueDeclarations(boss, [clearExplorationQueue, recoverClearOperationsQueue]);
      const use = clearExplorationFor(database.db, boss, { reasoning: clearReasoning, eraseCore });
      const commandId = randomUUID();
      expect(
        await use.start(
          { accountId: p.accountId, universeId: p.universeId, privacyEpoch: p.authority.privacyEpoch },
          {
            version: 'clear-exploration.v1',
            commandId,
            expectedPrivacyEpoch: p.authority.privacyEpoch,
            confirmation: 'clear-exploration-preserve-keep-and-social',
          },
        ),
      ).toMatchObject({ kind: 'ok' });
      await use.process({ v: 1, accountId: p.accountId, commandId });
      return await database.db
        .selectFrom('identity.clear_operations')
        .selectAll()
        .where('command_id', '=', commandId)
        .executeTakeFirstOrThrow();
    } finally {
      await boss.stop({ graceful: false });
    }
  }
  async function twoExposures(c: Awaited<ReturnType<typeof scrollUseCases>>, p: FixturePerson) {
    const asset = await admitStarter(c.importScroll),
      ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const opened = await c.openExposure(p.authority, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: asset.assetId },
        origin: { kind: 'direct' },
        capabilities: textCapabilities,
      });
      if (opened.kind !== 'opened') throw new Error('CI open');
      expect(
        await c.activateExposure(p.authority, {
          commandId: randomUUID(),
          exposureId: opened.outcome.exposureId,
          recordingGeneration: 1,
        }),
      ).toMatchObject({ kind: 'activated' });
      ids.push(opened.outcome.exposureId);
    }
    return { asset, ids };
  }
  it('checks non-NULL audit identities without confusing SQL arguments with Evidence columns', async () => {
    const p = await born(),
      exposureId = randomUUID();
    await expect(
      inRecording(p, 1, (cap) =>
        sql`select evidence.require_recording_audits(${p.universeId}::uuid,1,${exposureId}::uuid,1,null,null)`.execute(
          transactionOf(cap.personal),
        ),
      ),
    ).resolves.toMatchObject({ kind: 'entered' });
    await expect(
      inRecording(p, 1, (cap) =>
        sql`select evidence.require_recording_audits(${p.universeId}::uuid,1,${exposureId}::uuid,1,${randomUUID()}::uuid,null)`.execute(
          transactionOf(cap.personal),
        ),
      ),
    ).rejects.toThrow('recording_qualification_identity');
    await expect(
      inRecording(p, 1, (cap) =>
        sql`select evidence.require_recording_audits(${p.universeId}::uuid,1,${exposureId}::uuid,1,null,${randomUUID()}::uuid)`.execute(
          transactionOf(cap.personal),
        ),
      ),
    ).rejects.toThrow('recording_activity_identity');
  });

  it('issues birth only through actual account creation; pure reads reject copied and expired capabilities', async () => {
    const p = await born(),
      legacy = await seedPerson(database.db);
    expect(await witnesses(p)).toMatchObject([
      {
        account_id: p.accountId,
        privacy_epoch: 1,
        protocol_version: 1,
        origin_kind: 'birth',
        clear_operation_id: null,
        registry_sha256: RECORDING_LIFECYCLE_PROTOCOL_SHA256,
      },
    ]);
    expect(await witnesses(legacy)).toEqual([]);
    expect(
      await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
        const cap = await fencePersonalRecording(scope, 1);
        if (cap.kind !== 'recording') throw new Error('CI genuine root cap');
        return readRecordingLifecycle(cap.scope);
      }),
    ).toMatchObject({ kind: 'entered', value: { kind: 'unavailable' } });

    const peer = await born();
    expect(
      await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
        expect(
          (
            await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceAccountPair(
              scope,
              peer.accountId,
            )
          ).kind,
        ).toBe('active');
        const cap = await fencePersonalRecording(scope, 1);
        if (cap.kind !== 'recording') throw new Error('CI pair root cap');
        return readRecordingLifecycle(cap.scope);
      }),
    ).toMatchObject({ value: { kind: 'unavailable' } });
    const failedOwner = await born();
    await expect(
      makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(failedOwner.authority, async (scope) => {
        const cap = await fencePersonalRecording(scope, 1);
        if (cap.kind !== 'recording') throw new Error('CI root cap before refused own');
        await sql`update identity.accounts set status='suspended' where id=${failedOwner.accountId}::uuid`.execute(
          transactionOf(scope),
        );
        expect(await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope)).toEqual({
          kind: 'unavailable',
        });
        expect(await readRecordingLifecycle(cap.scope)).toEqual({ kind: 'unavailable' });
        throw new Error('CI rollback refused-own fixture');
      }),
    ).rejects.toThrow('CI rollback refused-own fixture');
    let expired: RecordingScopeTx | undefined;
    const before = await database.db
      .selectFrom('identity.universes')
      .selectAll()
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    expect(
      await inRecording(p, 1, async (cap) => {
        expired = cap;
        await expect(readRecordingLifecycle({ ...cap })).rejects.toThrow();
        return readRecordingLifecycle(cap);
      }),
    ).toMatchObject({ kind: 'entered', value: { kind: 'fresh' } });
    await expect(readRecordingLifecycle(expired!)).rejects.toThrow();
    expect(await inRecording(legacy, 1, readRecordingLifecycle)).toMatchObject({ value: { kind: 'legacy_unknown' } });
    expect(
      await database.db
        .selectFrom('identity.universes')
        .selectAll()
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(await certificates(p)).toEqual([]);
    await expect(
      database.db
        .updateTable('identity.universes')
        .set({ recording_lifecycle_protocol: 1 })
        .where('id', '=', legacy.universeId)
        .execute(),
    ).rejects.toThrow('recording_lifecycle_no_legacy_adoption');
    await expect(
      database.db
        .updateTable('identity.universes')
        .set({ recording_lifecycle_protocol: null })
        .where('id', '=', p.universeId)
        .execute(),
    ).rejects.toThrow('recording_lifecycle_mode_immutable');
  });
  it('reads the actual lifecycle after a real root wait instead of retaining a pre-wait witness', async () => {
    const p = await born(),
      locked = gate(),
      release = gate();
    let pid = 0;
    const holder = database.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.universes')
        .select('id')
        .where('id', '=', p.universeId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!.pid;
      await tx.deleteFrom('identity.recording_lifecycle_witnesses').where('universe_id', '=', p.universeId).execute();
      locked.open();
      await release.promise;
    });
    await locked.promise;
    const pending = inRecording(p, 1, readRecordingLifecycle);
    try {
      let waited = false;
      for (let n = 0; n < 100; n++) {
        const rows = await sql<{
          waiting: boolean;
        }>`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as waiting`.execute(
          database.db,
        );
        if (rows.rows[0]?.waiting) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waited).toBe(true);
      release.open();
      await holder;
      expect(await pending).toMatchObject({ kind: 'entered', value: { kind: 'not_ready' } });
      expect(await witnesses(p)).toEqual([]);
    } finally {
      release.open();
      await Promise.allSettled([holder, pending]);
    }
  });
  it('uses an actual first eligible negative without fabricated false credit, material revision or audit', async () => {
    const p = await born(),
      c = await scrollUseCases(database, { recording: true });
    try {
      const asset = await admitStarter(c.importScroll),
        target = { assetId: asset.assetId, assetRevision: asset.revision };
      const before = await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow();
      const negative = await c.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'unsave',
        target,
        recordingGeneration: 1,
      });
      expect(negative).toMatchObject({ kind: 'applied', outcome: { changed: false } });
      if (negative.kind !== 'applied') throw new Error('CI negative');
      expect(await certificates(p)).toMatchObject([
        {
          channel: 'saved',
          initializing_action_id: negative.outcome.actionId,
          first_decision_action_id: negative.outcome.actionId,
        },
      ]);
      expect(
        await database.db
          .selectFrom('experience.action_state')
          .select(['recording_saved_state', 'recording_saved_origin_exposure_id', 'recording_liked_state'])
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([
        { recording_saved_state: false, recording_saved_origin_exposure_id: null, recording_liked_state: null },
      ]);
      expect(
        await database.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(
        await database.db
          .selectFrom('evidence.activity_revisions')
          .select('id')
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
    } finally {
      await c.close();
    }
  });
  it('fails fresh eligible growth in the legacy factory atomically but keeps paused necessary Save', async () => {
    const p = await born(),
      c = await experienceUseCases(database),
      asset = await seedAsset(database.db);
    try {
      const command = {
        commandId: randomUUID(),
        kind: 'save' as const,
        target: { assetId: asset.assetId, assetRevision: 1 },
      };
      await expect(c.applyAction(p.authority, command)).rejects.toThrow('EXPERIENCE_RECORDING_EFFECTS_REQUIRED');
      expect(
        await database.db
          .selectFrom('experience.saved_items')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
      expect(
        await database.db
          .selectFrom('experience.actions')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
      expect(
        await database.db
          .selectFrom('receipts.personal_commands')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .where('command_id', '=', command.commandId)
          .execute(),
      ).toEqual([]);
      await policy(p, 1, false);
      expect(await c.applyAction(p.authority, { ...command, recordingGeneration: 2 })).toMatchObject({
        kind: 'applied',
        outcome: { changed: true },
      });
      expect(await certificates(p)).toEqual([]);
    } finally {
      await c.close();
    }
  });
  it('uses independent real channel decisions; paused changes never backfill and transfers replace at most two effective exposures', async () => {
    const p = await born(),
      c = await scrollUseCases(database, { recording: true });
    try {
      const { asset, ids } = await twoExposures(c, p),
        target = { assetId: asset.assetId, assetRevision: asset.revision };
      const save = {
        commandId: randomUUID(),
        kind: 'save' as const,
        target,
        exposureId: ids[0]!,
        recordingGeneration: 1,
      };
      const accepted = await c.applyEncounterAction(p.authority, save);
      expect(accepted).toMatchObject({ kind: 'applied', outcome: { changed: true } });
      expect((await certificates(p)).map((x) => x.channel)).toEqual(['saved']);
      const audit = await database.db
        .selectFrom('evidence.activity_revisions')
        .select(['id', 'privacy_epoch', 'exposure_id', 'recording_generation'])
        .where('universe_id', '=', p.universeId)
        .where('exposure_id', '=', ids[0]!)
        .orderBy('revision', 'desc')
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({ privacy_epoch: 1, exposure_id: ids[0], recording_generation: 1 });
      await expect(
        inRecording(p, 1, (cap) =>
          sql`select evidence.require_recording_audits(${p.universeId}::uuid,${audit.privacy_epoch},${audit.exposure_id}::uuid,${audit.recording_generation},null,${audit.id}::uuid)`.execute(
            transactionOf(cap.personal),
          ),
        ),
      ).resolves.toMatchObject({ kind: 'entered' });
      await expect(
        inRecording(p, 1, (cap) =>
          sql`select evidence.require_recording_audits(${p.universeId}::uuid,${audit.privacy_epoch},${audit.exposure_id}::uuid,3,null,${audit.id}::uuid)`.execute(
            transactionOf(cap.personal),
          ),
        ),
      ).rejects.toThrow('recording_activity_identity');

      await expect(
        database.db
          .updateTable('experience.recording_channel_certificates')
          .set({ initialized_at: new Date(0) })
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).rejects.toThrow('recording_channel_certificate_immutable');

      expect(
        await database.db
          .selectFrom('personal_context.recording_exposure_contributions')
          .select('exposure_id')
          .where('universe_id', '=', p.universeId)
          .where('qualified', '=', true)
          .execute(),
      ).toEqual([]);
      expect(
        (
          await database.db
            .selectFrom('evidence.recording_exposure_credit')
            .select('last_effective')
            .where('universe_id', '=', p.universeId)
            .executeTakeFirstOrThrow()
        ).last_effective,
      ).toMatchObject({ qualified: false, measured: false, channels: { B: true, q: null } });

      const sealed = await database.db
        .selectFrom('evidence.recording_segment_heads')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .where('recording_generation', '=', 1)
        .execute();
      expect(await policy(p, 1, false)).toMatchObject({ kind: 'ok' });
      expect(
        await c.applyEncounterAction(p.authority, {
          commandId: randomUUID(),
          kind: 'unsave',
          target,
          recordingGeneration: 2,
        }),
      ).toMatchObject({ kind: 'applied', outcome: { changed: true } });
      const oldCert = await certificates(p);
      expect(await policy(p, 2, true)).toMatchObject({ kind: 'ok' });
      expect(await c.applyEncounterAction(p.authority, save)).toMatchObject({
        kind: 'applied',
        outcome: { replayed: true },
      });
      expect(await certificates(p)).toEqual(oldCert);
      const moved = await c.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target,
        exposureId: ids[1]!,
        recordingGeneration: 3,
      });
      expect(moved).toMatchObject({ kind: 'applied', outcome: { changed: true } });
      const credit = await database.db
        .selectFrom('evidence.recording_exposure_credit')
        .select(['exposure_id', 'last_effective'])
        .where('universe_id', '=', p.universeId)
        .execute();
      expect(credit).toHaveLength(2);
      expect(credit.find((x) => x.exposure_id === ids[0])?.last_effective).toMatchObject({ channels: { B: false } });
      expect(credit.find((x) => x.exposure_id === ids[1])?.last_effective).toMatchObject({ channels: { B: true } });
      expect(
        await database.db
          .selectFrom('evidence.recording_segment_heads')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .where('recording_generation', '=', 1)
          .execute(),
      ).toEqual(sealed);
      await policy(p, 3, false);
      expect(
        await c.applyEncounterAction(p.authority, {
          commandId: randomUUID(),
          kind: 'unsave',
          target,
          recordingGeneration: 4,
        }),
      ).toMatchObject({ kind: 'applied', outcome: { changed: true } });
      await policy(p, 4, true);
      const beforeNegative = await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow();
      expect(
        await c.applyEncounterAction(p.authority, {
          commandId: randomUUID(),
          kind: 'unsave',
          target,
          recordingGeneration: 5,
        }),
      ).toMatchObject({ kind: 'applied', outcome: { changed: false, revision: beforeNegative.revision + 1 } });
      expect(
        await database.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revision: beforeNegative.revision + 1 });
      expect(
        (
          await database.db
            .selectFrom('evidence.recording_exposure_credit')
            .select('last_effective')
            .where('universe_id', '=', p.universeId)
            .execute()
        ).every((x) => (x.last_effective as { channels: { B: boolean } }).channels.B === false),
      ).toBe(true);
    } finally {
      await c.close();
    }
  });
  it('keeps a paused Save across Clear without resurrecting credit or inventing false', async () => {
    const p = await born(),
      c = await scrollUseCases(database, { recording: true });
    try {
      const { asset, ids } = await twoExposures(c, p),
        target = { assetId: asset.assetId, assetRevision: asset.revision };
      await policy(p, 1, false);
      expect(
        await c.applyEncounterAction(p.authority, {
          commandId: randomUUID(),
          kind: 'save',
          target,
          exposureId: ids[0]!,
          recordingGeneration: 2,
        }),
      ).toMatchObject({ kind: 'applied' });
      expect(await certificates(p)).toEqual([]);
      const operation = await clear(p);
      expect(operation.core_done_at).not.toBeNull();
      expect(await witnesses(p)).toMatchObject([
        { privacy_epoch: 2, origin_kind: 'clear_core', clear_operation_id: operation.id },
      ]);
      const fresh = { ...p, authority: { ...p.authority, privacyEpoch: 2 } };
      await policy(fresh, 2, true);
      const beforeNoop = await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow();
      const noop = await c.applyAction(fresh.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target,
        recordingGeneration: 3,
      });
      expect(noop).toMatchObject({ kind: 'applied', outcome: { changed: false } });
      if (noop.kind !== 'applied') throw new Error('CI necessary Save no-op');
      expect(
        await database.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow(),
      ).toEqual(beforeNoop);
      expect(await certificates(p)).toMatchObject([
        {
          channel: 'saved',
          initialized_generation: 3,
          initializing_action_id: noop.outcome.actionId,
          first_decision_action_id: null,
        },
      ]);
      expect(
        await database.db
          .selectFrom('experience.action_state')
          .select('recording_saved_state')
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([{ recording_saved_state: null }]);
      expect(
        await database.db
          .selectFrom('evidence.recording_exposure_credit')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
      expect(
        await database.db
          .selectFrom('experience.saved_items')
          .select('asset_id')
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([{ asset_id: asset.assetId }]);
    } finally {
      await c.close();
    }
  });
  it('certifies current core before unknown financial completion, without resetting or resending the liability', async () => {
    const p = await born(),
      ledger = makeAttemptLedger(database.db),
      runId = randomUUID(),
      attemptId = randomUUID();
    const bytes = new TextEncoder().encode('{"fixture":"fresh-clear-unknown"}');
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
      await ledger.admitRun(scope, {
        id: runId,
        ownerModule: 'fixture',
        purpose: 'fresh-clear',
        roleId: 'fixture.clear',
        roleVersion: 'v1',
        policyVersion: 'v1',
        provider: 'fixture',
        model: 'fixture',
        contextBundleRef: 'fixture.fresh',
        contextRefs: ['fixture'],
      });
      await ledger.reserve(scope, {
        id: attemptId,
        runId,
        step: 'primary',
        provider: 'fixture',
        model: 'fixture',
        roleId: 'fixture.clear',
        roleVersion: 'v1',
        promptVersion: 'fixture',
        requestHash: createHash('sha256').update(bytes).digest('hex'),
        requestBody: bytes,
        maxOutputTokens: 16,
        reservedTokens: 37,
        requestRetentionSeconds: 3600,
      });
      await ledger.commitDispatch(scope, attemptId, {
        dispatchId: randomUUID(),
        dispatchedBy: 'ci-fixture',
        quota: { verdict: 'not_applicable', intervalRemainingPercent: null, weeklyRemainingPercent: null },
      });
    });
    const before = await database.db
      .selectFrom('reasoning.external_attempts')
      .select(['id', 'state', 'reserved_tokens'])
      .where('id', '=', attemptId)
      .executeTakeFirstOrThrow();
    const operation = await clear(p);
    expect(operation.core_done_at).not.toBeNull();
    expect(operation.completed_at).toBeNull();
    expect(await witnesses(p)).toMatchObject([{ privacy_epoch: 2, origin_kind: 'clear_core' }]);
    expect(
      await database.db
        .selectFrom('reasoning.external_attempts')
        .select(['id', 'state', 'reserved_tokens'])
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      await database.db
        .selectFrom('identity.universes')
        .select('clear_operation_id')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ clear_operation_id: null });
  });
  it('refuses generic lookalike callbacks as freshness proof and never recertifies after full erasure', async () => {
    const legacy = await seedPerson(database.db);
    const fake = clearExplorationRegistry(
      explorationStores.map((d) => ({
        ...d,
        clearExploration: {
          dispositions: { ...d.clearExploration!.dispositions },
          erase: () => Promise.resolve({ module: d.module, status: 'completed' as const, removed: 0 }),
        },
      })),
      personalStores,
      () => Promise.resolve(true),
    );
    await expect(
      clear(legacy, async (scope) => {
        await eraseExploration(scope, fake);
      }),
    ).rejects.toThrow('CLEAR_CURRENT_REGISTRY_UNVERIFIED');
    expect(
      (
        await database.db
          .selectFrom('identity.clear_operations')
          .select('core_done_at')
          .where('scope_id', '=', legacy.universeId)
          .executeTakeFirstOrThrow()
      ).core_done_at,
    ).toBeNull();
    expect(await witnesses(legacy)).toEqual([]);
    const p = await born();
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
      eraseUniverse(scope, personalStores),
    );
    expect(await witnesses(p)).toEqual([]);
    expect(await inRecording(p, 1, readRecordingLifecycle)).toMatchObject({ value: { kind: 'not_ready' } });
    expect(await certificates(p)).toEqual([]);
    const c = await scrollUseCases(database, { recording: true });
    try {
      const asset = await admitStarter(c.importScroll),
        activationCommandId = randomUUID(),
        saveCommandId = randomUUID();
      const open = await c.openExposure(p.authority, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: asset.assetId },
        origin: { kind: 'direct' },
        capabilities: textCapabilities,
      });
      if (open.kind !== 'opened') throw new Error('CI necessary open after erasure');
      expect(
        await c.activateExposure(p.authority, {
          commandId: activationCommandId,
          exposureId: open.outcome.exposureId,
          recordingGeneration: 1,
        }),
      ).toMatchObject({ kind: 'activated' });
      expect(
        await c.applyEncounterAction(p.authority, {
          commandId: saveCommandId,
          kind: 'save',
          target: { assetId: asset.assetId, assetRevision: asset.revision },
          exposureId: open.outcome.exposureId,
          recordingGeneration: 1,
        }),
      ).toMatchObject({ kind: 'applied', outcome: { saved: true, changed: true } });
      expect(
        await database.db
          .selectFrom('experience.recording_command_origins')
          .select(['original_generation', 'eligible_generation'])
          .where('universe_id', '=', p.universeId)
          .where('command_id', 'in', [activationCommandId, saveCommandId])
          .execute(),
      ).toEqual([
        { original_generation: 1, eligible_generation: null },
        { original_generation: 1, eligible_generation: null },
      ]);
      expect(
        await database.db
          .selectFrom('evidence.recording_sessions')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
      expect(
        await database.db
          .selectFrom('experience.recording_segments')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([]);
      expect(await certificates(p)).toEqual([]);
      expect(await witnesses(p)).toEqual([]);
    } finally {
      await c.close();
    }
    await expect(
      sql`insert into identity.recording_lifecycle_witnesses values(${p.universeId}::uuid,1,${p.accountId}::uuid,1,'birth',null,
      ${RECORDING_LIFECYCLE_PROTOCOL_SHA256},transaction_timestamp())`.execute(database.db),
    ).rejects.toThrow('recording_lifecycle_birth_only');
  });
  it('does not reinterpret epoch-only invalidation as completed Clear or birth', async () => {
    const p = await born();
    expect(
      await accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).invalidateOwnAccountAccess(
        p.authority,
        'advance_epoch',
      ),
    ).toMatchObject({ kind: 'invalidated', privacyEpoch: 2 });
    const current = { ...p, authority: { ...p.authority, privacyEpoch: 2 } };
    expect(await inRecording(current, 1, readRecordingLifecycle)).toMatchObject({ value: { kind: 'not_ready' } });
    expect(await witnesses(p)).toMatchObject([{ privacy_epoch: 1, origin_kind: 'birth' }]);
    expect(await certificates(p)).toEqual([]);
    expect(
      await database.db
        .selectFrom('identity.clear_operations')
        .selectAll()
        .where('scope_id', '=', p.universeId)
        .execute(),
    ).toEqual([]);
  });
  it('does not mint readiness from an old completed Clear receipt after actual full erasure', async () => {
    const p = await born(),
      op = await clear(p);
    expect(op.core_done_at).not.toBeNull();
    expect(op.completed_at).not.toBeNull();
    const current = { ...p, authority: { ...p.authority, privacyEpoch: 2 } };
    await makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(current.authority, (scope) =>
      eraseUniverse(scope, personalStores),
    );
    expect(await witnesses(p)).toEqual([]);
    await expect(
      sql`insert into identity.recording_lifecycle_witnesses values(${p.universeId}::uuid,2,${p.accountId}::uuid,1,'clear_core',${op.id}::uuid,
      ${RECORDING_LIFECYCLE_PROTOCOL_SHA256},transaction_timestamp())`.execute(database.db),
    ).rejects.toThrow('recording_lifecycle_clear_core');
    expect(await inRecording(current, 1, readRecordingLifecycle)).toMatchObject({ value: { kind: 'not_ready' } });
  });
});
