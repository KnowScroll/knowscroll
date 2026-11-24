import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeReviewGate, readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';
import { cleanupOldScrolls } from '../../../apps/worker/src/old-scroll-cleanup.js';
import type { ScrollV3Plan } from '../../../packages/backend/src/modules/content/domain/library/plan.js';
import { RECIPES } from '../../../packages/backend/src/modules/content/domain/library/index.js';
import { spikePlanV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/plans.js';
import { fixtureReplyV3 } from '../../../packages/backend/src/modules/content/production/spike-v3/writer-v3.fixture.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import { answerWith, enableProductionScope } from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { markScrollV1, orrinResearchFor } from '../support/scroll-v2.js';
import { seedDocumentV2, seedDocumentV3 } from '../support/scroll-v3.js';

/**
 * #800, D-439 over real PostgreSQL. The cleanup of the v1 and v2 Scrolls used to withdraw an asset that was left with only a rejected
 * document v3 revision, and `publish` then refused every later take of the recipe as `asset_conflict`. It now holds such an asset, as the
 * review gate leaves an asset that was never released; a repair in the same command puts back the assets the old cleanup withdrew; and a
 * take that was refused with `asset_conflict` does not count toward the three takes unless the asset is withdrawn. The production job is
 * the real one, over a labelled fixture model whose one reply is the recorded Orrin document v3 (an invented planet, never provider output).
 */
const key = 'seasons';
const recipe = TOPICS[key];
const assetId = recipe.assetId;
const operator = 'cli:ci-reviewer';

describe('the cleanup holds an asset left with a rejected v3, repairs the ones it withdrew, and refused takes do not count (real PostgreSQL)', () => {
  // The plan marks Seasons as a document v3 recipe once it is not a v1 one: the production job writes it as such.
  const restoreV1 = markScrollV1(key);
  const planned = RECIPES[key] as { scrollV3?: ScrollV3Plan };
  beforeAll(() => {
    planned.scrollV3 = spikePlanV3(key);
  });
  afterAll(() => {
    delete planned.scrollV3;
    restoreV1();
  });

  let database: TestDatabase<Database>;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('old_scroll_cleanup_conflict');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });
  const db = () => database.db;
  const worker = () =>
    fixtureProductionWorker(database, () => answerWith(fixtureReplyV3()), {
      research: (url) => Promise.resolve(orrinResearchFor(url)),
    });
  const gate = () => makeReviewGate(db());
  const standing = async () => (await readLibraryStatus(db(), [key]))[0]!;
  const assetRow = () =>
    db()
      .selectFrom('content.assets')
      .select(['status', 'revision'])
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
  const runsOf = async () =>
    (
      await sql<{ take: number; state: string; conflict: boolean }>`select take, state,
        outcomes @> '[{"role":"checks","kind":"rejected","code":"asset_conflict"}]'::jsonb as conflict
        from content.scroll_production_runs where topic = ${key} order by take`.execute(db())
    ).rows;

  /** The asset serves a v2 revision 1, as the library did before the cleanup. */
  async function serveV2() {
    await db()
      .insertInto('content.assets')
      .values({ id: assetId, revision: 1, kind: 'scroll', status: 'admitted' })
      .execute();
    await seedDocumentV2(db(), 'seasons-stage-ci', { assetId, revision: 1, unit: 'ci-seasons-v2' });
  }

  /** A Scroll of its own that is withdrawn and holds only a v3 revision 1 the review gate rejected: what the old cleanup left. */
  async function leaveWithdrawnWithRejectedV3(): Promise<string> {
    const { assetId: id } = await seedDocumentV3(db(), 'fence-v3-ci');
    await sql`update content.assets set status = 'withdrawn' where id = ${id}::uuid`.execute(db());
    await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by, reason)
      values (${id}::uuid, 1, 'rejected', now(), ${operator}, 'ci: rejected')`.execute(db());
    return id;
  }

  describe('an asset serving a v2 revision, with a rejected v3 revision beside it', () => {
    beforeEach(async () => {
      await serveV2();
      // The v3 take publishes revision 2 held (the v2 stays served), and the reviewer rejects it.
      expect(await worker().producer()(key, false, signal(), false, 1)).toMatchObject({
        outcome: 'published',
        revision: 2,
        held: true,
      });
      expect(
        await gate().reject({ assetId, revision: 2, reason: 'ci: not good enough', decidedBy: operator }),
      ).toMatchObject({ kind: 'rejected' });
    });

    it('is held, not withdrawn, once the v2 is removed, and the next take publishes revision 3', async () => {
      expect(await assetRow()).toEqual({ status: 'admitted', revision: 1 });
      const planned = await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'ci' });
      expect(planned).toMatchObject({
        result: 'planned',
        assets: { assetsWithCurrentRevisionMoved: [{ assetId, from: 1, kept: [2], status: 'admitted' }] },
        wronglyWithdrawnAssets: { count: 0, assetIds: [] },
      });
      expect(await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' })).toMatchObject({ result: 'done' });
      // Held, pointing at its newest kept revision, which the review gate rejected: nothing is served from it.
      expect(await assetRow()).toEqual({ status: 'held', revision: 2 });
      expect(
        await sql<{
          n: string;
        }>`select count(*)::text as n from content.assets where id = ${assetId}::uuid and status = 'admitted'`.execute(
          db(),
        ),
      ).toMatchObject({ rows: [{ n: '0' }] });
      // The recipe's take 1 spent its number on revision 2, which was rejected; take 2 writes the next revision and is stored.
      expect(await standing()).toMatchObject({ state: 'retryable', takes: 1, latestTake: 1, job: 'rejected' });
      expect(await worker().producer()(key, false, signal(), false, 2)).toMatchObject({
        outcome: 'published',
        revision: 3,
        held: true,
      });
      expect(await runsOf()).toEqual([
        { take: 1, state: 'published', conflict: false },
        { take: 2, state: 'published', conflict: false },
      ]);
      expect(await standing()).toMatchObject({ state: 'held', heldRevision: 3 });
      // A second run finds nothing and changes nothing.
      expect(await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' })).toMatchObject({
        result: 'nothing_to_do',
        wronglyWithdrawnAssets: { count: 0 },
      });
    });
  });

  describe('the repair of an asset the old cleanup withdrew', () => {
    it('is reported by the dry run, made by the run, and changes nothing the second time', async () => {
      const bad = await leaveWithdrawnWithRejectedV3();
      const planned = await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'ci' });
      // No old revision is left, so there is nothing to remove and nobody to clear: only the repair is pending.
      expect(planned).toMatchObject({ result: 'planned', wronglyWithdrawnAssets: { count: 1, assetIds: [bad] } });
      expect(
        (await db().selectFrom('content.assets').select('status').where('id', '=', bad).executeTakeFirstOrThrow())
          .status,
      ).toBe('withdrawn');
      const done = await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' });
      expect(done).toMatchObject({
        result: 'done',
        wronglyWithdrawnAssets: { count: 1, assetIds: [bad] },
        accountsCleared: 0,
        withdrawnAssets: 0,
      });
      expect(
        (await db().selectFrom('content.assets').select('status').where('id', '=', bad).executeTakeFirstOrThrow())
          .status,
      ).toBe('held');
      const again = await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' });
      expect(again).toMatchObject({ result: 'nothing_to_do', wronglyWithdrawnAssets: { count: 0, assetIds: [] } });
      expect(await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'ci' })).toMatchObject({
        result: 'nothing_to_do',
        wronglyWithdrawnAssets: { count: 0 },
      });
    });

    it('leaves a withdrawal made by another path withdrawn', async () => {
      // The release policy withdraws only a revision it released, and records it; the review is `released`, not `rejected`.
      const byPolicy = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
      await sql`update content.assets set status = 'withdrawn' where id = ${byPolicy}::uuid`.execute(db());
      await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by)
        values (${byPolicy}::uuid, 1, 'released', now(), 'policy:approved-topic-supported')`.execute(db());
      await sql`insert into content.release_withdrawals (asset_id, revision, withdrawn_by, approval)
        values (${byPolicy}::uuid, 1, 'cli:ci', 'no_topic')`.execute(db());
      // A withdrawal that is recorded even though every revision reads as rejected is still a real withdrawal.
      const recorded = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
      await sql`update content.assets set status = 'withdrawn' where id = ${recorded}::uuid`.execute(db());
      await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by, reason)
        values (${recorded}::uuid, 1, 'rejected', now(), ${operator}, 'ci: rejected')`.execute(db());
      await sql`insert into content.release_withdrawals (asset_id, revision, withdrawn_by, approval)
        values (${recorded}::uuid, 1, 'cli:ci', 'no_topic')`.execute(db());
      // A withdrawn asset with a revision that never went through the gate, or one still held, is not this state either.
      const ungated = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
      await sql`update content.assets set status = 'withdrawn' where id = ${ungated}::uuid`.execute(db());
      const heldToo = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
      await sql`update content.assets set status = 'withdrawn' where id = ${heldToo}::uuid`.execute(db());
      await sql`insert into content.revision_reviews (asset_id, revision, state) values (${heldToo}::uuid, 1, 'held')`.execute(
        db(),
      );
      // One revision rejected and one released: the released one was served, so a withdrawal of it is real.
      const mixedReviews = (await seedDocumentV3(db(), 'fence-v3-ci')).assetId;
      await seedDocumentV3(db(), 'fence-v3-ci', {
        assetId: mixedReviews,
        revision: 2,
        unit: `ci-two-${randomUUID().slice(0, 8)}`,
      });
      await sql`update content.assets set status = 'withdrawn' where id = ${mixedReviews}::uuid`.execute(db());
      await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by, reason) values
        (${mixedReviews}::uuid, 1, 'released', now(), ${operator}, null), (${mixedReviews}::uuid, 2, 'rejected', now(), ${operator}, 'ci')`.execute(
        db(),
      );
      // And the one asset that is the bad state, so the run has something to do beside leaving the others alone.
      const bad = await leaveWithdrawnWithRejectedV3();
      const planned = await cleanupOldScrolls(db(), { mode: 'dry_run', world: 'ci' });
      expect(planned).toMatchObject({ wronglyWithdrawnAssets: { count: 1, assetIds: [bad] } });
      expect(await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' })).toMatchObject({
        result: 'done',
        wronglyWithdrawnAssets: { count: 1, assetIds: [bad] },
      });
      const statuses = await db()
        .selectFrom('content.assets')
        .select(['id', 'status'])
        .where('id', 'in', [byPolicy, recorded, ungated, heldToo, mixedReviews, bad])
        .execute();
      expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
        [byPolicy]: 'withdrawn',
        [recorded]: 'withdrawn',
        [ungated]: 'withdrawn',
        [heldToo]: 'withdrawn',
        [mixedReviews]: 'withdrawn',
        [bad]: 'held',
      });
    });

    it('lets the recipe produce again: the refused takes the withdrawal caused no longer count', async () => {
      // The state last night's cleanup left: the asset withdrawn, revision 1 a v3 rejected at the gate, and three takes refused.
      await db()
        .insertInto('content.assets')
        .values({ id: assetId, revision: 1, kind: 'scroll', status: 'admitted' })
        .execute();
      await seedDocumentV3(db(), 'fence-v3-ci', { assetId, revision: 1, unit: 'ci-seasons-v3' });
      await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by, reason)
        values (${assetId}::uuid, 1, 'rejected', now(), ${operator}, 'ci: rejected')`.execute(db());
      await sql`update content.assets set status = 'withdrawn' where id = ${assetId}::uuid`.execute(db());
      for (const take of [1, 2, 3])
        expect(await worker().producer()(key, false, signal(), false, take)).toMatchObject({ outcome: 'rejected' });
      expect((await runsOf()).map((run) => run.conflict)).toEqual([true, true, true]);
      // While the asset is withdrawn the three takes count and the recipe is stopped.
      expect(await standing()).toMatchObject({ state: 'stopped', takes: 3, latestTake: 3 });
      expect(await cleanupOldScrolls(db(), { mode: 'run', world: 'ci' })).toMatchObject({
        wronglyWithdrawnAssets: { count: 1, assetIds: [assetId] },
      });
      // Held now: none of the three counts, the recipe is no longer stopped, and take 4 follows take 3 and publishes.
      expect(await standing()).toMatchObject({
        state: 'retryable',
        takes: 0,
        takesLeft: 3,
        latestTake: 3,
        refusedTakes: 3,
        job: 'refused',
      });
      expect(await worker().producer()(key, false, signal(), false, 4)).toMatchObject({
        outcome: 'published',
        revision: 2,
        held: true,
      });
      expect(await standing()).toMatchObject({ state: 'held', takes: 1, latestTake: 4, heldRevision: 2 });
    });
  });

  describe('takes that ended asset_conflict', () => {
    /** One take against an asset that conflicts: the Scroll passes every check and `publish` refuses it. */
    const refusedTake = async (take: number) => {
      const worker = fixtureProductionWorker(database, () => answerWith(fixtureReplyV3()), {
        research: (url) => Promise.resolve(orrinResearchFor(url)),
      });
      expect(await worker.producer()(key, false, signal(), false, take)).toMatchObject({ outcome: 'rejected', take });
      // The pre-flight ended the take before the research and the writer sent anything (D-439).
      expect(worker.writerCalls).toHaveLength(0);
    };
    const setStatus = (status: 'held' | 'withdrawn') =>
      sql`update content.assets set status = ${status} where id = ${assetId}::uuid`.execute(db());

    beforeEach(async () => {
      // A never-released asset: born held, with its only revision rejected by the review gate.
      await db()
        .insertInto('content.assets')
        .values({ id: assetId, revision: 1, kind: 'scroll', status: 'held' })
        .execute();
      await seedDocumentV3(db(), 'fence-v3-ci', { assetId, revision: 1, unit: 'ci-seasons-v3' });
      await sql`insert into content.revision_reviews (asset_id, revision, state, decided_at, decided_by, reason)
        values (${assetId}::uuid, 1, 'rejected', now(), ${operator}, 'ci: rejected')`.execute(db());
    });

    it('counts while the asset is withdrawn, and stops at three', async () => {
      await setStatus('withdrawn');
      await refusedTake(1);
      expect(await standing()).toMatchObject({ state: 'retryable', takes: 1, latestTake: 1, job: 'rejected' });
      await refusedTake(2);
      await refusedTake(3);
      expect(await standing()).toMatchObject({ state: 'stopped', takes: 3, latestTake: 3 });
      // No fourth take of a withdrawn asset, whatever its number: the store refuses it before anything is sent.
      const calls = worker();
      expect(await calls.producer()(key, false, signal(), false, 4)).toMatchObject({ outcome: 'take_refused' });
      expect(calls.writerCalls).toHaveLength(0);
      expect((await runsOf()).length).toBe(3);
    });

    it('ends a take of a withdrawn asset at once, with no writer request and the same receipt', async () => {
      await setStatus('withdrawn');
      await refusedTake(1);
      const run = await db()
        .selectFrom('content.scroll_production_runs')
        .select(['state', 'outcomes'])
        .where('topic', '=', key)
        .executeTakeFirstOrThrow();
      expect(run).toEqual({
        state: 'rejected',
        outcomes: [{ role: 'checks', kind: 'rejected', code: 'asset_conflict' }],
      });
    });

    it('still lets publish refuse a take when the asset is withdrawn while the writer runs', async () => {
      await setStatus('held');
      const worker = fixtureProductionWorker(
        database,
        async () => {
          await setStatus('withdrawn');
          return answerWith(fixtureReplyV3());
        },
        { research: (url) => Promise.resolve(orrinResearchFor(url)) },
      );
      expect(await worker.producer()(key, false, signal(), false, 1)).toMatchObject({ outcome: 'rejected' });
      expect(worker.writerCalls.length).toBeGreaterThan(0);
      expect((await runsOf()).map((run) => run.conflict)).toEqual([true]);
    });

    it('does not count while the asset is held, and the next take publishes', async () => {
      // The conflict is real (the asset is withdrawn when the take publishes) but the asset is held when the standing is read.
      await setStatus('withdrawn');
      await refusedTake(1);
      await setStatus('held');
      expect(await standing()).toMatchObject({
        state: 'retryable',
        takes: 0,
        takesLeft: 3,
        latestTake: 1,
        refusedTakes: 1,
        job: 'refused',
      });
      expect(await worker().producer()(key, false, signal(), false, 2)).toMatchObject({
        outcome: 'published',
        revision: 2,
        held: true,
      });
      // The refused take keeps its number, and the one that published counts.
      expect(await runsOf()).toEqual([
        { take: 1, state: 'rejected', conflict: true },
        { take: 2, state: 'published', conflict: false },
      ]);
      expect(await standing()).toMatchObject({ state: 'held', takes: 1, latestTake: 2, refusedTakes: 1 });
    });

    it('counts again when the asset is withdrawn after the refusals, and a recipe cannot pass take 6', async () => {
      await setStatus('withdrawn');
      for (const take of [1, 2, 3]) await refusedTake(take);
      await setStatus('held');
      expect(await standing()).toMatchObject({ state: 'retryable', takes: 0, latestTake: 3, refusedTakes: 3 });
      await setStatus('withdrawn');
      expect(await standing()).toMatchObject({ state: 'stopped', takes: 3 });
      // Held again: the refusals do not count. Takes 4 to 6 are refused on a held asset (a race the job cannot be made to lose
      // here, so the rows are written as the job writes them), and they keep their numbers up to the sixth.
      await setStatus('held');
      for (const take of [4, 5, 6])
        await sql`insert into content.scroll_production_runs
            (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, outcomes, completed_at)
          select gen_random_uuid(), topic, policy_version, ${take}::integer, 2, 1, 'rejected', gen_random_uuid(),
            '[{"role":"checks","kind":"rejected","code":"asset_conflict"}]'::jsonb, now()
          from content.scroll_production_runs where topic = ${key} and take = 1`.execute(db());
      expect(await standing()).toMatchObject({
        state: 'stopped',
        takes: 0,
        latestTake: 6,
        refusedTakes: 6,
        takesLeft: 0,
      });
      const calls = worker();
      expect(await calls.producer()(key, false, signal(), false, 7)).toMatchObject({ outcome: 'take_refused' });
      expect(calls.writerCalls).toHaveLength(0);
      // The database holds the same bound: no row has a take above six.
      await expect(
        sql`insert into content.scroll_production_runs (id,topic,policy_version,take,target_revision,scope_generation,state,writer_run_id)
          values (gen_random_uuid(),${key},'ci-version',7,1,1,'research',gen_random_uuid())`.execute(db()),
      ).rejects.toMatchObject({ constraint: 'scroll_production_runs_take_check' });
    });
  });
});
