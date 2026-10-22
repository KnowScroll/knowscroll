import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  makeWithPersonalScope,
  fencePersonalRecording,
  recordingTransactionOf,
  ScopeClosedError,
  transactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  recordingPolicyFor,
  makeRecordingPolicy,
  recordingStore,
  accountAccessUseCases,
} from '@knowscroll/backend/modules/identity/nest-providers';
import type { RecordingScopeTx } from '@knowscroll/backend/modules/identity';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { requestHash } from '@knowscroll/backend/infrastructure/receipts';
import { gate } from '../support/fixture-model.js';
/** Synthetic current-root capability fixtures. No API/control/worker activation. */
describe('opt-in original recording-generation capability', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('recording_scope');
  });
  afterEach(async () => {
    await database.drop();
  });
  it('admits initial legacy and exact current, refuses stale after resume, expires/copy-fences capabilities', async () => {
    const p = await seedPerson(database.db),
      withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    let saved!: RecordingScopeTx;
    await withScope(p.authority, async (s) => {
      for (const original of [undefined, 1]) {
        const r = await fencePersonalRecording(s, original);
        expect(r.kind).toBe('recording');
        if (r.kind !== 'recording') throw new Error('Fixture gate');
        saved = r.scope;
        expect(recordingTransactionOf(saved)).toBe(transactionOf(s));
        expect(() => recordingTransactionOf({ ...saved })).toThrow(ScopeClosedError);
      }
    });
    expect(() => recordingTransactionOf(saved)).toThrow(ScopeClosedError);
    const cases = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    const set = (generation: number, on: boolean) =>
      cases.set(p.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration: generation,
        on,
      });
    await set(1, false);
    await withScope(p.authority, async (s) => {
      expect(await fencePersonalRecording(s, 1)).toEqual({ kind: 'paused', currentGeneration: 2 });
      expect(await fencePersonalRecording(s, undefined)).toEqual({ kind: 'generation_required' });
    });
    await set(2, true);
    await withScope(p.authority, async (s) => {
      expect(await fencePersonalRecording(s, undefined)).toEqual({ kind: 'generation_required' });
      expect(await fencePersonalRecording(s, 1)).toEqual({ kind: 'stale', currentGeneration: 3 });
      expect((await fencePersonalRecording(s, 3)).kind).toBe('recording');
      for (const bad of [0, -1, 3.5, Infinity, NaN, 2147483648])
        expect((await fencePersonalRecording(s, bad)).kind).toBe('stale');
    });
  });
  it('rechecks the original generation after a deterministic root wait behind an actual pause command', async () => {
    const p = await seedPerson(database.db),
      held = gate(),
      release = gate();
    let holderPid = 0;
    const pause = makeRecordingPolicy({
      withScope: makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 }),
      fenceOwn: accountAccessUseCases({ db: database.db, lockTimeoutMs: 5000 }).fenceOwnAccount,
      store: {
        ...recordingStore,
        async accept(...args) {
          await recordingStore.accept(...args);
          holderPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transactionOf(args[0])))
            .rows[0]!.pid;
          held.open();
          await release.promise;
        },
      },
      hash: (q) => requestHash('privacy.recording-set', q),
      now: () => new Date(),
    });
    const holding = pause.set(p.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: 1,
      on: false,
    });
    const applicationName = `recording-growth-wait-${randomUUID()}`;
    const other = createDatabase<Database>(
      { ...database.settings, applicationName },
      { onIdleClientError: () => undefined },
    );
    let pending: Promise<unknown> | undefined;
    try {
      await held.promise;
      pending = makeWithPersonalScope(other.db, { lockTimeoutMs: 5000 })(
        { ...p.authority, actor: { kind: 'system', purpose: 'fixture-delayed-growth' } },
        (scope) => fencePersonalRecording(scope, 1),
      );
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const r = await sql<{
          blocked: boolean;
        }>`select exists(select 1 from pg_stat_activity a where a.application_name=${applicationName} and ${holderPid}=any(pg_blocking_pids(a.pid))) as blocked`.execute(
          database.db,
        );
        if (r.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      release.open();
      await holding;
      expect(await pending).toEqual({ kind: 'entered', value: { kind: 'paused', currentGeneration: 2 } });
      const resume = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
      await resume.set(p.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration: 2,
        on: true,
      });
      expect(
        await makeWithPersonalScope(other.db, { lockTimeoutMs: 5000 })(p.authority, (scope) =>
          fencePersonalRecording(scope, 1),
        ),
      ).toEqual({ kind: 'entered', value: { kind: 'stale', currentGeneration: 3 } });
    } finally {
      release.open();
      await Promise.allSettled([holding, ...(pending ? [pending] : [])]);
      await other.close();
    }
  });
  it('does not change necessary PersonalScope authority while paused and rejects inactive system-owner admission', async () => {
    const p = await seedPerson(database.db),
      cases = recordingPolicyFor(database.db, { lockTimeoutMs: 5000 });
    await cases.set(p.authority, {
      version: 'recording-policy.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      expectedRecordingGeneration: 1,
      on: false,
    });
    const withScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5000 });
    const necessary = await withScope(p.authority, async (s) => {
      expect(await fencePersonalRecording(s, 2)).toEqual({ kind: 'paused', currentGeneration: 2 });
      return transactionOf(s)
        .selectFrom('identity.universes')
        .select('id')
        .where('id', '=', p.universeId)
        .executeTakeFirst();
    });
    expect(necessary).toMatchObject({ kind: 'entered', value: { id: p.universeId } });
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', p.accountId)
      .execute();
    await withScope({ ...p.authority, actor: { kind: 'system', purpose: 'fixture' } }, async (s) => {
      expect(await fencePersonalRecording(s, 2)).toEqual({ kind: 'unavailable' });
    });
  });
});
