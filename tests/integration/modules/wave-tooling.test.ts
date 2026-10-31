import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { planLibraryProduction, planRegeneration } from '@knowscroll/backend/modules/content';
import { makeReviewGate, readLibraryStatus } from '@knowscroll/backend/modules/content/nest-providers';
import type { ProductionReasoningHarness } from '@knowscroll/backend/reasoning';
import { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import {
  answerCheckRunId,
  checkRepairRunId,
} from '../../../packages/backend/src/modules/content/production/answer-check-step.js';
import { fixtureAuthoredV2 } from '../../../packages/backend/src/modules/content/production/spike-v2/writer-v2.fixture.js';
import { TOPICS, type ScrollTopic } from '../../../packages/backend/src/modules/content/production/topics.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { signal } from '../support/fixture-model.js';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import {
  answerWith,
  enableProductionScope,
  fixtureAuthored,
  fixtureProduction,
  verdicts,
} from '../support/generated-scroll.js';
import { fixtureProductionWorker } from '../support/production-worker.js';
import { orrinResearchFor, plainOrrin } from '../support/scroll-v2.js';

/**
 * The tooling for the library waves (S-6a, D-197 to D-199): regenerating a Scroll that is already
 * served, and the answer check that sits between the writer and the operator's read. The Scrolls are
 * the labelled Orrin fixture (an invented planet) produced through the real production job; the
 * "model" is a labelled CI fixture and nothing here is provider output.
 */
