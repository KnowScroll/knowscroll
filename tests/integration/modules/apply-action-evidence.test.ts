import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { applyActionEvidenceQueue, type ApplyActionEvidence } from '@knowscroll/backend/modules/evidence';
import { APPLY_ACTION_EVIDENCE, evidenceProviders } from '@knowscroll/backend/modules/evidence/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { experienceUseCases } from '../support/experience.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';

const silent: LogEvent = () => undefined;
const SCOPE = Symbol('test.withPersonalScope');

describe('evidence.apply-action consumer (real database, real pg-boss)', () => {
  let database: TestDatabase<Database>;
  let applyActionEvidence: ApplyActionEvidence;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('evidence');
    applyActionEvidence = buildFromProviders(
      evidenceProviders({ withPersonalScope: SCOPE }),
      APPLY_ACTION_EVIDENCE,
      new Map([[SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })]]),
    ) as ApplyActionEvidence;
  });
  afterAll(async () => {
    await database.drop();
  });

  async function evidenceAndRevision(universeId: string) {
    const events = await sql<{
      n: number;
    }>`select count(*)::int as n from evidence.action_events where universe_id = ${universeId}`.execute(database.db);
    const universe = await database.db
      .selectFrom('identity.universes')
      .select('revision')
      .where('id', '=', universeId)
      .executeTakeFirstOrThrow();
    return { events: events.rows[0]?.n ?? 0, revision: universe.revision };
  }

  async function saveOnce(person: Awaited<ReturnType<typeof seedPerson>>) {
    const asset = await seedAsset(database.db);
    const useCases = await experienceUseCases(database);
    try {
      const result = await useCases.applyAction(person.authority, {
        commandId: randomUUID(),
        kind: 'save',
        target: { assetId: asset.assetId, assetRevision: 1 },
      });
      if (result.kind !== 'applied') throw new Error('fixture save was refused');
      return result.outcome.actionId;
    } finally {
      await useCases.close();
    }
  }

  it('records the action once, advances the revision once, however often it is delivered', async () => {
    const person = await seedPerson(database.db);
    const actionId = await saveOnce(person);
    const payload = { v: 1 as const, universeId: person.universeId, privacyEpoch: 1, actionId };
    expect(await applyActionEvidence(payload)).toMatchObject({ kind: 'applied', revision: 1 });
    expect(await applyActionEvidence(payload)).toEqual({ kind: 'skipped', reason: 'already_applied' });
    expect(await evidenceAndRevision(person.universeId)).toEqual({ events: 1, revision: 1 });
  });

  it('is harmless when the worker crashes after committing and pg-boss redelivers the job', async () => {
    const person = await seedPerson(database.db);
    await saveOnce(person);
    const deliveries: number[] = [];
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    await startConsumers(
      worker,
      [
        jobConsumer(applyActionEvidenceQueue, async (payload, delivery) => {
          deliveries.push(delivery.retryCount);
          await applyActionEvidence(payload);
          // Simulated crash after the effects committed but before pg-boss recorded completion.
          if (delivery.retryCount === 0) throw new Error('simulated crash after commit');
        }),
      ],
      silent,
    );
    try {
      await expect
        .poll(
          async () => {
            const state = await sql<{
              state: string;
            }>`select state from pgboss.job where name = ${applyActionEvidenceQueue.name} and data ->> 'universeId' = ${person.universeId}`.execute(
              database.db,
            );
            return state.rows.map((row) => row.state);
          },
          { timeout: 30_000, interval: 250 },
        )
        .toEqual(['completed']);
    } finally {
      await drainConsumers(worker, 1, 5_000, silent);
    }
    expect(deliveries).toEqual([0, 1]);
    expect(await evidenceAndRevision(person.universeId)).toEqual({ events: 1, revision: 1 });
  });

  it('skips work from an older privacy epoch instead of applying it', async () => {
    const person = await seedPerson(database.db);
    const actionId = await saveOnce(person);
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    expect(await applyActionEvidence({ v: 1, universeId: person.universeId, privacyEpoch: 1, actionId })).toEqual({
      kind: 'skipped',
      reason: 'epoch_changed',
    });
    expect(await evidenceAndRevision(person.universeId)).toEqual({ events: 0, revision: 0 });
  });
});
