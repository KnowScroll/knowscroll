import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBoss, drainConsumers, jobConsumer, startConsumers } from '@knowscroll/backend/infrastructure/jobs';
import {
  makeWithProductionScope,
  productionTransactionOf,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import {
  planLibraryProduction,
  produceScrollJob,
  produceScrollSingletonKey,
  produceScrollQueue,
  ProduceScrollJobSchema,
  SCROLL_PRODUCTION_VERSION,
  type ProduceScrollJob,
} from '@knowscroll/backend/modules/content';
import {
  makeEnqueueScrollProduction,
  makeReviewGate,
  makeRunScrollProduction,
  readLibraryStatus,
} from '@knowscroll/backend/modules/content/nest-providers';
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureProductionWorker, type QuotaScript } from '../support/production-worker.js';
import { answerWith } from '../support/generated-scroll.js';
import { ResearchRefusal } from '../../../packages/backend/src/infrastructure/research/public-pages.js';
import { productionStore } from '../../../packages/backend/src/modules/content/production/store.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { spikePlanV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/plans.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { signal, silent } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { orrinResearchFor } from '../support/scroll-v2.js';
import { orrinV3 } from '../support/scroll-v3.js';

const answer = (): FixtureScenario => answerWith(orrinV3());
const delivery = () => ({ signal: signal() });

