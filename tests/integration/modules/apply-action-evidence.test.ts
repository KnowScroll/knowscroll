import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { applyActionEvidenceQueue, type ApplyActionEvidence } from '@knowscroll/backend/modules/evidence';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { experienceUseCases } from '../support/experience.js';
import { seedAsset, seedPerson } from '../support/fixtures.js';
import { evidenceUseCase } from '../support/evidence.js';

const silent: LogEvent = () => undefined;
const secret = 'canary-job-secret-Xq19';

describe('evidence.apply-action consumer (real database, real pg-boss)', () => {
  let database: TestDatabase<Database>;
  let applyActionEvidence: ApplyActionEvidence;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('evidence');
    applyActionEvidence = evidenceUseCase(database);
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

  it('records the action once, however often it is delivered, and leaves the revision to the command', async () => {
    const person = await seedPerson(database.db);
    const actionId = await saveOnce(person);
    const payload = { v: 1 as const, universeId: person.universeId, privacyEpoch: 1, actionId };
    // The save advanced the revision to 1 in its own transaction. Evidence changes nothing a client
    // reads, so the job advances nothing and notifies no one.
    expect(await applyActionEvidence(payload)).toEqual({ kind: 'applied', eventId: expect.any(String) as unknown });
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
          await applyActionEvidence(payload);
          // Other tests in this file leave their own jobs in the queue; observe this person's only.
          if (payload.universeId !== person.universeId) return;
          deliveries.push(delivery.retryCount);
          // Simulated crash after the effects committed but before pg-boss recorded completion.
          // (What pg-boss stores about a failure is proved in infrastructure/jobs.test.ts.)
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

  it('dead-letters a job whose payload does not match its queue at once, with a code-only output', async () => {
    const worker = createBoss(database.settings, 'consumer', { onError: () => undefined, onWarning: () => undefined });
    await worker.start();
    const handled: unknown[] = [];
    await startConsumers(
      worker,
      [jobConsumer(applyActionEvidenceQueue, (payload) => Promise.resolve(void handled.push(payload)))],
      silent,
    );
    const marker = randomUUID();
    const id = await worker.send(applyActionEvidenceQueue.name, { v: 99, universeId: marker, note: secret });
    try {
      await expect
        .poll(async () => (await worker.findJobs(applyActionEvidenceQueue.name, { id: id ?? '' }))[0]?.state, {
          timeout: 20_000,
          interval: 250,
        })
        .toBe('failed');
      const [job] = await worker.findJobs(applyActionEvidenceQueue.name, { id: id ?? '' });
      expect(job?.retryCount).toBe(0);
      expect(job?.output).toEqual({
        failure: 'invalid_payload',
        errorClass: 'InvalidJobPayloadError',
        code: 'INVALID_JOB_PAYLOAD',
      });
      await expect
        .poll(
          async () =>
            (await worker.findJobs(`${applyActionEvidenceQueue.name}.dead`, { data: { universeId: marker } })).length,
          { timeout: 10_000 },
        )
        .toBe(1);
      expect(handled).toEqual([]);
    } finally {
      await drainConsumers(worker, 1, 5_000, silent);
    }
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
    // The save's own revision (1) stands; the stale evidence work changes nothing.
    expect(await evidenceAndRevision(person.universeId)).toEqual({ events: 0, revision: 1 });
  });
});
