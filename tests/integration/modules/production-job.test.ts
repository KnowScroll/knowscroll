import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  produceScrollJob,
  produceScrollSingletonKey,
  produceScrollQueue,
  type ProduceScrollJob,
} from '@knowscroll/backend/modules/content';
import {
  makeEnqueueScrollProduction,
  makeRunScrollProduction,
  produceScrollUseCase,
  readLibraryStatus,
} from '@knowscroll/backend/modules/content/nest-providers';
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureAuthored, fixtureResearchFor } from '../support/generated-scroll.js';
import { fixtureModel, fixtureSettings, signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';

const answer = (): FixtureScenario => ({ kind: 'success', text: JSON.stringify(fixtureAuthored('diagram')) });
const delivery = () => ({ signal: signal() });

describe('Scroll production as worker jobs (CI fixture model + real PostgreSQL and pg-boss; no provider network)', () => {
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('production_job');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  function setup(script: () => FixtureScenario, quota?: Parameters<typeof fixtureModel>[1]['quota']) {
    const fixture = fixtureModel(script, { label: 'production-job-CI-fixture', ...(quota ? { quota } : {}) });
    // No transport is real: the MiniMax stand-in identity lets the publication attribute its model.
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: 'MiniMax-M3.1-Flash' });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: withScope,
        enabled: true,
        model,
        logEvent: silent,
        settings: fixtureSettings,
      }),
    );
    const producer = (overrides: { readonly harness?: ProductionReasoningHarness } = {}) =>
      produceScrollUseCase({
        db: database.db,
        authority: { scopeId: 'scroll-supply', generation: 1 },
        withScope,
        harness: overrides.harness ?? harness,
        model: model.model,
        research: (url) => Promise.resolve(fixtureResearchFor(url)),
      });
    return { fixture, harness, producer, run: makeRunScrollProduction(producer()) };
  }

  const runRow = (recipe = 'seasons') =>
    database.db
      .selectFrom('content.scroll_production_runs')
      .select(['state', 'asset_id'])
      .where('topic', '=', recipe)
      .executeTakeFirst();

  it('publishes the recipe on a delivery, and a second delivery of the same job does nothing more', async () => {
    const p = setup(answer);
    const first = await p.run(produceScrollJob('seasons'), delivery());
    expect(first).toMatchObject({ kind: 'finished', result: { outcome: 'published', revision: 1 } });
    expect(await p.run(produceScrollJob('seasons'), delivery())).toEqual(first);
    expect(p.fixture.calls).toHaveLength(1);
    expect(await runRow()).toMatchObject({ state: 'published' });
  });

  it('drops a job for another recipe version or for a recipe the plan does not hold, touching nothing', async () => {
    const p = setup(answer);
    expect(await p.run({ ...produceScrollJob('seasons'), policyVersion: 'scroll-production.v0' }, delivery())).toEqual({
      kind: 'skipped',
      reason: 'policy_version',
    });
    expect(await p.run(produceScrollJob('not-in-the-plan'), delivery())).toEqual({
      kind: 'skipped',
      reason: 'unknown_recipe',
    });
    expect(p.fixture.calls).toHaveLength(0);
    expect(await database.db.selectFrom('content.scroll_production_runs').select('id').execute()).toEqual([]);
  });

  it('completes a delivery whose job was rejected, and never runs that recipe again at this version', async () => {
    const p = setup(() => ({ kind: 'malformed' }));
    const first = await p.run(produceScrollJob('seasons'), delivery());
    expect(first).toMatchObject({ kind: 'finished', result: { outcome: 'rejected' } });
    const calls = p.fixture.calls.length;
    expect(await p.run(produceScrollJob('seasons'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'rejected' },
    });
    expect(p.fixture.calls).toHaveLength(calls);
    expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'stopped', job: 'rejected' });
  });

  it('leaves an attempt of unknown outcome unknown and never resends it, however often it is delivered', async () => {
    const p = setup(() => ({ kind: 'gateway_timeout' }));
    expect(await p.run(produceScrollJob('seasons'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'unknown' },
    });
    expect(await p.run(produceScrollJob('seasons'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'unknown' },
    });
    expect(p.fixture.calls).toHaveLength(1);
  });

  it('fails a delivery when the production scope is switched off, so the job retries instead of vanishing', async () => {
    const p = setup(answer);
    await sql`update reasoning.production_scopes set enabled=false where id='scroll-supply'`.execute(database.db);
    await expect(p.run(produceScrollJob('seasons'), delivery())).rejects.toThrow('SCROLL_PRODUCTION_SCOPE_REFUSED');
    expect(p.fixture.calls).toHaveLength(0);
  });

  it('pauses when the provider quota is spent, sends nothing, and resumes the same job once it allows', async () => {
    let quotaSpent = true;
    const p = setup(answer, () => ({
      verdict: quotaSpent ? 'unavailable' : 'not_applicable',
      intervalRemainingPercent: null,
      weeklyRemainingPercent: null,
    }));
    const paused = await p.run(produceScrollJob('seasons'), delivery());
    expect(paused).toMatchObject({ kind: 'finished', result: { outcome: 'paused', codes: ['quota_unavailable'] } });
    expect(p.fixture.calls).toHaveLength(0);
    expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'running', job: 'writer' });
    quotaSpent = false;
    expect(await p.run(produceScrollJob('seasons'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'published' },
    });
    expect(p.fixture.calls).toHaveLength(1);
  });

  it('resumes the same job after a crash before the writer, without fetching the research again', async () => {
    const p = setup(answer);
    const crash: ProductionReasoningHarness = {
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      proposeProduction: () => Promise.reject(new Error('CI_CRASH_BEFORE_WRITER')),
    };
    await expect(
      makeRunScrollProduction(p.producer({ harness: crash }))(produceScrollJob('seasons'), delivery()),
    ).rejects.toThrow('CI_CRASH_BEFORE_WRITER');
    expect(await runRow()).toMatchObject({ state: 'writer' });
    expect((await readLibraryStatus(database.db, ['seasons']))[0]).toMatchObject({ state: 'running' });
    expect(await p.run(produceScrollJob('seasons'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'published' },
    });
    expect(p.fixture.calls).toHaveLength(1);
  });

  it('keeps one job per recipe version in flight however many senders ask, and runs it once through a real queue consumer', async () => {
    const p = setup(answer);
    const producerBoss = createBoss(database.settings, 'producer', {
      onError: () => undefined,
      onWarning: () => undefined,
    });
    const consumerBoss = createBoss(database.settings, 'consumer', {
      onError: () => undefined,
      onWarning: () => undefined,
    });
    await producerBoss.start();
    await consumerBoss.start();
    try {
      const enqueue = makeEnqueueScrollProduction(producerBoss);
      expect(await enqueue('seasons')).toBe('queued');
      expect(await enqueue('seasons')).toBe('already_queued');
      const consumers = [
        jobConsumer(produceScrollQueue, async (job: ProduceScrollJob, deliveryOf) => {
          await p.run(job, deliveryOf);
        }),
      ];
      await startConsumers(consumerBoss, consumers, silent);
      await expect.poll(async () => (await runRow())?.state, { timeout: 30_000, interval: 250 }).toBe('published');
      const jobState = async () =>
        (
          await sql<{
            state: string;
          }>`select state from pgboss.job where name=${produceScrollQueue.name} and singleton_key=${produceScrollSingletonKey(produceScrollJob('seasons'))}`.execute(
            database.db,
          )
        ).rows[0]?.state;
      await expect.poll(jobState, { timeout: 30_000, interval: 250 }).toBe('completed');
      // A finished job does not block a new send; the redelivery finds the finished run and sends nothing.
      expect(await enqueue('seasons')).toBe('queued');
      await expect
        .poll(
          async () =>
            (
              await sql`select 1 from pgboss.job where name=${produceScrollQueue.name} and state='completed'`.execute(
                database.db,
              )
            ).rows.length,
          {
            timeout: 30_000,
            interval: 250,
          },
        )
        .toBe(2);
      expect(p.fixture.calls).toHaveLength(1);
      await drainConsumers(consumerBoss, consumers.length, 5_000, silent);
    } finally {
      await producerBoss.stop({ graceful: false });
      await consumerBoss.stop({ graceful: false });
    }
  });
});
