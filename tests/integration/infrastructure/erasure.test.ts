import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { checkErasureInventory, eraseUniverse, erasureRegistry } from '@knowscroll/backend/infrastructure/erasure';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { admitRun, reserveAttempt } from '@knowscroll/backend/reasoning';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { experienceUseCases } from '../support/experience.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';

/** Rows per registered personal table for one universe. */
async function personalRowCountsIn(
  db: TestDatabase<Database>['db'],
  universeId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const declaration of personalStores) {
    for (const table of declaration.tables) {
      const result = await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.table(`${table.schema}.${table.table}`)} where universe_id = ${universeId}`.execute(
        db,
      );
      counts[`${table.schema}.${table.table}`] = result.rows[0]?.n ?? 0;
    }
  }
  return counts;
}

describe('the erasure registry (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('erasure');
  });
  afterAll(async () => {
    await database.drop();
  });

  const personalRowCounts = (universeId: string) => personalRowCountsIn(database.db, universeId);

  it('declares every table that has a universe_id column, and nothing else', async () => {
    expect(await checkErasureInventory(database.db, personalStores)).toEqual([]);
  });

  it('fails the inventory when a personal table is not registered', async () => {
    await sql`create table experience.forgotten_personal (universe_id uuid not null)`.execute(database.db);
    try {
      expect(await checkErasureInventory(database.db, personalStores)).toEqual([
        'experience.forgotten_personal has a universe_id column but no module declares it in the erasure registry',
      ]);
    } finally {
      await sql`drop table experience.forgotten_personal`.execute(database.db);
    }
  });

  it('refuses a table declared by two modules', () => {
    const [first] = personalStores;
    if (first === undefined) throw new Error('empty registry');
    expect(() => erasureRegistry([first, { ...first, module: 'duplicate' }])).toThrow('declared by two modules');
  });

  it('erases one universe from every registered store and leaves another universe untouched', async () => {
    const erased = await seedPerson(database.db);
    const kept = await seedPerson(database.db);
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    try {
      for (const person of [erased, kept]) {
        await useCases.applyAction(person.authority, {
          commandId: randomUUID(),
          kind: 'save',
          target: { assetId: asset.assetId, assetRevision: 1 },
        });
        await withPersonalScope(person.authority, async (scope) => {
          const runId = randomUUID();
          await admitRun(scope, { id: runId, ownerModule: 'fixture', purpose: 'fixture' });
          await reserveAttempt(scope, {
            id: randomUUID(),
            runId,
            step: 'step',
            provider: 'fixture',
            model: 'fixture',
            requestHash: 'a'.repeat(64),
          });
        });
      }
      const before = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      expect(Object.values(before.erased).filter((count) => count > 0).length).toBeGreaterThanOrEqual(5);
      const reports = await withPersonalScope(erased.authority, (scope) => eraseUniverse(scope, personalStores));
      expect(reports.kind === 'entered' && reports.value.every((report) => report.status === 'completed')).toBe(true);
      const after = {
        erased: await personalRowCounts(erased.universeId),
        kept: await personalRowCounts(kept.universeId),
      };
      expect(Object.values(after.erased).every((count) => count === 0)).toBe(true);
      expect(after.kept).toEqual(before.kept);
    } finally {
      await useCases.close();
    }

    const jobs = async (universeId: string) =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pgboss.job where data ->> 'universeId' = ${universeId}`.execute(database.db)
      ).rows[0]?.n;
    expect(await jobs(erased.universeId)).toBe(0);
    expect(await jobs(kept.universeId)).toBeGreaterThan(0);
  });
});
