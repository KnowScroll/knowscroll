import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeWithPersonalScope,
  recordingTransactionOf,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  READ_RECORDING_LIFECYCLE,
  FENCE_OWN_ACCOUNT,
  type RecordingScopeTx,
} from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  operatorSignInUseCase,
  recordingPolicyFor,
  readRecordingLifecycle,
} from '@knowscroll/backend/modules/identity/nest-providers';
import {
  type ActivateExposure,
  type ApplyActionCommand,
  type ExperienceRecordingEffects,
  type ApplyEncounterAction,
} from '@knowscroll/backend/modules/experience';
import {
  keepRemovalUseCase,
  ACTIVATE_EXPOSURE,
  APPLY_ENCOUNTER_ACTION,
  experienceProviders,
} from '@knowscroll/backend/modules/experience/nest-providers';
import { CHECK_ASSET_AUDIENCE } from '@knowscroll/backend/modules/content';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { openToEveryone } from '../support/audience.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';
import { experienceUseCases } from '../support/experience.js';
import { admitStarter, scrollUseCases, textCapabilities } from '../support/scroll.js';
import { buildFromProviders } from '../support/providers.js';
import { gate } from '../support/fixture-model.js';

/** Hosted disposable-PG producer/required-port fixtures. This is not installed Pause or
 * acceptance of an Evidence/PC consumer; a failing required effect is never replaced by a no-op. */
