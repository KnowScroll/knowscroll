import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@knowscroll/backend/infrastructure/ids';
import { applyQueueDeclarations, createBoss, defineQueue } from '@knowscroll/backend/infrastructure/jobs';
import { COMPOSER_POLICY_V1, composeEncounter } from '@knowscroll/backend/modules/composer';
import { RUN_WATCHDOG, type RunWatchdog } from '@knowscroll/backend/modules/operator';
import { watchdogProviders } from '@knowscroll/backend/modules/operator/nest-providers';
import { regressedDecision, snapshotOf, storeDecision, storeRaw, v2Decision } from '../support/composer-decisions.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, type GeographyWorld } from '../support/geography-world.js';
import { buildFromProviders } from '../support/providers.js';

/**
 * The hourly watchdog (#674, D-411) over `ops.watchdog`, on real PostgreSQL and a real pg-boss: a planted dead letter, a repeated
 * failure, a stuck run, an old unknown attempt, a Cartographer that keeps settling the same unhealthy outcome for a reader with
 * references, and a Composer v2 decision that repeats. Each rule fires on its condition and not otherwise; the alerts name only
 * codes and counts. Every record is a labelled CI fixture; no provider is called.
 */
const PRIVATE = 'CI-PRIVATE-WATCHDOG-TEXT';