describe('regenerating a served v2 Scroll and checking its answers (labelled CI fixtures, real PostgreSQL)', () => {
  let database: TestDatabase<Database>;
  const operator = 'cli:ci-reviewer';
  const gate = () => makeReviewGate(database.db);

  beforeEach(async () => {
    database = await createTestDatabase<Database>('wave_tooling');
    await enableProductionScope(database.db);
  });
  afterEach(async () => {
    await database.drop();
  });

  const statusOf = async (key: ScrollTopic) => (await readLibraryStatus(database.db, [key]))[0]!;
  const assetOf = (key: ScrollTopic) =>
    database.db
      .selectFrom('content.assets')
      .select(['status', 'revision'])
      .where('id', '=', TOPICS[key].assetId)
      .executeTakeFirst();
  const jobsOf = (key: ScrollTopic) =>
    database.db
      .selectFrom('content.scroll_production_runs')
      .selectAll()
      .where('topic', '=', key)
      .orderBy('take')
      .execute();
  /** The state of the reasoning runs a job derived and used, by id; a run left open would never settle. */
  const runStates = async (ids: readonly string[]) =>
    (
      await database.db
        .selectFrom('reasoning.production_runs')
        .select(['id', 'state', 'closed_at'])
        .where('id', 'in', ids)
        .execute()
    ).map((run) => ({ id: run.id, state: run.state, closed: run.closed_at !== null }));
  const writing = (script: (sequence: number) => FixtureScenario = () => answerWith(fixtureAuthoredV2())) => script;

  /** Produces the first take of a recipe and releases it, the way a wave does, and returns what was released. */
  async function producedAndReleased(key: ScrollTopic) {
    const run = fixtureProduction(database.db, writing(), orrinResearchFor);
    expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true, revision: 1 });
    expect(await gate().release({ assetId: TOPICS[key].assetId, revision: 1, decidedBy: operator })).toMatchObject({
      kind: 'released',
    });
    return run;
  }

  describe('regenerating a recipe whose Scroll is served (seasons-hemispheres)', () => {
    const key = 'seasons-hemispheres';
    const assetId = TOPICS[key].assetId;

    it('is available once the Scroll is served, with two takes left; a recipe that is not a served v2 Scroll is not', async () => {
      expect(await statusOf(key)).toMatchObject({ regeneration: 'not_published', takes: 0 });
      await producedAndReleased(key);
      expect(await statusOf(key)).toMatchObject({
        state: 'published',
        takes: 1,
        takesLeft: 2,
        regeneration: 'available',
      });
      const standing = await readLibraryStatus(database.db, [key, 'tides', 'seasons']);
      expect(standing.map((row) => [row.recipe, row.regeneration])).toEqual([
        [key, 'available'],
        ['tides', 'not_v2'],
        ['seasons', 'not_published'],
      ]);
      expect(planRegeneration(standing)).toEqual({
        queue: [{ recipe: key, take: 2 }],
        skipped: [
          { recipe: 'tides', reason: 'not_v2' },
          { recipe: 'seasons', reason: 'not_published' },
        ],
      });
      // A first production is not a regeneration: produce-library sends nothing for a served recipe.
      expect(planLibraryProduction(standing, { interactiveFirst: false }).queue).not.toContainEqual(
        expect.objectContaining({ recipe: key }),
      );
    });

    it('stores the new take held as the next revision, and leaves the served revision served until it is released', async () => {
      await producedAndReleased(key);
      const again = fixtureProduction(database.db, writing(), orrinResearchFor);
      const result = await again.produce(key, false, signal(), true, 2);
      expect(result).toMatchObject({ outcome: 'published', held: true, take: 2, revision: 2, assetId });
      expect(result.requestBound).toBe(6);

      expect(await assetOf(key)).toEqual({ status: 'admitted', revision: 1 });
      expect(await gate().list({ all: false })).toMatchObject([
        { recipe: key, revision: 2, state: 'held', servedRevision: 1, coverage: 'mapped' },
      ]);
      expect(await statusOf(key)).toMatchObject({
        state: 'published',
        revision: 1,
        heldRevision: 2,
        takes: 2,
        regeneration: 'held',
      });
      // Nothing more is started while a revision waits for a decision: the next take is refused, and sends nothing.
      const third = fixtureProduction(database.db, writing(), orrinResearchFor);
      expect(await third.produce(key, false, signal(), true, 3)).toMatchObject({ outcome: 'take_refused' });
      expect(third.calls).toHaveLength(0);
      expect(planRegeneration([await statusOf(key)])).toEqual({
        queue: [],
        skipped: [{ recipe: key, reason: 'held' }],
      });

      expect(await gate().release({ assetId, revision: 2, decidedBy: operator })).toMatchObject({
        kind: 'released',
        replacedRevision: 1,
      });
      expect(await assetOf(key)).toEqual({ status: 'admitted', revision: 2 });
    });

    it('can be taken again after a release or a rejection, up to three takes in all, and then never again in this version', async () => {
      await producedAndReleased(key);
      const writers: number[] = [];
      for (const take of [2, 3]) {
        const run = fixtureProduction(database.db, writing(), orrinResearchFor);
        expect(await run.produce(key, false, signal(), true, take)).toMatchObject({
          outcome: 'published',
          held: true,
          take,
        });
        writers.push(run.calls.length);
        if (take === 2) {
          await gate().release({ assetId, revision: 2, decidedBy: operator });
          expect(await statusOf(key)).toMatchObject({ takes: 2, takesLeft: 1, regeneration: 'available' });
        }
      }
      expect(writers).toEqual([1, 1]);
      // The third take is rejected at the gate: the served Scroll is still revision 2, and the takes are spent.
      await gate().reject({ assetId, revision: 3, reason: 'a CI rejection', decidedBy: operator });
      expect(await assetOf(key)).toEqual({ status: 'admitted', revision: 2 });
      expect(await statusOf(key)).toMatchObject({ takes: 3, takesLeft: 0, regeneration: 'spent' });
      expect(planRegeneration([await statusOf(key)]).skipped).toEqual([{ recipe: key, reason: 'spent' }]);

      // A fourth take cannot start, however it is asked for, and sends nothing: paid production cannot loop.
      const fourth = fixtureProduction(database.db, writing(), orrinResearchFor);
      expect(await fourth.produce(key, false, signal(), true, 4)).toMatchObject({ outcome: 'take_refused' });
      // Asking for the third again reports the job it already is; nothing is sent.
      expect(await fourth.produce(key, false, signal(), true, 3)).toMatchObject({ take: 3, revision: 3 });
      expect(fourth.calls).toHaveLength(0);
      expect(fourth.checks).toHaveLength(0);
      expect((await jobsOf(key)).map((job) => job.take)).toEqual([1, 2, 3]);
    });

    it('does not count the takes of an earlier production version, so a new writer gets fresh ones', async () => {
      await producedAndReleased(key);
      // Pretend an earlier production version made the served Scroll and was then spent on rejections:
      // its three takes are history, not a budget.
      await sql`update content.scroll_production_runs set policy_version = 'scroll-production.v15' where topic = ${key}`.execute(
        database.db,
      );
      await sql`insert into content.scroll_production_runs (id, topic, policy_version, take, target_revision, scope_generation, state, writer_run_id, completed_at)
        select gen_random_uuid(), ${key}, 'scroll-production.v15', take, 2, 1, 'rejected', gen_random_uuid(), now()
        from generate_series(2, 3) as take`.execute(database.db);
      expect(await jobsOf(key)).toHaveLength(3);
      const status = await statusOf(key);
      expect(status).toMatchObject({ state: 'published', takes: 0, takesLeft: 3, regeneration: 'available' });
      expect(planRegeneration([status]).queue).toEqual([{ recipe: key, take: 1 }]);
    });

    it('keeps a revision that an earlier production version left held from being piled on by a new first take', async () => {
      const run = fixtureProduction(database.db, writing(), orrinResearchFor);
      expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true });
      await sql`update content.scroll_production_runs set policy_version = 'scroll-production.v15' where topic = ${key}`.execute(
        database.db,
      );
      const status = await statusOf(key);
      expect(status).toMatchObject({ state: 'held', heldRevision: 1, takes: 0 });
      expect(planLibraryProduction([status], { interactiveFirst: false })).toEqual({
        queue: [],
        skipped: [{ recipe: key, reason: 'held' }],
      });
    });

    it('never regenerates a v1 recipe or an order: only a v2 library Scroll goes through the read', async () => {
      const v1 = fixtureProduction(database.db, () => answerWith(fixtureAuthored('diagram')));
      expect(await v1.produce('tides', false, signal())).toMatchObject({ outcome: 'published', requestBound: 2 });
      expect(v1.checks).toHaveLength(0);
      expect(await statusOf('tides')).toMatchObject({ state: 'published', regeneration: 'not_v2' });
      expect((await statusOf('tides')).check).toBeUndefined();
      expect(await v1.produce('tides', false, signal(), true, 2)).toMatchObject({ outcome: 'take_refused' });
    });
  });

  describe('the answer check', () => {
    const key = 'seasons-hemispheres';
    const assetId = TOPICS[key].assetId;

    it('lets a Scroll whose calls agree through, and records the verdicts where the operator reads them', async () => {
      const run = fixtureProduction(database.db, writing(), orrinResearchFor);
      const result = await run.produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', held: true, requestBound: 6 });
      expect(run.calls).toHaveLength(1);
      expect(run.checks).toHaveLength(1);

      const [job] = await jobsOf(key);
      const receipts = job!.outcomes as { role: string; kind: string; draft?: number; verdicts?: unknown[] }[];
      const check = receipts.find((receipt) => receipt.role === 'answer_check');
      expect(check).toMatchObject({ kind: 'checked', draft: 1 });
      expect(check?.verdicts).toHaveLength(3);
      expect(receipts.filter((receipt) => receipt.role === 'writer')).toHaveLength(1);

      expect(await gate().list({ all: false })).toMatchObject([{ answerCheck: { outcome: 'passed', calls: 3 } }]);
      const shown = await gate().show({ assetId, withSources: false });
      if (shown.kind !== 'shown') throw new Error('CI expected the text');
      expect(shown.text).toContain('Answer check: passed. The checker found all 3 calls consistent');
      expect(await statusOf(key)).toMatchObject({ check: { outcome: 'passed', calls: 3 } });
      // Every run the job used is finished: nothing is left open to be resumed.
      expect(await runStates([job!.writer_run_id, answerCheckRunId(job!.id, 1)])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: job!.writer_run_id, closed: true }),
          expect.objectContaining({ id: answerCheckRunId(job!.id, 1), closed: true }),
        ]),
      );
    });

    it('shows the checker each call as data with its stop before, and no source: it judges agreement only', async () => {
      const run = fixtureProduction(database.db, writing(), orrinResearchFor);
      await run.produce(key, false, signal());
      const [request] = run.checks;
      expect(request!.request.system).toContain('content.scroll-answer-check');
      expect(request!.request.user).not.toContain('public_research_passages');
      expect(request!.request.user).not.toContain('production_brief');
      const stored = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', assetId)
        .executeTakeFirstOrThrow();
      const firstCall = (
        stored.document as { stops: { kind: string; prompt?: string; explain?: string }[] }
      ).stops.find((stop) => stop.kind === 'call_it')!;
      // The harness escapes item text, so a quote in the prompt appears escaped; the words are there.
      expect(request!.request.user).toContain(firstCall.prompt!.replaceAll('&', '&amp;'));
      expect(request!.request.user).toContain('"markedAnswer"');
      expect(request!.request.user).toContain('"stopBefore"');
    });

    it('gives a flagged draft one repair with the problem as its hint, checks the repair, and stores it', async () => {
      const repaired = fixtureAuthoredV2();
      const fixed = JSON.parse(JSON.stringify(repaired)) as { items: { type: string; explain?: string }[] };
      fixed.items[1]!.explain =
        'The north runs warm because its half of the planet leans toward Vael and the sunlight lands steeply there. Meanwhile Orrin sits nearest its star in the southern summer, when the north has winter.';
      const problem = 'The key marks the nearness option, but the explanation says the lean is the cause.';
      let firstCallId = '';
      const run = fixtureProduction(
        database.db,
        (sequence) => answerWith(sequence === 1 ? repaired : AuthoredScrollV2.parse(fixed)),
        orrinResearchFor,
        (check, ids) => {
          firstCallId = ids[0]!;
          return check === 1 ? verdicts(ids, { [ids[0]!]: problem }) : verdicts(ids);
        },
      );
      const result = await run.produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'published', held: true, revision: 1 });
      // At most two writer requests (the draft and its one repair) and one check for each draft.
      expect(run.calls).toHaveLength(2);
      expect(run.checks).toHaveLength(2);

      const [second] = run.calls.slice(1);
      expect(second!.request.system).toContain('REVISION AFTER AN ANSWER CHECK');
      expect(second!.request.user).toContain(problem);
      expect(second!.request.user).toContain('check_problems');
      expect(second!.request.user).toContain('previous_draft');
      expect(second!.request.user).toContain('public_research_passages');

      // The stored Scroll is the repaired draft, and the job names the run that wrote it.
      const stored = await database.db
        .selectFrom('content.asset_revisions as revision')
        .innerJoin('content.asset_provenance as provenance', (join) =>
          join
            .onRef('provenance.asset_id', '=', 'revision.asset_id')
            .onRef('provenance.revision', '=', 'revision.revision'),
        )
        .select(['revision.document', 'provenance.provenance'])
        .where('revision.asset_id', '=', assetId)
        .executeTakeFirstOrThrow();
      const document = stored.document as { stops: { kind: string; explain?: string }[] };
      expect(document.stops.filter((stop) => stop.kind === 'call_it')[0]!.explain).toBe(fixed.items[1]!.explain);
      const [job] = await jobsOf(key);
      expect(job!.writer_run_id).toBe(checkRepairRunId(job!.id));
      const production = (stored.provenance as { production: { runId: string; attemptIds: string[] } }).production;
      expect(production.runId).toBe(job!.writer_run_id);
      expect(production.attemptIds).toHaveLength(1);
      // Topic and coverage were still written: the publication verified the repair run's lineage.
      expect(
        await database.db
          .selectFrom('content.encounter_topics')
          .select('topic_id')
          .where('asset_id', '=', assetId)
          .execute(),
      ).toEqual([{ topic_id: TOPICS[key].topicId }]);
      expect(JSON.stringify(job!.outcomes)).not.toContain('coverage_');
      expect(JSON.stringify(job!.outcomes)).not.toContain('attribution_');

      const receipts = job!.outcomes as {
        role: string;
        kind: string;
        runId?: string;
        verdicts?: { id: string; call?: { prompt: string; options: string[]; answer: number; explain: string } }[];
      }[];
      expect(receipts.filter((receipt) => receipt.role === 'writer')).toHaveLength(1);
      expect(receipts.filter((receipt) => receipt.role === 'answer_check')).toHaveLength(2);
      expect(receipts).toContainEqual(expect.objectContaining({ role: 'checks', kind: 'draft_flagged' }));

      expect(await gate().list({ all: false })).toMatchObject([
        { answerCheck: { outcome: 'repaired', calls: 3, firstDraftFlags: [{ id: firstCallId, problem }] } },
      ]);
      const shown = await gate().show({ assetId, withSources: false });
      if (shown.kind !== 'shown') throw new Error('CI expected the text');
      expect(shown.text).toContain('Answer check: repaired');
      expect(shown.text).toContain(problem);
      // What was flagged is readable although that draft was not stored: the question, the options with
      // the marked one, and the explanation of the first draft.
      expect(shown.text).toContain('Question: Why is the north of Orrin warm in midsummer?');
      expect(shown.text).toContain('(marked correct)');
      expect(shown.text).toContain('Orrin is actually nearest to its star during the southern summer');
      const flaggedReceipt = receipts
        .find((receipt) => receipt.role === 'answer_check')
        ?.verdicts?.find((verdict) => verdict.id === firstCallId);
      expect([...flaggedReceipt!.call!.options].sort()).toEqual([
        'Its northern half leans toward Vael',
        'Orrin is closest to Vael at that moment',
      ]);
      expect(flaggedReceipt!.call!.options[flaggedReceipt!.call!.answer]).toBe('Its northern half leans toward Vael');
      // Only the flagged call, not the draft: no other call and no stop text rides on the job, and a list holds none.
      expect(JSON.stringify(job!.outcomes)).not.toContain('A beam hits the ground at a low angle');
      expect(JSON.stringify(job!.outcomes)).not.toContain('Meet Ray');
      expect(JSON.stringify(await gate().list({ all: false }))).not.toContain('Why is the north of Orrin warm');

      // All four runs are closed; none is left to resume.
      const firstDraft = receipts.find((receipt) => receipt.kind === 'draft_flagged') as { runId?: string };
      expect(firstDraft.runId).toBeDefined();
      expect(firstDraft.runId).not.toBe(job!.writer_run_id);
      const runs = await runStates([
        firstDraft.runId!,
        job!.writer_run_id,
        answerCheckRunId(job!.id, 1),
        answerCheckRunId(job!.id, 2),
      ]);
      expect(runs).toHaveLength(4);
      expect(runs.every((run) => run.closed)).toBe(true);
    });

    it('refuses a Scroll that is still flagged after the repair: nothing is stored, the take is spent and the problems are on the job', async () => {
      const problem = 'The explanation says the lean causes the seasons, but the marked option says distance does.';
      const run = fixtureProduction(
        database.db,
        () => answerWith(fixtureAuthoredV2()),
        orrinResearchFor,
        (_check, ids) => verdicts(ids, { [ids[1]!]: problem }),
      );
      const result = await run.produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'rejected', codes: ['answer_check_flagged'], take: 1 });
      // The bound: two writer requests and two checks, never more.
      expect(run.calls).toHaveLength(2);
      expect(run.checks).toHaveLength(2);
      expect(await assetOf(key)).toBeUndefined();
      expect(
        await database.db
          .selectFrom('content.asset_revisions')
          .select('revision')
          .where('asset_id', '=', assetId)
          .execute(),
      ).toEqual([]);

      const status = await statusOf(key);
      expect(status).toMatchObject({
        state: 'retryable',
        job: 'rejected',
        takes: 1,
        check: { outcome: 'flagged', flags: [{ problem }], firstDraftFlags: [{ problem }] },
      });
      // The refused take keeps no draft, so the flagged call is read here: question, options, marked answer, explanation.
      const flagged = status.check?.outcome === 'flagged' ? status.check.flags[0]!.call : undefined;
      expect(flagged!.prompt).toBe('A beam hits the ground at a low angle. What happens to the patch it lights?');
      expect(flagged!.explain).toContain('A slanted beam is stretched across the ground');
      expect(flagged!.options).toHaveLength(3);
      expect(flagged!.options[flagged!.answer]).toBe('It spreads over a wider patch');
      expect(planLibraryProduction([status], { interactiveFirst: false }).queue).toEqual([{ recipe: key, take: 2 }]);
      const [job] = await jobsOf(key);
      expect(
        (
          await runStates([
            job!.writer_run_id,
            checkRepairRunId(job!.id),
            answerCheckRunId(job!.id, 1),
            answerCheckRunId(job!.id, 2),
          ])
        ).every((state) => state.closed),
      ).toBe(true);
    });

    it('leaves the job as it was when publication is refused after a check repair, and the retry stores the repair', async () => {
      const draft = fixtureAuthoredV2();
      const fixed = JSON.parse(JSON.stringify(draft)) as { items: { type: string; explain?: string }[] };
      fixed.items[1]!.explain =
        'The north runs warm because its half of the planet leans toward Vael and the sunlight lands steeply there. Meanwhile Orrin sits nearest its star in the southern summer, when the north has winter.';
      const worker = fixtureProductionWorker(
        database,
        (sequence) => answerWith(sequence === 1 ? draft : AuthoredScrollV2.parse(fixed)),
        {
          research: (url) => Promise.resolve(orrinResearchFor(url)),
          checker: (check, ids) =>
            check === 1
              ? verdicts(ids, { [ids[0]!]: 'The key marks the nearness option, but the explanation says the lean.' })
              : verdicts(ids),
        },
      );
      // A harness that will not close the writer's run the first time, as a revoked scope would: the
      // closure is what publication needs, so the publication is refused after the repair was accepted.
      let refuse = true;
      const refusing: ProductionReasoningHarness = {
        readProductionRunAccounting: (scope, runId) => worker.harness.readProductionRunAccounting(scope, runId),
        proposeProduction: (input, abort) => worker.harness.proposeProduction(input, abort),
        closeProductionRun: (scope, run) =>
          refuse && run.state === 'completed'
            ? Promise.resolve('not_open')
            : worker.harness.closeProductionRun(scope, run),
      };
      const produce = worker.producer({ harness: refusing });

      expect(await produce(key, false, signal(), true, 1)).toMatchObject({ outcome: 'in_progress' });
      const [stuck] = await jobsOf(key);
      expect(stuck).toMatchObject({ state: 'writer' });
      // The job still names its own writer run, not the repair's, and nothing was stored.
      expect(stuck!.writer_run_id).not.toBe(checkRepairRunId(stuck!.id));
      expect(await assetOf(key)).toBeUndefined();
      expect(await jobsOf(key)).toHaveLength(1);
      expect(worker.writerCalls).toHaveLength(2);
      expect(worker.checkerCalls).toHaveLength(2);

      // Once publication is allowed, the retry answers from the ledger and stores the repair.
      refuse = false;
      expect(await produce(key, false, signal(), true, 1)).toMatchObject({ outcome: 'published', held: true });
      const [done] = await jobsOf(key);
      expect(done!.writer_run_id).toBe(checkRepairRunId(done!.id));
      expect(worker.writerCalls).toHaveLength(2);
      expect(worker.checkerCalls).toHaveLength(2);
      expect(await assetOf(key)).toEqual({ status: 'held', revision: 1 });
    });

    it('has no repair to give a draft the validator already repaired: a flag on it ends the job at once', async () => {
      const run = fixtureProduction(
        database.db,
        (sequence) => (sequence === 1 ? { kind: 'malformed' } : answerWith(fixtureAuthoredV2())),
        orrinResearchFor,
        (_check, ids) => verdicts(ids, { [ids[0]!]: 'The key and the explanation disagree about the cause.' }),
      );
      expect(await run.produce(key, false, signal())).toMatchObject({
        outcome: 'rejected',
        codes: ['answer_check_flagged'],
      });
      // Two writer requests were already spent (the draft and the validator's repair), so one check only.
      expect(run.calls).toHaveLength(2);
      expect(run.checks).toHaveLength(1);
    });

    it('ends the job when the repair a flag earned is refused by the validator, with no second repair', async () => {
      const run = fixtureProduction(
        database.db,
        (sequence) => (sequence === 1 ? answerWith(fixtureAuthoredV2()) : { kind: 'malformed' }),
        orrinResearchFor,
        (_check, ids) => verdicts(ids, { [ids[0]!]: 'The key and the explanation disagree about the cause.' }),
      );
      const result = await run.produce(key, false, signal());
      expect(result).toMatchObject({ outcome: 'rejected', codes: ['check_repair_invalid_output'] });
      expect(run.calls).toHaveLength(2);
      expect(run.checks).toHaveLength(1);
      expect(await assetOf(key)).toBeUndefined();
    });

    it.each([
      ['timeout_after_dispatch', 'outcome_unknown', 1],
      ['rate_limited', 'provider_failed', 1],
      ['malformed', 'invalid_output', 2],
    ] as const)(
      'holds the Scroll as unchecked when the checker fails (%s), shows it, and never releases it',
      async (kind, code, requests) => {
        const run = fixtureProduction(database.db, writing(), orrinResearchFor, () => ({ kind }));
        const result = await run.produce(key, false, signal());
        expect(result).toMatchObject({ outcome: 'published', held: true });
        // The checker is asked once, and once more when its reply is unusable (the harness's single repair).
        expect(run.checks).toHaveLength(requests);
        expect(run.calls).toHaveLength(1);

        expect(await assetOf(key)).toEqual({ status: 'held', revision: 1 });
        expect(await gate().list({ all: false })).toMatchObject([
          { state: 'held', answerCheck: { outcome: 'unchecked', code } },
        ]);
        const shown = await gate().show({ assetId, withSources: false });
        if (shown.kind !== 'shown') throw new Error('CI expected the text');
        expect(shown.text).toContain(`NOT CHECKED (${code})`);
        expect(await statusOf(key)).toMatchObject({ state: 'held', check: { outcome: 'unchecked', code } });
        // Nothing released it: the review row is held, undecided and unattributed.
        expect(
          await database.db
            .selectFrom('content.revision_reviews')
            .select(['state', 'decided_by'])
            .where('asset_id', '=', assetId)
            .execute(),
        ).toEqual([{ state: 'held', decided_by: null }]);
        // An attempt of unknown outcome stays in the ledger for `reasoning unknown`; it is not resent.
        const unknown = await database.db
          .selectFrom('reasoning.production_attempts')
          .select('role_id')
          .where('state', '=', 'unknown')
          .execute();
        expect(unknown).toEqual(kind === 'timeout_after_dispatch' ? [{ role_id: 'content.scroll-answer-check' }] : []);
      },
    );

    it('pauses when the budget is spent before the check, and finishes the job later without asking the writer again', async () => {
      let released = false;
      const worker = fixtureProductionWorker(database, () => answerWith(fixtureAuthoredV2()), {
        research: (url) => Promise.resolve(orrinResearchFor(url)),
        // The writer's request is allowed; the provider's quota is spent by the time the checker would be asked.
        quota: () => ({
          verdict: released || worker.writerCalls.length === 0 ? 'not_applicable' : 'unavailable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        }),
      });
      const produce = worker.producer();
      const paused = await produce(key, false, signal(), true, 1);
      expect(paused).toMatchObject({ outcome: 'paused', codes: ['quota_unavailable'] });
      expect(worker.writerCalls).toHaveLength(1);
      expect(worker.checkerCalls).toHaveLength(0);
      expect(await statusOf(key)).toMatchObject({ state: 'running', job: 'writer' });

      released = true;
      expect(await produce(key, false, signal(), true, 1)).toMatchObject({ outcome: 'published', held: true });
      // The writer's kept answer was read from the ledger: no second writer request was paid for.
      expect(worker.writerCalls).toHaveLength(1);
      expect(worker.checkerCalls).toHaveLength(1);
      expect(await statusOf(key)).toMatchObject({ state: 'held', check: { outcome: 'passed' } });
    });
  });

  describe('a recipe of the first waves (cardiac-cycle)', () => {
    const key = 'cardiac-cycle';

    it('is produced as a plain Scroll with calls, no myth and its landmark, checked, and held for the read', async () => {
      const run = fixtureProduction(database.db, () => answerWith(plainOrrin()), orrinResearchFor);
      expect(await run.produce(key, false, signal())).toMatchObject({ outcome: 'published', held: true });
      expect(run.checks).toHaveLength(1);
      const stored = await database.db
        .selectFrom('content.asset_revisions')
        .select('document')
        .where('asset_id', '=', TOPICS[key].assetId)
        .executeTakeFirstOrThrow();
      const document = stored.document as {
        stage?: unknown;
        misconception: unknown;
        landmark: unknown;
        stops: { kind: string }[];
      };
      expect(document.stage).toBeUndefined();
      expect(document.misconception).toEqual({ kind: 'none' });
      expect(document.landmark).toEqual({ key: 'the-beating-pump', name: 'The Beating Pump' });
      expect(document.stops.filter((stop) => stop.kind !== 'read')).toHaveLength(3);
      expect(await statusOf(key)).toMatchObject({
        state: 'held',
        heldRevision: 1,
        check: { outcome: 'passed', calls: 3 },
      });
    });
  });
});