describe('Experience recording provenance and authority (Actions only)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recording_experience');
  });
  afterEach(async () => {
    await database.drop();
  });

  it('rechecks an account after its UPDATE wait before replaying a completed necessary receipt', async () => {
    const p = await seedPerson(database.db),
      asset = await seedAsset(database.db),
      c = await experienceUseCases(database);
    const command = {
      commandId: randomUUID(),
      kind: 'save' as const,
      target: { assetId: asset.assetId, assetRevision: 1 },
    };
    const locked = gate(),
      release = gate();
    let holderPid = 0;
    let pending: ReturnType<typeof c.applyAction> | undefined;
    let holding: Promise<void> | undefined;
    try {
      expect(await c.applyAction(p.authority, command)).toMatchObject({ kind: 'applied' });
      holding = database.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('identity.accounts')
          .select('id')
          .where('id', '=', p.accountId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        holderPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
        locked.open();
        await release.promise;
        await trx.updateTable('identity.accounts').set({ status: 'suspended' }).where('id', '=', p.accountId).execute();
      });
      await locked.promise;
      pending = c.applyAction(p.authority, command);
      let waited = false;
      for (let i = 0; i < 200; i++) {
        const r = await sql<{
          blocked: boolean;
        }>`select exists(select 1 from pg_stat_activity a where ${holderPid}=any(pg_blocking_pids(a.pid))) as blocked`.execute(
          database.db,
        );
        if (r.rows[0]?.blocked) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waited).toBe(true);
      release.open();
      await holding;
      expect(await pending).toEqual({ kind: 'refused', reason: 'universe_unavailable' });
      const rows = await database.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute();
      expect(rows).toHaveLength(1);
      const origins = await sql<{
        n: number;
      }>`select count(*)::int as n from experience.recording_command_origins where universe_id=${p.universeId}::uuid`.execute(
        database.db,
      );
      expect(origins.rows[0]?.n).toBe(1);
    } finally {
      release.open();
      await Promise.allSettled([...(holding ? [holding] : []), ...(pending ? [pending] : [])]);
      await c.close();
    }
  });

  it('rechecks an epoch after a root wait and never reaches the old receipt as a fresh command', async () => {
    const p = await seedPerson(database.db),
      asset = await seedAsset(database.db),
      c = await experienceUseCases(database);
    const command = {
      commandId: randomUUID(),
      kind: 'save' as const,
      target: { assetId: asset.assetId, assetRevision: 1 },
    };
    const held = gate(),
      release = gate();
    let holderPid = 0;
    let pending: ReturnType<typeof c.applyAction> | undefined;
    const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount;
    let holding: ReturnType<ReturnType<typeof makeWithPersonalScope>> | undefined;
    try {
      expect(await c.applyAction(p.authority, command)).toMatchObject({ kind: 'applied' });
      holding = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })(p.authority, async (scope) => {
        if ((await own(scope)).kind !== 'active') throw new Error('CI gate');
        holderPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transactionOf(scope))).rows[0]!
          .pid;
        held.open();
        await release.promise;
        await transactionOf(scope)
          .updateTable('identity.universes')
          .set({ privacy_epoch: 2 })
          .where('id', '=', p.universeId)
          .execute();
      });
      await held.promise;
      pending = c.applyAction(p.authority, command);
      let waited = false;
      for (let i = 0; i < 200; i++) {
        const r = await sql<{
          blocked: boolean;
        }>`select exists(select 1 from pg_stat_activity a where ${holderPid}=any(pg_blocking_pids(a.pid))) as blocked`.execute(
          database.db,
        );
        if (r.rows[0]?.blocked) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waited).toBe(true);
      release.open();
      await holding;
      expect(await pending).toEqual({ kind: 'refused', reason: 'epoch_changed' });
      const rows = await database.db
        .selectFrom('receipts.personal_commands')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute();
      expect(rows).toHaveLength(1);
    } finally {
      release.open();
      await Promise.allSettled([...(holding ? [holding] : []), ...(pending ? [pending] : [])]);
      await c.close();
    }
  });

  it('does not downgrade malformed or own undefined generation into legacy omission', async () => {
    const p = await seedPerson(database.db),
      asset = await seedAsset(database.db),
      c = await experienceUseCases(database);
    try {
      const command = {
        commandId: randomUUID(),
        kind: 'save' as const,
        target: { assetId: asset.assetId, assetRevision: 1 },
      };
      for (const value of [undefined, null, '1', 0, 1.5, 2147483648]) {
        const malformed = { ...command, recordingGeneration: value } as unknown as ApplyActionCommand;
        await expect(c.applyAction(p.authority, malformed)).rejects.toThrow('EXPERIENCE_RECORDING_GENERATION_INVALID');
      }
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
          .execute(),
      ).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it('rolls activation/segment/origin/receipt back when a REQUIRED real-transaction consumer fails', async () => {
    const c = await scrollUseCases(database),
      p = await seedPerson(database.db);
    try {
      const asset = await admitStarter(c.importScroll);
      const opened = await c.openExposure(p.authority, {
        commandId: randomUUID(),
        target: { kind: 'scroll', assetId: asset.assetId },
        origin: { kind: 'direct' },
        capabilities: textCapabilities,
      });
      if (opened.kind !== 'opened') throw new Error('CI open');
      const id = opened.outcome.exposureId;
      const fail = () => Promise.reject(new Error('CI_required_effect_failure'));
      const effects: ExperienceRecordingEffects = {
        applyChannels: fail,
        enqueueActivity: fail,
        enqueueActionEvidence: fail,
        async startSession(scope: RecordingScopeTx, session) {
          expect(scope.generation).toBe(1);
          expect(session.exposureId).toBe(id);
          // A copied capability fails; the genuine capability names the same actual SQL transaction.
          expect(() => recordingTransactionOf({ ...scope })).toThrow();
          const row = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(recordingTransactionOf(scope));
          expect(row.rows[0]?.pid).toBeGreaterThan(0);
          throw new Error('CI_required_effect_failure');
        },
      };
      const DB = Symbol('db'),
        SCOPE = Symbol('scope'),
        ENQUEUE = Symbol('enqueue'),
        EFFECTS = Symbol('effects');
      const values = new Map<symbol, unknown>([
        [DB, database.db],
        [CHECK_ASSET_AUDIENCE, openToEveryone],
        [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
        [READ_RECORDING_LIFECYCLE, readRecordingLifecycle],
        [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount],
        [ENQUEUE, makeEnqueueJob(c.boss)],
        [EFFECTS, effects],
        ...contentProviders().map((provider) => [provider.provide, provider.useValue] as const),
      ]);
      const providers = experienceProviders(
        { database: DB, withPersonalScope: SCOPE, enqueueJob: ENQUEUE },
        { recordingEffects: EFFECTS },
      );
      const activate = buildFromProviders(providers, ACTIVATE_EXPOSURE, values) as ActivateExposure;
      const commandId = randomUUID();
      await expect(activate(p.authority, { commandId, exposureId: id, recordingGeneration: 1 })).rejects.toThrow(
        'CI_required_effect_failure',
      );
      const x = await database.db
        .selectFrom('experience.exposures')
        .select('activated_at')
        .where('universe_id', '=', p.universeId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(x.activated_at).toBeNull();
      expect(
        await database.db
          .selectFrom('receipts.personal_commands')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .where('command_id', '=', commandId)
          .execute(),
      ).toEqual([]);
      const rows = await sql<{
        n: number;
      }>`select count(*)::int as n from experience.recording_segments where universe_id=${p.universeId}::uuid`.execute(
        database.db,
      );
      expect(rows.rows[0]?.n).toBe(0);
      const origins = await sql<{
        n: number;
      }>`select count(*)::int as n from experience.recording_command_origins where universe_id=${p.universeId}::uuid and command_id=${commandId}::uuid`.execute(
        database.db,
      );
      expect(origins.rows[0]?.n).toBe(0);
    } finally {
      await c.close();
    }
  });
  it('hands exact reversible old/new origins to one required consumer and rolls both back on its failure', async () => {
    const c = await scrollUseCases(database, { recording: true });
    const born = await operatorSignInUseCase({
      db: database.db,
      publicOrigin: 'https://ci.invalid',
      lockTimeoutMs: 5000,
      pattern: '*@fresh.test',
      world: 'ci',
      operatorSource: 'cli:ci-fresh-lifecycle',
    })({ email: `${randomUUID()}@fresh.test` });
    if (born.kind !== 'issued') throw new Error('CI real birth');
    const p = {
      ...born.outcome,
      authority: {
        universeId: born.outcome.universeId,
        privacyEpoch: 1,
        actor: { kind: 'account' as const, accountId: born.outcome.accountId },
      },
    };
    const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount;
    try {
      const asset = await admitStarter(c.importScroll),
        target = { assetId: asset.assetId, assetRevision: asset.revision };
      const exposures: { id: string; activationCommandId: string }[] = [];
      for (let n = 0; n < 2; n++) {
        const opened = await c.openExposure(p.authority, {
          commandId: randomUUID(),
          target: { kind: 'scroll', assetId: asset.assetId },
          origin: { kind: 'direct' },
          capabilities: textCapabilities,
        });
        if (opened.kind !== 'opened') throw new Error('CI open');
        const activationCommandId = randomUUID();
        expect(
          await c.activateExposure(p.authority, {
            commandId: activationCommandId,
            exposureId: opened.outcome.exposureId,
          }),
        ).toMatchObject({ kind: 'activated' });
        exposures.push({ id: opened.outcome.exposureId, activationCommandId });
      }
      const old = exposures[0]!,
        next = exposures[1]!;
      const saved = await c.applyEncounterAction(p.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target,
        exposureId: old.id,
      });
      if (saved.kind !== 'applied') throw new Error('CI save');
      const sourceActionId = saved.outcome.actionId;
      await c.projectActivity({ v: 1, universeId: p.universeId, privacyEpoch: 1, exposureId: old.id });
      const audit = await database.db
        .selectFrom('evidence.activity_revisions')
        .selectAll()
        .where('universe_id', '=', p.universeId)
        .execute();
      // The actual createAccount birth + real required recording consumer initialized the
      // channel certificate/pointer above. No synthetic certification, false decision or seed.
      expect(
        await database.db
          .selectFrom('experience.recording_channel_certificates')
          .select('first_decision_action_id')
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual([{ first_decision_action_id: sourceActionId }]);
      await sql`update identity.universes set recording_on=false,recording_generation=2 where id=${p.universeId}::uuid`.execute(
        database.db,
      );
      expect(
        await c.applyEncounterAction(p.authority, {
          commandId: randomUUID(),
          kind: 'unsave',
          target,
          recordingGeneration: 2,
        }),
      ).toMatchObject({ kind: 'applied', outcome: { changed: true } });
      await sql`update identity.universes set recording_on=true,recording_generation=3 where id=${p.universeId}::uuid`.execute(
        database.db,
      );
      const before = await database.db
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', p.universeId)
        .executeTakeFirstOrThrow();
      let expectedCount = 2,
        calls = 0;
      const fail = () => Promise.reject(new Error('CI_unexpected_required_effect'));
      const effects: ExperienceRecordingEffects = {
        startSession: fail,
        enqueueActivity: fail,
        enqueueActionEvidence: fail,
        async applyChannels(cap, change) {
          calls++;
          expect(cap.generation).toBe(3);
          expect(change.changes).toHaveLength(expectedCount);
          const pointer = await sql<{
            state: boolean;
            origin: string | null;
            revision: number;
          }>`select recording_saved_state as state,recording_saved_origin_exposure_id as origin,recording_channel_revision as revision from experience.action_state where universe_id=${p.universeId}::uuid and asset_id=${asset.assetId}::uuid`.execute(
            recordingTransactionOf(cap),
          );
          expect(pointer.rows).toEqual([
            {
              state: expectedCount === 2,
              origin: expectedCount === 2 ? next.id : null,
              revision: change.pointerRevision,
            },
          ]);

          expect(change.changes[0]).toEqual({
            exposureId: old.id,
            value: false,
            originActionId: sourceActionId,
            originGeneration: 1,
          });
          if (expectedCount === 2)
            expect(change.changes[1]).toMatchObject({ exposureId: next.id, value: true, originGeneration: 3 });
          const rows = await sql<{
            exposure_id: string;
            saved_override: boolean;
            first_eligible_activation_at: Date | null;
          }>`select i.exposure_id,i.saved_override,s.first_eligible_activation_at from experience.recording_segment_inputs i join experience.recording_segments s on s.universe_id=i.universe_id and s.exposure_id=i.exposure_id and s.recording_generation=i.recording_generation where i.universe_id=${p.universeId}::uuid and i.recording_generation=3 order by i.exposure_id`.execute(
            recordingTransactionOf(cap),
          );
          expect(rows.rows).toHaveLength(expectedCount);
          expect(rows.rows.every((x) => x.first_eligible_activation_at === null)).toBe(true);
          expect(rows.rows.find((x) => x.exposure_id === old.id)?.saved_override).toBe(false);
          if (expectedCount === 2) expect(rows.rows.find((x) => x.exposure_id === next.id)?.saved_override).toBe(true);
          throw new Error('CI_after_both_overrides');
        },
      };
      const DB = Symbol('db'),
        SCOPE = Symbol('scope'),
        ENQUEUE = Symbol('enqueue'),
        EFFECTS = Symbol('effects');
      const values = new Map<symbol, unknown>([
        [DB, database.db],
        [CHECK_ASSET_AUDIENCE, openToEveryone],
        [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 })],
        [READ_RECORDING_LIFECYCLE, readRecordingLifecycle],
        [FENCE_OWN_ACCOUNT, own],
        [ENQUEUE, makeEnqueueJob(c.boss)],
        [EFFECTS, effects],
        ...contentProviders().map((x) => [x.provide, x.useValue] as const),
      ]);
      const providers = experienceProviders(
        { database: DB, withPersonalScope: SCOPE, enqueueJob: ENQUEUE },
        { recordingEffects: EFFECTS },
      );
      const apply = buildFromProviders(providers, APPLY_ENCOUNTER_ACTION, values) as ApplyEncounterAction;
      for (const kind of ['save', 'unsave'] as const) {
        const commandId = randomUUID();
        await expect(
          apply(p.authority, {
            commandId,
            kind,
            target,
            recordingGeneration: 3,
            ...(kind === 'save' ? { exposureId: next.id } : {}),
          }),
        ).rejects.toThrow('CI_after_both_overrides');
        expect(
          await database.db
            .selectFrom('receipts.personal_commands')
            .selectAll()
            .where('universe_id', '=', p.universeId)
            .where('command_id', '=', commandId)
            .execute(),
        ).toEqual([]);
        const current = await sql<{
          recording_saved_state: boolean;
          recording_saved_origin_exposure_id: string;
        }>`select recording_saved_state,recording_saved_origin_exposure_id from experience.action_state where universe_id=${p.universeId}::uuid and asset_id=${asset.assetId}::uuid`.execute(
          database.db,
        );
        expect(current.rows[0]).toMatchObject({
          recording_saved_state: true,
          recording_saved_origin_exposure_id: old.id,
        });
        expect(
          await database.db
            .selectFrom('experience.saved_items')
            .selectAll()
            .where('universe_id', '=', p.universeId)
            .execute(),
        ).toEqual([]);
        expect(
          await database.db
            .selectFrom('identity.universes')
            .select('revision')
            .where('id', '=', p.universeId)
            .executeTakeFirstOrThrow(),
        ).toEqual(before);
        expectedCount = 1;
      }
      expect(calls).toBe(2);
      expect(
        await database.db
          .selectFrom('evidence.activity_revisions')
          .selectAll()
          .where('universe_id', '=', p.universeId)
          .execute(),
      ).toEqual(audit);
      const overlays = await sql<{
        n: number;
      }>`select count(*)::int as n from experience.recording_segment_inputs where universe_id=${p.universeId}::uuid and recording_generation=3`.execute(
        database.db,
      );
      expect(overlays.rows[0]?.n).toBe(0);
    } finally {
      await c.close();
    }
  });
  it('forwards only the original Keep removal generation through real effects, retaining private ACK and necessary removal', async () => {
    const c = await scrollUseCases(database, { recording: true });
    try {
      if (!c.recordingEffects) throw new Error('CI actual recording graph required');
      const asset = await admitStarter(c.importScroll),
        target = { assetId: asset.assetId, assetRevision: asset.revision };
      for (const mode of ['absent', 'undefined', 'stale', 'paused', 'current'] as const) {
        const born = await operatorSignInUseCase({
          db: database.db,
          publicOrigin: 'https://ci.invalid',
          lockTimeoutMs: 5000,
          pattern: '*@keep-fresh.test',
          world: 'ci',
          operatorSource: 'cli:ci-keep-recording',
        })({ email: `${randomUUID()}@keep-fresh.test` });
        if (born.kind !== 'issued') throw new Error('CI actual account birth');
        const p = {
          ...born.outcome,
          authority: {
            universeId: born.outcome.universeId,
            privacyEpoch: 1,
            actor: { kind: 'account' as const, accountId: born.outcome.accountId },
          },
        };
        const opened = await c.openExposure(p.authority, {
          commandId: randomUUID(),
          target: { kind: 'scroll', assetId: asset.assetId },
          origin: { kind: 'direct' },
          capabilities: textCapabilities,
        });
        if (opened.kind !== 'opened') throw new Error('CI actual open');
        await c.activateExposure(p.authority, {
          commandId: randomUUID(),
          exposureId: opened.outcome.exposureId,
          recordingGeneration: 1,
        });
        expect(
          await c.applyEncounterAction(p.authority, {
            commandId: randomUUID(),
            kind: 'save',
            target,
            exposureId: opened.outcome.exposureId,
            recordingGeneration: 1,
          }),
        ).toMatchObject({ kind: 'applied', outcome: { changed: true } });
        const saved = await database.db
          .selectFrom('experience.saved_items')
          .select('saved_entry_id')
          .where('universe_id', '=', p.universeId)
          .where('asset_id', '=', asset.assetId)
          .executeTakeFirstOrThrow();
        const set = (g: number, on: boolean) =>
          recordingPolicyFor(database.db, { lockTimeoutMs: 5000 }).set(p.authority, {
            version: 'recording-policy.v1',
            commandId: randomUUID(),
            expectedPrivacyEpoch: 1,
            expectedRecordingGeneration: g,
            on,
          });
        if (mode !== 'undefined') {
          await set(1, false);
          if (mode !== 'paused') await set(2, true);
        }
        const own = accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 });
        const remove = keepRemovalUseCase({
          withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 }),
          fenceOwn: own.fenceOwnAccount,
          lifecycle: own.readRecordingLifecycle,
          enqueue: makeEnqueueJob(c.boss),
          recordingEffects: c.recordingEffects,
        });
        const command = {
          version: 'keep-remove.v1',
          commandId: randomUUID(),
          entry: { ...target, savedEntryId: saved.saved_entry_id },
          ...(mode === 'absent'
            ? {}
            : {
                recordingGeneration:
                  mode === 'undefined' ? undefined : mode === 'stale' ? 1 : mode === 'paused' ? 2 : 3,
              }),
        };
        const before = await database.db
          .selectFrom('identity.universes')
          .select('revision')
          .where('id', '=', p.universeId)
          .executeTakeFirstOrThrow();
        const result = await remove(p.authority, command);
        if (mode === 'undefined') {
          expect(result).toEqual({ kind: 'refused', code: 'INVALID_REQUEST' });
          expect(
            await database.db
              .selectFrom('experience.saved_items')
              .select('saved_entry_id')
              .where('universe_id', '=', p.universeId)
              .execute(),
          ).toEqual([{ saved_entry_id: saved.saved_entry_id }]);
          expect(
            await database.db
              .selectFrom('experience.recording_command_origins')
              .selectAll()
              .where('universe_id', '=', p.universeId)
              .where('command_id', '=', command.commandId)
              .execute(),
          ).toEqual([]);
          continue;
        }
        expect(result).toMatchObject({
          kind: 'ok',
          value: { commandId: command.commandId, entry: command.entry, outcome: 'accepted' },
        });
        if (result.kind !== 'ok') throw new Error('CI actual Keep removal');
        expect(Object.keys(result.value).sort()).toEqual([
          'commandId',
          'entry',
          'operation',
          'outcome',
          'recordedAt',
          'replayed',
          'scope',
          'version',
        ]);
        expect(await remove(p.authority, command)).toEqual({ kind: 'ok', value: { ...result.value, replayed: true } });
        expect(
          await database.db
            .selectFrom('experience.saved_items')
            .selectAll()
            .where('universe_id', '=', p.universeId)
            .execute(),
        ).toEqual([]);
        expect(
          await database.db
            .selectFrom('experience.recording_command_origins')
            .select(['original_generation', 'eligible_generation'])
            .where('universe_id', '=', p.universeId)
            .where('command_id', '=', command.commandId)
            .execute(),
        ).toEqual([
          {
            original_generation: mode === 'absent' ? null : mode === 'stale' ? 1 : mode === 'paused' ? 2 : 3,
            eligible_generation: mode === 'current' ? 3 : null,
          },
        ]);
        const credit = await database.db
          .selectFrom('evidence.recording_exposure_credit')
          .select('last_effective')
          .where('universe_id', '=', p.universeId)
          .executeTakeFirstOrThrow();
        expect(credit.last_effective).toMatchObject({ channels: { B: mode !== 'current' } });
        expect(
          await database.db
            .selectFrom('identity.universes')
            .select('revision')
            .where('id', '=', p.universeId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ revision: before.revision + 1 });
      }
    } finally {
      await c.close();
    }
  });
});