const failingQueue = defineQueue({
  name: 'fixture.watchdog-failing',
  purpose: 'CI fixture: jobs that fail for good and dead-letter, so the watchdog has something to see.',
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

  it('raises nothing on a quiet database, reads every rule, and has no composer-policy.v2 decision to read', async () => {
    expect(await watchdog()).toEqual({ alerts: [], skipped: [] });
  });

  describe('jobs', () => {
    const diagnostics = { onError: () => undefined, onWarning: () => undefined };
    /**
     * Fails `count` jobs of the fixture queue for good, with no consumer and no waiting: send, claim and fail them through
     * pg-boss itself, which then writes the failed rows and copies each to the dead-letter queue.
     */
    async function failJobs(count: number) {
      const boss = createBoss(world.database.settings, 'producer', diagnostics);
      await boss.start();
      try {
        for (let n = 0; n < count; n++) await boss.send(failingQueue.name, { v: 1, taskId: PRIVATE });
        const claimed = await boss.fetch(failingQueue.name, { batchSize: count });
        expect(claimed).toHaveLength(count);
        await boss.fail(
          failingQueue.name,
          claimed.map((job) => job.id),
          { failure: 'handler_failed', errorClass: 'Error', code: 'FIXTURE_CRASH' },
        );
      } finally {
        await boss.stop({ graceful: false });
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

  describe('a Cartographer that keeps settling an unhealthy outcome for a reader with references', () => {
    /**
     * Settled runs, oldest first: the last element is the latest. Their ids are UUIDv7, as the server mints them, so id order is
     * creation order (the view reads a universe's newest runs by id). The universe has settled a run lately, as every one that does.
     */
    const insertRuns = async (person: FixturePerson, outcomes: readonly string[], status = 'insufficient') => {
      for (const [index, outcome] of outcomes.entries()) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await sql`insert into geography.runs (universe_id, privacy_epoch, id, desired_revision, status, outcome, created_at, updated_at)
          values (${person.universeId}::uuid, 1, ${uuidv7()}::uuid, ${index + 1}, ${status}, ${outcome},
            now() - make_interval(mins => ${(outcomes.length - index) * 10}), now() - make_interval(mins => ${(outcomes.length - index) * 10}))`.execute(
          db(),
        );
      }
      await sql`insert into geography.state (universe_id, privacy_epoch, next_run_not_before)
        values (${person.universeId}::uuid, 1, now())
        on conflict (universe_id, privacy_epoch) do update set next_run_not_before = now()`.execute(db());
    };
    const withReading = async () => {
      const person = await seedPerson(db());
      await world.observe(person, await world.fixture());
      return person;
    };
    const repeating = () => only('geography_insufficient_repeating');
    const repeats = (outcome: string, count = 1) => ({
      code: 'geography_insufficient_repeating',
      count,
      windowSeconds: 7 * 86_400,
      outcome,
    });

    it('counts a universe whose last three runs ended on one unhealthy outcome, and only one that has coverage references', async () => {
      const streak = await withReading();
      await insertRuns(streak, ['no_trusted_support', 'no_trusted_support', 'no_trusted_support']);
      const limit = await withReading();
      await insertRuns(limit, ['context_too_large', 'context_too_large', 'context_too_large', 'context_too_large']);
      const noReferences = await seedPerson(db());
      await insertRuns(noReferences, ['no_trusted_support', 'no_trusted_support', 'no_trusted_support']);
      const tooFew = await withReading();
      await insertRuns(tooFew, ['no_trusted_support', 'no_trusted_support']);
      const broken = await withReading();
      await insertRuns(broken, ['no_trusted_support', 'no_trusted_support', 'no_changes', 'no_trusted_support']);
      expect(await repeating()).toEqual([repeats('context_too_large'), repeats('no_trusted_support')]);
    });

    it('lets the healthy outcomes repeat: no change, a role switched off, a reader with nothing read yet', async () => {
      for (const outcome of ['no_changes', 'disabled', 'no_support_yet']) {
        const person = await withReading();
        await insertRuns(person, [outcome, outcome, outcome, outcome]);
      }
      expect(await repeating()).toEqual([repeats('context_too_large'), repeats('no_trusted_support')]);
    });

    it('flags any other repeating outcome, such as a limit, and ignores a streak of applied runs', async () => {
      const limited = await withReading();
      await insertRuns(limited, ['coverage_limit', 'coverage_limit', 'coverage_limit']);
      const applied = await withReading();
      await insertRuns(applied, ['applied_by_rules', 'applied_by_rules', 'applied_by_rules'], 'accepted');
      expect(await repeating()).toEqual([
        repeats('context_too_large'),
        repeats('coverage_limit'),
        repeats('no_trusted_support'),
      ]);
    });

    it('ignores a universe that has not settled a run for a month', async () => {
      const stale = await withReading();
      await insertRuns(stale, ['structure_limit', 'structure_limit', 'structure_limit']);
      await sql`update geography.state set next_run_not_before = now() - interval '40 days'
        where universe_id = ${stale.universeId}::uuid`.execute(db());
      expect((await repeating()).map((alert) => alert.outcome)).not.toContain('structure_limit');
    });
  });

  describe('Composer v2 decisions that offered a met explanation first while an unseen one was eligible', () => {
    let person: FixturePerson;
    const asset = () => randomUUID();
    const tides = 'earth.tides';
    const seasons = 'earth.seasons';
    /** A met explanation about the topic the person is moving towards, and a new one about another. */
    const met = () => ({ asset: asset(), unit: `unit-met-${randomUUID()}`, topic: tides, met: true });
    const fresh = () => ({ asset: asset(), unit: `unit-new-${randomUUID()}`, topic: seasons, met: false });
    const repeated = () => only('composer_repeat_offered');

    beforeAll(async () => {
      person = await seedPerson(db());
    });

    it('is not fired by what policy v2 itself decides, stored through the Composer’s own store', async () => {
      // v2 offers the unseen one (the met one is excluded), and, when nothing unseen exists, the met one as the last resort.
      const unseen = v2Decision(snapshotOf(person, [met(), fresh()], { intentTopic: tides }));
      expect(unseen.unseenLadder?.outcome).toBe('unseen');
      const lastResort = v2Decision(snapshotOf(person, [met()], { intentTopic: tides }));
      expect(lastResort.unseenLadder?.outcome).toBe('fell_back');
      expect(await storeDecision(db(), person, unseen)).toBe('stored');
      expect(await storeDecision(db(), person, lastResort)).toBe('stored');
      expect(await repeated()).toEqual([]);
    });

    it('fires when a decision offers the met explanation first while an unseen one is eligible', async () => {
      const candidates = [met(), fresh()];
      const snapshot = snapshotOf(person, candidates, { intentTopic: tides });
      // What Composer does today for this move, then what a regression of its guarantee would record: the same code with unseen-first
      // off, under the v2 label. The store refuses it (it must replay under the real v2), so it is written the way only a bug would.
      const correct = v2Decision(snapshot);
      const regressed = regressedDecision(snapshot);
      expect(correct.selection[0]?.assetId).toBe(candidates[1]!.asset);
      expect(regressed.selection[0]?.assetId).toBe(candidates[0]!.asset);
      await expect(storeDecision(db(), person, regressed)).rejects.toThrow('COMPOSER_REPLAY_INVALID');
      await storeRaw(db(), person, regressed);
      await storeRaw(db(), person, regressedDecision(snapshotOf(person, [met(), fresh()], { intentTopic: tides })));
      expect(await repeated()).toEqual([
        { code: 'composer_repeat_offered', count: 2, windowSeconds: 86_400, outcome: 'composer-policy.v2' },
      ]);
      expect(JSON.stringify(await alerts())).not.toContain('CI Fixture');
    });

    it('reads only the first selected slot, only vertical moves, none with an exact target, and only policy v2', async () => {
      const before = (await repeated())[0]!.count;
      // The first offer is unseen and a met one follows it: not a repeat. (Intent towards the new topic ranks it first.)
      const second = regressedDecision(snapshotOf(person, [met(), fresh()], { intentTopic: seasons }));
      expect(second.selection.length).toBeGreaterThan(1);
      expect(second.selection[0]?.assetId).not.toBe(second.selection[1]?.assetId);
      await storeRaw(db(), person, second);
      // The same regression on a move the person asked for, which the unseen-first rule never covered: a return, and a vertical move with an exact target.
      const exact = met();
      await storeRaw(
        db(),
        person,
        regressedDecision(snapshotOf(person, [exact, fresh()], { intentTopic: tides, exactTarget: exact.asset })),
      );
      await storeRaw(
        db(),
        person,
        regressedDecision(snapshotOf(person, [exact, fresh()], { mode: 'return', exactTarget: exact.asset })),
      );
      // An earlier policy makes this choice by design.
      const v1 = composeEncounter(snapshotOf(person, [met(), fresh()], { intentTopic: tides }), COMPOSER_POLICY_V1);
      expect(v1.selection[0]).toBeDefined();
      await storeDecision(db(), person, v1);
      expect((await repeated())[0]!.count).toBe(before);
    });

    it('stops flagging a decision recorded before the window, and a decision past the 7 days the view reads', async () => {
      await sql`update composer.decisions set recorded_at = now() - interval '30 hours', expires_at = now() + interval '30 days' - interval '30 hours'
        where universe_id = ${person.universeId}::uuid`.execute(db());
      expect(await repeated()).toEqual([]);
      await sql`update composer.decisions set recorded_at = now() - interval '10 days', expires_at = now() + interval '20 days'
        where universe_id = ${person.universeId}::uuid`.execute(db());
      expect(await repeated()).toEqual([]);
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