describe('Scroll production as worker jobs (CI fixture model + real PostgreSQL and pg-boss; no provider network)', () => {
  // The recorded Orrin reply is written to the Seasons plan, so the recipes this file produces take that plan for the file's own process.
  const planned = ['stars-fusion', 'tides', 'greenhouse'].map((key) => ({
    recipe: (TOPICS as Record<string, { scrollV3?: ScrollV3Plan }>)[key]!,
    own: TOPICS[key as 'tides'].scrollV3,
  }));
  beforeAll(() => {
    for (const { recipe } of planned) recipe.scrollV3 = spikePlanV3('seasons');
  });
  afterAll(() => {
    for (const { recipe, own } of planned) recipe.scrollV3 = own;
  });
  /** The operator's release of the revision a take published: a document v3 library Scroll is held until then, and only then is the recipe published. */
  const release = async (recipe: 'stars-fusion' | 'tides', revision = 1) =>
    expect(
      await makeReviewGate(database.db).release({
        assetId: TOPICS[recipe].assetId,
        revision,
        decidedBy: 'cli:ci-reviewer',
      }),
    ).toMatchObject({ kind: 'released' });
  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('production_job');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  const setup = (script: () => FixtureScenario, quota?: QuotaScript) =>
    fixtureProductionWorker(database, script, {
      research: (url) => Promise.resolve(orrinResearchFor(url)),
      ...(quota ? { quota } : {}),
    });

  const runRow = (recipe = 'stars-fusion') =>
    database.db
      .selectFrom('content.scroll_production_runs')
      .select(['state', 'asset_id'])
      .where('topic', '=', recipe)
      .executeTakeFirst();

  it('publishes the recipe on a delivery, and a second delivery of the same job does nothing more', async () => {
    const p = setup(answer);
    const first = await p.run(produceScrollJob('stars-fusion'), delivery());
    expect(first).toMatchObject({ kind: 'finished', result: { outcome: 'published', revision: 1, held: true } });
    // The redelivery reports the finished job as it stands (the revision is held, as the first delivery said), and sends nothing.
    const again = await p.run(produceScrollJob('stars-fusion'), delivery());
    expect(again).toMatchObject({ kind: 'finished', result: { outcome: 'published', revision: 1 } });
    expect(again).toEqual({ ...first, result: { ...(first as { result: object }).result, held: undefined } });
    expect(p.fixture.calls).toHaveLength(1);
    expect(await runRow()).toMatchObject({ state: 'published' });
  });

  it('drops a job for another recipe version or for a recipe the plan does not hold, touching nothing', async () => {
    const p = setup(answer);
    expect(
      await p.run({ ...produceScrollJob('stars-fusion'), policyVersion: 'scroll-production.v0' }, delivery()),
    ).toEqual({
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

  it('completes a delivery whose job was rejected, and never runs that take again', async () => {
    const p = setup(() => ({ kind: 'malformed' }));
    const first = await p.run(produceScrollJob('stars-fusion'), delivery());
    expect(first).toMatchObject({ kind: 'finished', result: { outcome: 'rejected' } });
    const calls = p.fixture.calls.length;
    expect(await p.run(produceScrollJob('stars-fusion'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'rejected' },
    });
    expect(p.fixture.calls).toHaveLength(calls);
    expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({
      state: 'retryable',
      job: 'rejected',
      takes: 1,
    });
  });

  it('leaves an attempt of unknown outcome unknown and never resends it, however often it is delivered', async () => {
    const p = setup(() => ({ kind: 'gateway_timeout' }));
    expect(await p.run(produceScrollJob('stars-fusion'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'unknown' },
    });
    expect(await p.run(produceScrollJob('stars-fusion'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'unknown' },
    });
    expect(p.fixture.calls).toHaveLength(1);
  });

  it('fails a delivery when the production scope is switched off, so the job retries instead of vanishing', async () => {
    const p = setup(answer);
    await sql`update reasoning.production_scopes set enabled=false where id='scroll-supply'`.execute(database.db);
    await expect(p.run(produceScrollJob('stars-fusion'), delivery())).rejects.toThrow(
      'SCROLL_PRODUCTION_SCOPE_REFUSED',
    );
    expect(p.fixture.calls).toHaveLength(0);
  });

  it('pauses when the provider quota is spent, sends nothing, and resumes the same job once it allows', async () => {
    let quotaSpent = true;
    const p = setup(answer, () => ({
      verdict: quotaSpent ? 'unavailable' : 'not_applicable',
      intervalRemainingPercent: null,
      weeklyRemainingPercent: null,
    }));
    const paused = await p.run(produceScrollJob('stars-fusion'), delivery());
    expect(paused).toMatchObject({ kind: 'finished', result: { outcome: 'paused', codes: ['quota_unavailable'] } });
    expect(p.fixture.calls).toHaveLength(0);
    expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({
      state: 'running',
      job: 'writer',
    });
    quotaSpent = false;
    expect(await p.run(produceScrollJob('stars-fusion'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'published' },
    });
    expect(p.fixture.calls).toHaveLength(1);
    // The attempt that sent nothing before the pause is not part of the lineage: the Scroll is still
    // attributed to its topic and bound to its facets, so a person who asked for it can be served.
    expect(await database.db.selectFrom('content.encounter_topics').select('topic_id').execute()).toEqual([
      { topic_id: TOPICS['stars-fusion'].topicId },
    ]);
    const outcomes = await database.db
      .selectFrom('content.scroll_production_runs')
      .select('outcomes')
      .where('topic', '=', 'stars-fusion')
      .executeTakeFirstOrThrow();
    expect(outcomes.outcomes).not.toContainEqual(expect.objectContaining({ code: 'attribution_unverified' }));
    const bound = await database.db.selectFrom('content.region_bindings').select('facet_id').execute();
    expect(bound.length).toBeGreaterThan(0);
  });

  it('resumes the same job after a crash before the writer, without fetching the research again', async () => {
    const p = setup(answer);
    const crash: ProductionReasoningHarness = {
      readProductionRunAccounting: (scope, runId) => p.harness.readProductionRunAccounting(scope, runId),
      closeProductionRun: (scope, run) => p.harness.closeProductionRun(scope, run),
      proposeProduction: () => Promise.reject(new Error('CI_CRASH_BEFORE_WRITER')),
    };
    await expect(
      makeRunScrollProduction(p.producer({ harness: crash }), { madeToOrderEnabled: true })(
        produceScrollJob('stars-fusion'),
        delivery(),
      ),
    ).rejects.toThrow('CI_CRASH_BEFORE_WRITER');
    expect(await runRow()).toMatchObject({ state: 'writer' });
    expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({ state: 'running' });
    expect(await p.run(produceScrollJob('stars-fusion'), delivery())).toMatchObject({
      kind: 'finished',
      result: { outcome: 'published' },
    });
    expect(p.fixture.calls).toHaveLength(1);
  });

  describe('research failures', () => {
    const research = (failure: () => Error | undefined) => (url: string) => {
      const error = failure();
      return error === undefined ? Promise.resolve(orrinResearchFor(url)) : Promise.reject(error);
    };

    it('does not spend a take on a transient failure: the job waits at research and the same take publishes', async () => {
      let failure: Error | undefined = new ResearchRefusal('network_failed');
      const p = fixtureProductionWorker(database, answer, { research: research(() => failure) });
      await expect(p.run(produceScrollJob('stars-fusion', 1), delivery())).rejects.toThrow(
        'SCROLL_PRODUCTION_RESEARCH_UNAVAILABLE',
      );
      expect(p.fixture.calls).toHaveLength(0);
      expect(await runRow()).toMatchObject({ state: 'research' });
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({ state: 'running', takes: 1 });
      // A plain error (not a refusal of the sources) is a blip as well.
      failure = new Error('socket hang up');
      await expect(p.run(produceScrollJob('stars-fusion', 1), delivery())).rejects.toThrow(
        'SCROLL_PRODUCTION_RESEARCH_UNAVAILABLE',
      );
      failure = undefined;
      expect(await p.run(produceScrollJob('stars-fusion', 1), delivery())).toMatchObject({
        kind: 'finished',
        result: { outcome: 'published', take: 1 },
      });
      expect(
        await database.db
          .selectFrom('content.scroll_production_runs')
          .select('take')
          .where('topic', '=', 'stars-fusion')
          .execute(),
      ).toEqual([{ take: 1 }]);
    });

    it('still rejects a take on a verdict about the sources', async () => {
      const p = fixtureProductionWorker(database, answer, {
        research: research(() => new ResearchRefusal('soft_404')),
      });
      expect(await p.run(produceScrollJob('stars-fusion', 1), delivery())).toMatchObject({
        kind: 'finished',
        result: { outcome: 'rejected', codes: ['soft_404'] },
      });
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({
        state: 'retryable',
        takes: 1,
      });
    });
  });

  describe('takes after a rejection', () => {
    const rejected = () => ({ kind: 'malformed' }) as const;
    const takes = async (recipe = 'stars-fusion') =>
      (
        await database.db
          .selectFrom('content.scroll_production_runs')
          .select(['take', 'state', 'writer_run_id'])
          .where('topic', '=', recipe)
          .orderBy('take')
          .execute()
      ).map((row) => [row.take, row.state] as const);

    it('publishes take 2 after take 1 was rejected, as a new business run that resends nothing', async () => {
      let answerNow = false;
      const p = setup(() => (answerNow ? answer() : rejected()));
      expect(await p.run(produceScrollJob('stars-fusion', 1), delivery())).toMatchObject({
        kind: 'finished',
        result: { outcome: 'rejected', take: 1 },
      });
      const callsAfterFirst = p.fixture.calls.length;
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({
        state: 'retryable',
        takes: 1,
      });
      // The rejected take stays final: asking for it again reports it and sends nothing.
      expect(await p.run(produceScrollJob('stars-fusion', 1), delivery())).toMatchObject({
        result: { outcome: 'rejected' },
      });
      expect(p.fixture.calls).toHaveLength(callsAfterFirst);

      answerNow = true;
      expect(await p.run(produceScrollJob('stars-fusion', 2), delivery())).toMatchObject({
        kind: 'finished',
        result: { outcome: 'published', take: 2, revision: 1 },
      });
      expect(await takes()).toEqual([
        [1, 'rejected'],
        [2, 'published'],
      ]);
      const writerRuns = (
        await database.db
          .selectFrom('content.scroll_production_runs')
          .select('writer_run_id')
          .where('topic', '=', 'stars-fusion')
          .execute()
      ).map((row) => row.writer_run_id);
      expect(new Set(writerRuns).size).toBe(2);
      // The published revision waits at the review gate (a document v3 library Scroll is held); once the operator releases it, the recipe is published.
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({ state: 'held', takes: 2 });
      await release('stars-fusion');
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({
        state: 'published',
        takes: 2,
      });
      // A served document v3 recipe may be regenerated (D-197), so the third take is allowed (held beside the served revision); the revision
      // it leaves held takes no further take, and no fourth take is ever allowed. (A v1 recipe took no further take once published; no v1 recipe is produced.)
      expect(await p.run(produceScrollJob('stars-fusion', 3), delivery())).toMatchObject({
        result: { outcome: 'published', take: 3, revision: 2, held: true },
      });
      expect(await p.run(produceScrollJob('stars-fusion', 4), delivery())).toMatchObject({
        result: { outcome: 'take_refused' },
      });
    });

    it('refuses a take that skips a take, and one after an unknown attempt', async () => {
      const p = setup(() => ({ kind: 'gateway_timeout' }));
      expect(await p.run(produceScrollJob('stars-fusion', 2), delivery())).toMatchObject({
        kind: 'finished',
        result: { outcome: 'take_refused', take: 2 },
      });
      expect(await takes()).toEqual([]);
      expect(await p.run(produceScrollJob('stars-fusion', 1), delivery())).toMatchObject({
        result: { outcome: 'unknown' },
      });
      const calls = p.fixture.calls.length;
      // The attempt may have reached the provider: no later take may start, and nothing is resent.
      expect(await p.run(produceScrollJob('stars-fusion', 2), delivery())).toMatchObject({
        result: { outcome: 'take_refused' },
      });
      expect(p.fixture.calls).toHaveLength(calls);
      expect(await takes()).toEqual([[1, 'unknown']]);
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({ state: 'stopped', takes: 1 });
    });

    it('allows three takes in all and no fourth', async () => {
      const p = setup(rejected);
      for (const take of [1, 2, 3])
        expect(await p.run(produceScrollJob('stars-fusion', take), delivery())).toMatchObject({
          result: { outcome: 'rejected', take },
        });
      expect(await takes()).toEqual([
        [1, 'rejected'],
        [2, 'rejected'],
        [3, 'rejected'],
      ]);
      expect((await readLibraryStatus(database.db, ['stars-fusion']))[0]).toMatchObject({ state: 'stopped', takes: 3 });
      // A fourth take is refused before anything is sent: three takes count, and none was refused with `asset_conflict` (D-439).
      const calls = p.fixture.calls.length;
      expect(await p.run(produceScrollJob('stars-fusion', 4), delivery())).toMatchObject({
        result: { outcome: 'take_refused' },
      });
      expect(p.fixture.calls).toHaveLength(calls);
      expect(await takes()).toHaveLength(3);
      // The take numbers go to six, to leave room for takes that were refused and do not count; the job schema and the database
      // refuse a seventh number.
      expect(ProduceScrollJobSchema.safeParse({ ...produceScrollJob('stars-fusion'), take: 6 }).success).toBe(true);
      expect(ProduceScrollJobSchema.safeParse({ ...produceScrollJob('stars-fusion'), take: 7 }).success).toBe(false);
      await expect(
        sql`insert into content.scroll_production_runs (id,topic,policy_version,take,target_revision,scope_generation,state,writer_run_id) values (gen_random_uuid(),'stars-fusion',${SCROLL_PRODUCTION_VERSION},7,1,1,'research',gen_random_uuid())`.execute(
          database.db,
        ),
      ).rejects.toMatchObject({ constraint: 'scroll_production_runs_take_check' });
    });

    it('plans the next take of a rejected recipe and skips one that cannot be taken again', async () => {
      const p = setup(rejected);
      await p.run(produceScrollJob('stars-fusion', 1), delivery());
      const unknown = setup(() => ({ kind: 'gateway_timeout' }));
      await unknown.run(produceScrollJob('tides', 1), delivery());
      const plan = planLibraryProduction(
        await readLibraryStatus(database.db, ['stars-fusion', 'tides', 'greenhouse']),
        {
          interactiveFirst: false,
        },
      );
      expect(plan.queue).toEqual([
        { recipe: 'stars-fusion', take: 2 },
        { recipe: 'greenhouse', take: 1 },
      ]);
      expect(plan.skipped).toEqual([{ recipe: 'tides', reason: 'stopped' }]);

      const boss = createBoss(database.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
      await boss.start();
      try {
        const enqueue = makeEnqueueScrollProduction(boss);
        expect(await enqueue('stars-fusion', 2)).toBe('queued');
        expect(await enqueue('stars-fusion', 2)).toBe('already_queued');
        // A different take is a different job.
        expect(await enqueue('stars-fusion', 3)).toBe('queued');
      } finally {
        await boss.stop({ graceful: false });
      }
    });

    it('creates a take once however many senders ask at the same moment', async () => {
      const p = setup(rejected);
      await p.run(produceScrollJob('stars-fusion', 1), delivery());
      const store = productionStore(database.db);
      const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
      const authority = { scopeId: 'scroll-supply', generation: 1 } as const;
      const ask = () =>
        withScope(authority, (scope) =>
          store.create(productionTransactionOf(scope), 'stars-fusion', TOPICS['stars-fusion'].assetId, 1, 2),
        );
      const results = await Promise.all([ask(), ask(), ask()]);
      const jobs = results.map((entered) => (entered.kind === 'entered' ? entered.value : undefined));
      expect(jobs.filter((job) => job?.kind === 'job' && job.created)).toHaveLength(1);
      expect((await takes()).filter(([take]) => take === 2)).toHaveLength(1);
    });
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
      expect(await enqueue('stars-fusion', 1)).toBe('queued');
      expect(await enqueue('stars-fusion', 1)).toBe('already_queued');
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
          }>`select state from pgboss.job where name=${produceScrollQueue.name} and singleton_key=${produceScrollSingletonKey(produceScrollJob('stars-fusion'))}`.execute(
            database.db,
          )
        ).rows[0]?.state;
      await expect.poll(jobState, { timeout: 30_000, interval: 250 }).toBe('completed');
      // A finished job does not block a new send; the redelivery finds the finished run and sends nothing.
      expect(await enqueue('stars-fusion', 1)).toBe('queued');
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
