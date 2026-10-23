import { gate } from '../support/fixture-model.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { explorationStores, eraseCurrentExploration } from '@knowscroll/backend/erasure-registry';
import { eraseExploration } from '@knowscroll/backend/infrastructure/erasure';
import { createBoss, applyQueueDeclarations, makeEnqueuePrivacyJob } from '@knowscroll/backend/infrastructure/jobs';
import {
  makeWithPrivacyScope,
  makeWithClearMaintenance,
  privacyTransactionOf,
  clearCoreTransactionOf,
  clearAccountingTransactionOf,
  makeWithPersonalScope,
  makeAuthorityHolds,
  isClearCore,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  clearExplorationQueue,
  type PrivacyScopeTx,
  type ClearCoreTx,
  type ClearAccountingTx,
} from '@knowscroll/backend/modules/identity';
import { clearExplorationFor, clearStore } from '@knowscroll/backend/modules/identity/nest-providers';
import { clearReasoning } from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';

/** CI fixtures, real PostgreSQL and actual pg-boss fromKysely insertion. */
describe('privacy capabilities and barriers', () => {
  let database: TestDatabase<Database>, boss: ReturnType<typeof createBoss>;
  const db = () => database.db;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('privacy_scope');
    boss = createBoss(database.settings, 'install', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    await applyQueueDeclarations(boss, [clearExplorationQueue]);
  });
  afterEach(async () => {
    await boss.stop({ graceful: false });
    await database.drop();
  });
  const maintenance = () => makeWithClearMaintenance(db(), { lockTimeoutMs: 5000 });
  const cases = () =>
    clearExplorationFor(db(), boss, {
      reasoning: clearReasoning,
      eraseCore: async (scope) => {
        await eraseCurrentExploration(scope);
      },
    });
  const input = () => ({
    version: 'clear-exploration.v1',
    commandId: randomUUID(),
    expectedPrivacyEpoch: 1,
    confirmation: 'clear-exploration-preserve-keep-and-social',
  });
  it('refuses forged, copied, wrong-operation and closed capabilities before they can expose a transaction', async () => {
    expect(() => privacyTransactionOf({} as PrivacyScopeTx)).toThrow('Privacy capability unavailable');
    expect(() => clearCoreTransactionOf({} as ClearCoreTx)).toThrow('Clear core capability unavailable');
    expect(() => clearAccountingTransactionOf({} as ClearAccountingTx)).toThrow(
      'Clear accounting capability unavailable',
    );
    const p = await seedPerson(db()),
      authority = { accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 };
    let closed: PrivacyScopeTx | undefined;
    await makeWithPrivacyScope(db(), { lockTimeoutMs: 5000 })(authority, async (scope) => {
      closed = scope;
      expect(Object.isFrozen(scope.authority)).toBe(true);
      expect(() => privacyTransactionOf({ ...scope })).toThrow();
      expect(() => privacyTransactionOf({ ...scope, authority: { ...authority, accountId: randomUUID() } })).toThrow();
      expect(() => clearCoreTransactionOf(scope as unknown as ClearCoreTx)).toThrow();
      await expect(
        makeEnqueuePrivacyJob(boss, clearExplorationQueue)(
          { ...scope },
          { v: 1, accountId: p.accountId, commandId: randomUUID() },
        ),
      ).rejects.toThrow();
    });
    expect(() => privacyTransactionOf(closed!)).toThrow();
  });
  it('blocks normal writes and lock-free output eligibility throughout the durable barrier', async () => {
    const p = await seedPerson(db()),
      body = input();
    await cases().start({ accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 }, body);
    let ran = false;
    expect(
      await makeWithPersonalScope(db(), { lockTimeoutMs: 5000 })({ ...p.authority, privacyEpoch: 2 }, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).toMatchObject({ kind: 'refused' });
    expect(ran).toBe(false);
    expect(await makeAuthorityHolds(db())({ ...p.authority, privacyEpoch: 2 })).toBe(false);
    expect(
      await makeAuthorityHolds(db())({
        ...p.authority,
        privacyEpoch: 2,
        actor: { kind: 'system', purpose: 'fixture' },
      }),
    ).toBe(false);
    await cases().process({ v: 1, accountId: p.accountId, commandId: body.commandId });
    expect(await makeAuthorityHolds(db())({ ...p.authority, privacyEpoch: 2 })).toBe(true);
  });
  it('commits required pg-boss work only with the live privacy transaction and rolls it back on failure', async () => {
    const p = await seedPerson(db()),
      payload = { v: 1 as const, accountId: p.accountId, commandId: randomUUID() };
    await expect(
      makeWithPrivacyScope(db(), { lockTimeoutMs: 5000 })(
        { accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 },
        async (scope) => {
          await clearStore.create(scope, payload.commandId, 'a'.repeat(64), []);
          await makeEnqueuePrivacyJob(boss, clearExplorationQueue)(scope, payload);
          const job = await sql<{
            n: number;
          }>`select count(*)::int n from pgboss.job where name=${clearExplorationQueue.name}`.execute(
            privacyTransactionOf(scope),
          );
          expect(job.rows[0]?.n).toBe(1);
          throw new Error('fixture-rollback');
        },
      ),
    ).rejects.toThrow('fixture-rollback');
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int n from pgboss.job where name=${clearExplorationQueue.name}`.execute(db())
      ).rows[0]?.n,
    ).toBe(0);
  });
  it('makes core_done monotonic and old maintenance accounting-only even during a newer barrier', async () => {
    const p = await seedPerson(db()),
      a = input(),
      authority = { accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 };
    await cases().start(authority, a);
    let expired: ClearCoreTx | undefined;
    await maintenance()(p.accountId, a.commandId, async (scope) => {
      if (!isClearCore(scope)) throw new Error('fixture expected core');
      expired = scope;
      await eraseCurrentExploration(scope);
      await clearStore.coreDone(scope);
      expect(() => clearCoreTransactionOf(scope)).toThrow();
    });
    expect(() => clearCoreTransactionOf(expired!)).toThrow();
    const b = { ...input(), expectedPrivacyEpoch: 2 };
    await cases().start({ ...authority, privacyEpoch: 2 }, b);
    const before = await db()
      .selectFrom('identity.universes')
      .selectAll()
      .where('id', '=', p.universeId)
      .executeTakeFirstOrThrow();
    await maintenance()(p.accountId, a.commandId, async (scope) => {
      expect(isClearCore(scope)).toBe(false);
      expect(() => clearCoreTransactionOf(scope as ClearCoreTx)).toThrow();
      await expect(eraseExploration(scope as ClearCoreTx, explorationStores)).rejects.toThrow();
      expect(() => clearAccountingTransactionOf({ ...scope } as ClearAccountingTx)).toThrow();
    });
    expect(
      await db().selectFrom('identity.universes').selectAll().where('id', '=', p.universeId).executeTakeFirstOrThrow(),
    ).toEqual(before);
    await expect(
      db()
        .updateTable('identity.clear_operations')
        .set({ core_done_at: null })
        .where('command_id', '=', a.commandId)
        .execute(),
    ).rejects.toThrow('clear_core_monotonic');
    await expect(
      db().updateTable('identity.universes').set({ clear_operation_id: null }).where('id', '=', p.universeId).execute(),
    ).rejects.toThrow('clear_barrier_incomplete');
  });
  it('keeps the resolved-scope auth exception confined to Identity composition', () => {
    const root = fileURLToPath(new URL('../../../packages/backend/src/', import.meta.url));
    const uses: string[] = [];
    function scan(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) scan(path);
        else if (
          e.name.endsWith('.ts') &&
          !e.name.endsWith('.test.ts') &&
          /makeWithResolvedPersonalScope/.test(readFileSync(path, 'utf8'))
        )
          uses.push(path.slice(root.length));
      }
    }
    scan(root);
    expect(uses.sort()).toEqual(
      [
        'infrastructure/postgres/index.ts',
        'infrastructure/postgres/personal-scope.ts',
        'modules/identity/adapters/nest-providers.ts',
      ].sort(),
    );
    const source = readFileSync(join(root, 'infrastructure/postgres/personal-scope.ts'), 'utf8');
    expect(source.match(/lockAndRecheck\(trx, authority, true\)/g)).toHaveLength(1);
    expect(source.indexOf('lockAndRecheck(trx, authority, true)')).toBeGreaterThan(
      source.indexOf('export function makeWithResolvedPersonalScope'),
    );
  });
  it('freezes the claimed owner/root/epoch before any lock wait', async () => {
    const p = await seedPerson(db()),
      q = await seedPerson(db()),
      entered = gate(),
      release = gate();
    const held = db()
      .transaction()
      .execute(async (trx) => {
        await trx
          .selectFrom('identity.universes')
          .select('id')
          .where('id', '=', p.universeId)
          .forNoKeyUpdate()
          .execute();
        entered.open();
        await release.promise;
      });
    await entered.promise;
    const claimed = { accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 };
    const waiting = makeWithPrivacyScope(db(), { lockTimeoutMs: 5000 })(claimed, (scope) =>
      Promise.resolve(scope.authority),
    );
    Object.assign(claimed, { accountId: q.accountId, universeId: q.universeId, privacyEpoch: 9 });
    release.open();
    await held;
    expect(await waiting).toEqual({
      kind: 'entered',
      value: { accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 },
    });
  });
  it('rejects cross-operation/account and paid queues before send or SQL side effects', async () => {
    const p = await seedPerson(db()),
      a = input();
    await cases().start({ accountId: p.accountId, universeId: p.universeId, privacyEpoch: 1 }, a);
    await cases().process({ v: 1, accountId: p.accountId, commandId: a.commandId });
    const spy = vi.spyOn(boss, 'send');
    spy.mockClear();
    expect(() => makeEnqueuePrivacyJob(boss, { ...clearExplorationQueue, name: 'reasoning.paid-dispatch' })).toThrow(
      'PRIVACY_QUEUE_INVALID',
    );
    await maintenance()(p.accountId, a.commandId, async (scope) => {
      if (isClearCore(scope)) throw new Error('fixture expected accounting');
      for (const payload of [
        { v: 1 as const, accountId: p.accountId, commandId: randomUUID() },
        { v: 1 as const, accountId: randomUUID(), commandId: a.commandId },
      ])
        await expect(makeEnqueuePrivacyJob(boss, clearExplorationQueue)(scope, payload)).rejects.toThrow(
          'PRIVACY_JOB_BINDING_INVALID',
        );
      await expect(
        makeEnqueuePrivacyJob(boss, clearExplorationQueue)(
          { ...scope },
          { v: 1, accountId: p.accountId, commandId: a.commandId },
        ),
      ).rejects.toThrow();
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const q = await seedPerson(db());
    await makeWithPrivacyScope(db(), { lockTimeoutMs: 5000 })(
      { accountId: q.accountId, universeId: q.universeId, privacyEpoch: 1 },
      async (scope) => {
        await expect(
          makeEnqueuePrivacyJob(boss, clearExplorationQueue)(scope, {
            v: 1,
            accountId: q.accountId,
            commandId: randomUUID(),
          }),
        ).rejects.toThrow('Privacy operation binding unavailable');
      },
    );
  });
});
