import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyQueueDeclarations,
  createBoss,
  defineQueue,
  drainConsumers,
  jobConsumer,
  startConsumers,
} from '@knowscroll/backend/infrastructure/jobs';
import { RUN_WATCHDOG, type RunWatchdog } from '@knowscroll/backend/modules/operator';
import { watchdogProviders } from '@knowscroll/backend/modules/operator/nest-providers';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { buildFromProviders } from '../support/providers.js';

/**
 * The hourly watchdog (#674, D-411) over `ops.watchdog`, on real PostgreSQL and a real pg-boss: a planted dead letter, a repeated
 * failure, a stuck run, an old unknown attempt, a Cartographer that keeps settling unavailable for a reader with references, and a
 * repeated offer in a `composer-policy.v2` decision. Each rule fires on its condition and not otherwise; the alerts name only codes
 * and counts. Every record is a labelled CI fixture; no provider is called.
 */
const PRIVATE = 'CI-PRIVATE-WATCHDOG-TEXT';

const failingQueue = defineQueue({
  name: 'fixture.watchdog-failing',
  purpose: 'CI fixture: a handler that always fails and dead-letters, so the watchdog has something to see.',
  payload: z.object({ v: z.literal(1), taskId: z.string() }),
  policy: {
    expireInSeconds: 60,
    retryLimit: 0,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retentionSeconds: 7_200,
    deleteAfterSeconds: 3_600,
    deadLetter: true,
  },
  consumer: { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
});

describe('the watchdog (real PostgreSQL and pg-boss, CI fixtures)', () => {
  let world: GeographyWorld;
  let watchdog: RunWatchdog;
  const db = () => world.database.db;
  beforeAll(async () => {
    world = await geographyWorld('watchdog');
    const DATABASE = Symbol('database');
    watchdog = buildFromProviders(
      watchdogProviders({ database: DATABASE }),
      RUN_WATCHDOG,
      new Map([[DATABASE, db()]]),
    ) as RunWatchdog;
  });
  afterAll(() => world.close());

  const alerts = async () => (await watchdog()).alerts;
  /** The alerts of one rule: later tests keep what earlier ones planted, so each rule is read on its own. */
  const only = async (code: string) => (await alerts()).filter((alert) => alert.code === code);
  const codes = async () => (await alerts()).map((alert) => alert.code).sort();

  it('raises nothing on a quiet database, reads every rule, and tolerates having no composer-policy.v2 decision', async () => {
    const pass = await watchdog();
    expect(pass).toEqual({ alerts: [], skipped: [] });
  });

  describe('jobs', () => {
    const diagnostics = { onError: () => undefined, onWarning: () => undefined };
    async function failJobs(count: number) {
      const worker = createBoss(world.database.settings, 'consumer', diagnostics);
      await worker.start();
      await startConsumers(
        worker,
        [jobConsumer(failingQueue, () => Promise.reject(Object.assign(new Error(PRIVATE), { code: 'FIXTURE_CRASH' })))],
        () => undefined,
      );
      try {
        for (let n = 0; n < count; n++) await worker.send(failingQueue.name, { v: 1, taskId: PRIVATE });
        const settled = async () =>
          Number(
            (
              await sql<{ n: string }>`select count(*)::text as n from pgboss.job
                where name = ${`${failingQueue.name}.dead`}`.execute(db())
            ).rows[0]!.n,
          );
        const target = (await settled()) + count;
        for (let waited = 0; (await settled()) < target; waited += 200) {
          if (waited > 30_000) throw new Error('the fixture jobs did not dead-letter');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } finally {
        await drainConsumers(worker, 1, 5_000, () => undefined);
      }
    }

    beforeAll(async () => {
      const install = createBoss(world.database.settings, 'install', diagnostics);
      await install.start();
      await applyQueueDeclarations(install, [failingQueue]);
      await install.stop({ graceful: false });
    });

    it('flags a dead-lettered job in the window, and repeated failures only from the fifth with the same code', async () => {
      await failJobs(4);
      expect(await alerts()).toEqual([
        { code: 'dead_lettered_jobs', count: 4, windowSeconds: 3 * 3600, queue: `${failingQueue.name}.dead` },
      ]);
      await failJobs(1);
      expect(await alerts()).toEqual([
        { code: 'dead_lettered_jobs', count: 5, windowSeconds: 3 * 3600, queue: `${failingQueue.name}.dead` },
        {
          code: 'failed_jobs_repeating',
          count: 5,
          windowSeconds: 6 * 3600,
          queue: failingQueue.name,
          outcome: 'FIXTURE_CRASH',
        },
      ]);
      expect(JSON.stringify(await alerts())).not.toContain(PRIVATE);
    });

    it('stops flagging them once they are older than the windows', async () => {
      await sql`update pgboss.job set created_on = now() - interval '5 hours' where name = ${`${failingQueue.name}.dead`}`.execute(
        db(),
      );
      await sql`update pgboss.job set completed_on = now() - interval '7 hours' where name = ${failingQueue.name}`.execute(
        db(),
      );
      expect(await alerts()).toEqual([]);
    });
  });

  describe('personal runs and model attempts', () => {
    let reader: FixturePerson;
    beforeAll(async () => {
      reader = await seedPerson(db());
      await world.coherent(reader);
    });

    it('does not flag a Cartographer run that is merely waiting', async () => {
      expect((await world.state(reader)).activeRunId).toBeDefined();
      expect(await codes()).toEqual([]);
    });

    it('flags a Cartographer run and a Planner run held queued past the hour, naming only the module and status', async () => {
      await sql`update geography.runs set updated_at = now() - interval '2 hours'
        where universe_id = ${reader.universeId}::uuid and status = 'queued'`.execute(db());
      const plannerRun = randomUUID();
      await sql`insert into planner.runs (universe_id, privacy_epoch, id, revision, status, updated_at)
        values (${reader.universeId}::uuid, 1, ${plannerRun}::uuid, 1, 'prepared', now() - interval '3 hours')`.execute(
        db(),
      );
      const found = await alerts();
      expect(found).toEqual(
        expect.arrayContaining([
          { code: 'personal_runs_held', count: 1, windowSeconds: 3600, context: 'geography', outcome: 'queued' },
          { code: 'personal_runs_held', count: 1, windowSeconds: 3600, context: 'planner', outcome: 'prepared' },
        ]),
      );
      expect(found).toHaveLength(2);
      expect(JSON.stringify(found)).not.toContain(reader.universeId);
      // A settled run is not held, however old.
      await sql`update planner.runs set status = 'accepted' where id = ${plannerRun}::uuid`.execute(db());
      expect((await alerts()).map((alert) => alert.context)).toEqual(['geography']);
      await sql`update geography.runs set updated_at = now() where universe_id = ${reader.universeId}::uuid`.execute(
        db(),
      );
      expect(await codes()).toEqual([]);
    });

    it('flags a model attempt whose outcome is still unknown after six hours, and not a recent one', async () => {
      const runId = randomUUID();
      await db()
        .insertInto('reasoning.business_runs')
        .values({
          universe_id: reader.universeId,
          id: runId,
          owner_module: 'fixture',
          purpose: 'watchdog-fixture',
          privacy_epoch: 1,
          role_id: 'fixture.watchdog',
          role_version: 'v1',
          policy_version: 'fixture.v1',
          provider: 'minimax',
          model: 'MiniMax-M3',
          context_bundle_ref: 'fixture.bundle:watchdog',
          context_refs: JSON.stringify([PRIVATE]),
        })
        .execute();
      const attempt = async (hoursAgo: number) => {
        const attemptId = randomUUID();
        await db()
          .insertInto('reasoning.external_attempts')
          .values({
            universe_id: reader.universeId,
            id: attemptId,
            run_id: runId,
            step: `step-${attemptId.slice(0, 8)}`,
            provider: 'minimax',
            model: 'MiniMax-M3',
            request_hash: 'a'.repeat(64),
            state: 'unknown',
            outcome_code: 'TIMEOUT_AFTER_DISPATCH',
            dispatch_id: randomUUID(),
            dispatched_by: 'worker:1',
            dispatched_at: sql<Date>`now() - make_interval(hours => ${hoursAgo})`,
            reserved_at: sql<Date>`now() - make_interval(hours => ${hoursAgo})`,
            role_id: 'fixture.watchdog',
            role_version: 'v1',
            prompt_version: 'hp2',
            reserved_tokens: 1_000,
            budget_window: sql<Date>`(now() at time zone 'UTC')::date`,
          })
          .execute();
        await db()
          .insertInto('reasoning.usage_receipts')
          .values({
            attempt_id: attemptId,
            role_id: 'fixture.watchdog',
            role_version: 'v1',
            provider: 'minimax',
            model: 'MiniMax-M3',
            budget_window: sql<Date>`(now() at time zone 'UTC')::date`,
            reserved_tokens: 1_000,
            state: 'unknown',
          })
          .execute();
      };
      await attempt(1);
      expect(await codes()).toEqual([]);
      await attempt(7);
      expect(await alerts()).toEqual([
        { code: 'unknown_attempts_old', count: 1, windowSeconds: 6 * 3600, context: 'personal' },
      ]);
    });
  });

  describe('a Cartographer that keeps settling unavailable for a reader with references', () => {
    const insertRuns = async (person: FixturePerson, outcomes: readonly string[]) => {
      // Oldest first: the last element is the latest settled run.
      for (const [index, outcome] of outcomes.entries())
        await sql`insert into geography.runs (universe_id, privacy_epoch, id, desired_revision, status, outcome, created_at, updated_at)
          values (${person.universeId}::uuid, 1, ${randomUUID()}::uuid, ${index + 1}, 'insufficient', ${outcome},
            now() - make_interval(mins => ${(outcomes.length - index) * 10}), now() - make_interval(mins => ${(outcomes.length - index) * 10}))`.execute(
          db(),
        );
    };
    const withReading = async () => {
      const person = await seedPerson(db());
      await world.observe(person, await world.fixture());
      return person;
    };
    // A person's own queued run (made by reading) is held in a way the first test below must not count.
    it('counts a universe whose last three runs ended on one reason, and only one that has coverage references', async () => {
      const streak = await withReading();
      await insertRuns(streak, ['coverage_unavailable', 'coverage_unavailable', 'coverage_unavailable']);
      const limit = await withReading();
      await insertRuns(limit, ['context_limit', 'context_limit', 'context_limit', 'context_limit']);
      const noReferences = await seedPerson(db());
      await insertRuns(noReferences, ['coverage_unavailable', 'coverage_unavailable', 'coverage_unavailable']);
      const tooFew = await withReading();
      await insertRuns(tooFew, ['coverage_unavailable', 'coverage_unavailable']);
      const broken = await withReading();
      await insertRuns(broken, ['coverage_unavailable', 'coverage_unavailable', 'no_changes', 'coverage_unavailable']);
      const healthy = await withReading();
      await insertRuns(healthy, ['no_changes', 'no_changes', 'no_changes']);
      expect(await only('geography_unavailable_repeating')).toEqual([
        { code: 'geography_unavailable_repeating', count: 1, windowSeconds: 7 * 86_400, outcome: 'context_limit' },
        {
          code: 'geography_unavailable_repeating',
          count: 1,
          windowSeconds: 7 * 86_400,
          outcome: 'coverage_unavailable',
        },
      ]);
    });
  });

  describe('Composer decisions that offer a met explanation while recording an unseen candidate', () => {
    let person: FixturePerson;
    beforeAll(async () => {
      person = await seedPerson(db());
      // composer-policy.v2 does not exist yet. This disposable database lets its row in, to show the rule reads the shape it will have.
      await sql`alter table composer.decisions drop constraint decisions_policy_version_check`.execute(db());
    });
    const decision = async (
      policy: string,
      offered: string,
      candidates: readonly { unit: string; asset: string; eligible: boolean; encountered: boolean | undefined }[],
    ) => {
      const payload = {
        version: 'composer-decision.v0',
        universeId: person.universeId,
        privacyEpoch: 1,
        policyVersion: policy,
        input: {
          evidence: {
            established: {
              units: candidates.flatMap((candidate) =>
                candidate.encountered === undefined
                  ? []
                  : [{ explanationUnitId: candidate.unit, encountered: candidate.encountered, facets: [] }],
              ),
            },
          },
        },
        evaluations: candidates.map((candidate) => ({
          assetId: candidate.asset,
          assetRevision: 1,
          explanationUnitId: candidate.unit,
          eligible: candidate.eligible,
          title: PRIVATE,
        })),
        selection: [{ assetId: offered, assetRevision: 1, score: 1 }],
      };
      await sql`insert into composer.decisions (id, universe_id, privacy_epoch, command_id, input_sha256, policy_version, payload, expires_at)
        values (${randomUUID()}::uuid, ${person.universeId}::uuid, 1, ${randomUUID()}::uuid, ${'b'.repeat(64)}, ${policy},
          ${JSON.stringify(payload)}::jsonb, now() + interval '10 days')`.execute(db());
    };
    const met = { unit: 'unit-met', asset: 'asset-met', eligible: true, encountered: true };
    const unseen = { unit: 'unit-unseen', asset: 'asset-unseen', eligible: true, encountered: false };

    it('flags a v2 decision that offered a met explanation while an eligible unseen one was recorded, and no other', async () => {
      // Fine: the last resort (nothing unseen existed), an unseen offer, an unseen candidate that is not eligible, and history that does not say.
      await decision('composer-policy.v2', 'asset-met', [met]);
      await decision('composer-policy.v2', 'asset-unseen', [met, unseen]);
      await decision('composer-policy.v2', 'asset-met', [met, { ...unseen, eligible: false }]);
      await decision('composer-policy.v2', 'asset-met', [met, { ...unseen, encountered: undefined }]);
      // Earlier policies make the same choice today; the rule belongs to v2 and ignores them.
      await decision('composer-policy.v1', 'asset-met', [met, unseen]);
      expect(await only('composer_repeat_offered')).toEqual([]);
      await decision('composer-policy.v2', 'asset-met', [met, unseen]);
      await decision('composer-policy.v2', 'asset-met', [met, unseen]);
      expect(await only('composer_repeat_offered')).toEqual([
        { code: 'composer_repeat_offered', count: 2, windowSeconds: 86_400, outcome: 'composer-policy.v2' },
      ]);
      expect(JSON.stringify(await alerts())).not.toContain(PRIVATE);
    });

    it('stops flagging a decision recorded before the window', async () => {
      await sql`update composer.decisions set recorded_at = now() - interval '30 hours', expires_at = now() - interval '6 hours' + interval '24 hours'
        where universe_id = ${person.universeId}::uuid`.execute(db());
      expect(await only('composer_repeat_offered')).toEqual([]);
    });
  });

  it('shows no id and no text in any row of the view', async () => {
    const rows = await sql<{ row: string }>`select row_to_json(watchdog)::text as row from ops.watchdog`.execute(db());
    expect(rows.rows.length).toBeGreaterThan(0);
    const text = rows.rows.map((row) => row.row).join('\n');
    expect(text).not.toContain(PRIVATE);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
