import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { applyActionEvidenceQueue } from '@knowscroll/backend/modules/evidence';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { experienceUseCases } from '../support/experience.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';

describe('experience applyAction with real adapters (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('apply_action');
  });
  afterAll(async () => {
    await database.drop();
  });

  async function counts(universeId: string) {
    const count = async (table: 'experience.actions' | 'receipts.personal_commands' | 'experience.saved_items') => {
      const row = await database.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('universe_id', '=', universeId)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    };
    return {
      actions: await count('experience.actions'),
      receipts: await count('receipts.personal_commands'),
      saved: await count('experience.saved_items'),
    };
  }

  async function jobCount(universeId: string): Promise<number> {
    const result = await sql<{
      n: number;
    }>`select count(*)::int as n from pgboss.job where name = ${applyActionEvidenceQueue.name} and data ->> 'universeId' = ${universeId}`.execute(
      database.db,
    );
    return result.rows[0]?.n ?? 0;
  }

  it('applies a save once and replays the stored outcome for the same command', async () => {
    const person = await seedPerson(database.db);
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    try {
      const command = {
        commandId: randomUUID(),
        kind: 'save' as const,
        target: { assetId: asset.assetId, assetRevision: asset.revision },
      };
      const first = await useCases.applyAction(person.authority, command);
      expect(first).toMatchObject({
        kind: 'applied',
        replayed: false,
        outcome: { saved: true, changed: true, assetId: asset.assetId },
      });
      const second = await useCases.applyAction(person.authority, {
        ...command,
        target: { assetRevision: asset.revision, assetId: asset.assetId },
      });
      expect(second).toEqual({ ...first, replayed: true });
      expect(await jobCount(person.universeId)).toBe(1);
      expect(await counts(person.universeId)).toMatchObject({ actions: 1, receipts: 1, saved: 1 });
    } finally {
      await useCases.close();
    }
  });

  it('refuses a reused command ID with different content and changes nothing', async () => {
    const person = await seedPerson(database.db);
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    try {
      const commandId = randomUUID();
      await useCases.applyAction(person.authority, {
        commandId,
        kind: 'save',
        target: { assetId: asset.assetId, assetRevision: 1 },
      });
      expect(
        await useCases.applyAction(person.authority, {
          commandId,
          kind: 'unsave',
          target: { assetId: asset.assetId, assetRevision: 1 },
        }),
      ).toEqual({
        kind: 'refused',
        reason: 'command_key_reused',
      });
      expect(await counts(person.universeId)).toMatchObject({ actions: 1, receipts: 1, saved: 1 });
      expect(await jobCount(person.universeId)).toBe(1);
    } finally {
      await useCases.close();
    }
  });

  it('refuses missing, withdrawn and stale assets without writing a receipt', async () => {
    const person = await seedPerson(database.db);
    const withdrawn = await seedAsset(database.db, { status: 'withdrawn' });
    const current = await seedAsset(database.db, { revision: 3 });
    const useCases = await experienceUseCases(database);
    try {
      const apply = (assetId: string, assetRevision: number) =>
        useCases.applyAction(person.authority, {
          commandId: randomUUID(),
          kind: 'save',
          target: { assetId, assetRevision },
        });
      expect(await apply(randomUUID(), 1)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      expect(await apply(withdrawn.assetId, 1)).toEqual({ kind: 'refused', reason: 'asset_not_found' });
      expect(await apply(current.assetId, 2)).toEqual({ kind: 'refused', reason: 'asset_revision_stale' });
      expect(await counts(person.universeId)).toMatchObject({ actions: 0, receipts: 0, saved: 0 });
    } finally {
      await useCases.close();
    }
  });

  it('rolls back the receipt, the effect and the enqueued job together when the command fails after enqueueing', async () => {
    const person = await seedPerson(database.db);
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database, {
      wrapEnqueue: (enqueue) => async (scope, queue, payload) => {
        await enqueue(scope, queue, payload);
        throw new Error('failure after the job was written');
      },
    });
    try {
      await expect(
        useCases.applyAction(person.authority, {
          commandId: randomUUID(),
          kind: 'save',
          target: { assetId: asset.assetId, assetRevision: 1 },
        }),
      ).rejects.toThrow('failure after the job was written');
      expect(await counts(person.universeId)).toMatchObject({ actions: 0, receipts: 0, saved: 0 });
      expect(await jobCount(person.universeId)).toBe(0);
    } finally {
      await useCases.close();
    }
  });

  it('refuses a caller whose privacy epoch is stale', async () => {
    const person = await seedPerson(database.db, { privacyEpoch: 2 });
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    try {
      expect(
        await useCases.applyAction(
          { ...person.authority, privacyEpoch: 1 },
          { commandId: randomUUID(), kind: 'save', target: { assetId: asset.assetId, assetRevision: 1 } },
        ),
      ).toEqual({
        kind: 'refused',
        reason: 'epoch_changed',
      });
      expect(await useCases.listSaved({ ...person.authority, privacyEpoch: 1 }, 10)).toEqual({
        kind: 'refused',
        reason: 'epoch_changed',
      });
    } finally {
      await useCases.close();
    }
  });
});
