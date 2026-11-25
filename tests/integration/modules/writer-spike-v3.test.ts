import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@knowscroll/backend/infrastructure/ids';
import { makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  guardedModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  reasoningOperatorFor,
  type HarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { runSpikeJobs, SPIKE_MODEL } from '../../../packages/backend/src/modules/content/production/spike-run.js';
import {
  makeWriterSpikeV3,
  spikeJobLabel,
  type SpikeJobV3,
  type SpikeResultV3,
} from '../../../packages/backend/src/modules/content/production/spike-v3/run.js';
import {
  fixtureProseV3,
  fixtureReplyV3,
  fixtureStagingV3,
} from '../../../packages/backend/src/modules/content/production/spike-v3/writer-v3.fixture.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { fixtureModel, fixtureSettings, signal, silent } from '../support/fixture-model.js';
import { orrinResearchFor } from '../support/scroll-v2.js';
import type { FixtureCall, FixtureScenario } from '../support/fixture-model-port.js';

// The model is a labelled CI fixture and the essay is the authored Orrin fixture: no provider, no product content.
const answer = (
  value: unknown,
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens: number },
): FixtureScenario => ({
  kind: 'success',
  text: JSON.stringify(value),
  ...(usage === undefined ? {} : { usage }),
});

/** Which reply a request asks for, from the instructions it carries. */
const stepOf = (call: FixtureCall): 'one' | 'prose' | 'staging' => {
  const system = call.request.system ?? '';
  if (system.includes('You stage one Scroll')) return 'staging';
  return system.includes('PICTURES.') ? 'one' : 'prose';
};

/** The fixture essay with its first paragraph opening by pointing back, which the compile refuses. */
function pointingBack(): unknown {
  const draft = JSON.parse(JSON.stringify(fixtureReplyV3())) as { items: { text?: string }[] };
  draft.items[1] = { ...draft.items[1], text: `This ${draft.items[1]?.text ?? ''}` };
  return draft;
}

describe('the v3 writer spike (CI fixture model + real PostgreSQL; no provider network)', () => {
  let database: TestDatabase<Database>;
  let rawDir: string;
  beforeEach(async () => {
    database = await createTestDatabase<Database>('writer_spike_v3');
    await sql`update reasoning.production_scopes set enabled=true where id='scroll-supply'`.execute(database.db);
    rawDir = await mkdtemp(join(tmpdir(), 'ks-spike-v3-raw-'));
  });
  afterEach(async () => {
    await database.drop();
    await rm(rawDir, { recursive: true, force: true });
  });

  function setup(script: (call: FixtureCall) => FixtureScenario, settings: HarnessSettings = fixtureSettings) {
    const fixture = fixtureModel((_sequence, call) => script(call), { label: 'writer-spike-v3-CI-fixture' });
    const model = guardedModelPort({ ...fixture, provider: 'minimax', model: SPIKE_MODEL });
    const withScope = makeWithProductionScope(database.db, { enabled: true, lockTimeoutMs: 5000 });
    const harness = makeProductionReasoningHarness(
      postgresProductionHarnessPorts({
        db: database.db,
        withProductionScope: withScope,
        enabled: true,
        model,
        logEvent: silent,
        settings,
      }),
    );
    const reasoning = reasoningOperatorFor(database.db, silent);
    // The same wiring as the operator command: findings and kept answers come from the harness's own records.
    const spike = makeWriterSpikeV3({
      harness,
      withScope,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      model: model.model,
      spikeId: 'ci-spike',
      rawDir,
      // A recipe with two pages (`dns-lookup` since #790) gets two different pages: the same page twice is refused as a duplicate.
      research: (url) => Promise.resolve(orrinResearchFor(url)),
      newRunId: uuidv7,
      findingsOf: async (attemptId) => {
        const shown = await reasoning.showRejectedAnswer(attemptId);
        return shown.kind === 'found' ? shown.record.issues.map(({ code, path }) => ({ code, path })) : [];
      },
      rejectedTextOf: async (attemptId) => {
        const shown = await reasoning.showRejectedAnswer(attemptId);
        return shown.kind === 'found' ? shown.record.answerText : undefined;
      },
    });
    return { fixture, spike };
  }

  const attempts = () =>
    database.db
      .selectFrom('reasoning.production_attempts')
      .select(['step', 'state', 'model', 'run_id'])
      .orderBy('reserved_at')
      .execute();
  const runs = () =>
    database.db
      .selectFrom('reasoning.production_runs')
      .select(['id', 'purpose', 'state', 'policy_version'])
      .orderBy('id')
      .execute();
  const contentRows = async () =>
    (
      await sql<{ jobs: string; revisions: string }>`
        select (select count(*) from content.scroll_production_runs) as jobs,
               (select count(*) from content.asset_revisions) as revisions`.execute(database.db)
    ).rows[0];

  it('arm a: accounts one first-take Scroll from the real ledger, writes its raw reply and stores nothing in a content table', async () => {
    const before = await contentRows();
    const p = setup(() => answer(fixtureReplyV3(), { inputTokens: 4321, outputTokens: 8765, reasoningTokens: 5432 }));
    const { line, document } = await p.spike.writeOne('seasons', 'a', signal());

    expect(line).toMatchObject({
      key: 'seasons',
      arm: 'a',
      outcome: 'accepted_first_take',
      requests: 1,
      tokens: { input: 4321, output: 8765, thinking: 5432, complete: true },
    });
    expect(line.steps).toHaveLength(1);
    expect(line.steps[0]).toMatchObject({
      step: 'one',
      roleVersion: 'scroll-writer-v3a.v4',
      findings: [],
      models: [SPIKE_MODEL],
    });
    expect(document?.document.schemaVersion).toBe('scroll-document.v3');
    expect(p.fixture.calls).toHaveLength(1);
    // The request carried the v3 instructions and the brief and passages, as data.
    const request = p.fixture.calls[0]?.request;
    expect(request?.system).toContain('PICTURES.');
    expect(request?.system).toContain('THE ESSAY.');
    expect(request?.user).toContain('[e1]');
    const runId = line.steps[0]?.runId;
    expect(await attempts()).toEqual([{ step: 'primary', state: 'succeeded', model: SPIKE_MODEL, run_id: runId }]);
    expect(await runs()).toEqual([
      { id: runId, purpose: 'scroll-writer-spike', state: 'completed', policy_version: 'scroll-spike.v3' },
    ]);
    expect(await contentRows()).toEqual(before);
    expect(await readdir(join(rawDir, 'ci-spike'))).toEqual(['seasons.a.one.1.json']);
  });

  it('arm a: sends the one repair with the fixed findings, and keeps the refused answer in the raw folder', async () => {
    const p = setup((call) => (call.sequence === 1 ? answer(pointingBack()) : answer(fixtureReplyV3())));
    const { line } = await p.spike.writeOne('seasons', 'a', signal());

    expect(line).toMatchObject({ outcome: 'accepted_after_repair', requests: 2 });
    expect(line.steps[0]?.findings).toEqual([
      expect.objectContaining({ attempt: 1, code: 'first_beat_points_back', path: 'items[1].text' }),
    ]);
    const repair = p.fixture.calls[1]?.request;
    expect(repair?.system).toContain('first_beat_points_back');
    expect(repair?.user).toContain('<previous-answer>');
    expect((await attempts()).map((attempt) => [attempt.step, attempt.state])).toEqual([
      ['primary', 'succeeded'],
      ['repair', 'succeeded'],
    ]);
    expect((await readdir(join(rawDir, 'ci-spike'))).sort()).toEqual(['seasons.a.one.1.json', 'seasons.a.one.2.json']);
    const refused = JSON.parse(await readFile(join(rawDir, 'ci-spike', 'seasons.a.one.1.json'), 'utf8')) as {
      text: string;
    };
    expect(JSON.parse(refused.text)).toEqual(pointingBack());
  });

  it('arm b: runs the prose and then the staging as two runs of the ledger, each closed, with both raw replies written', async () => {
    const before = await contentRows();
    const p = setup((call) => (stepOf(call) === 'prose' ? answer(fixtureProseV3()) : answer(fixtureStagingV3())));
    const { line, document } = await p.spike.writeOne('dns-lookup', 'b', signal());

    expect(line).toMatchObject({ arm: 'b', outcome: 'accepted_first_take', requests: 2 });
    expect(line.steps.map((step) => step.step)).toEqual(['prose', 'staging']);
    const [proseRun, stagingRun] = line.steps.map((step) => step.runId);
    expect(proseRun).not.toBe(stagingRun);
    expect(document?.document.pictures).toHaveLength(2);
    // The staging request holds the numbered prose and no brief; the prose request holds no picture rules.
    expect(p.fixture.calls.map(stepOf)).toEqual(['prose', 'staging']);
    expect(p.fixture.calls[0]?.request.system).not.toContain('PICTURES.');
    expect(p.fixture.calls[1]?.request.user).toContain('P1 ');
    expect(p.fixture.calls[1]?.request.user).not.toContain('<production_brief');
    expect(await attempts()).toEqual([
      { step: 'primary', state: 'succeeded', model: SPIKE_MODEL, run_id: proseRun },
      { step: 'primary', state: 'succeeded', model: SPIKE_MODEL, run_id: stagingRun },
    ]);
    expect(await runs()).toEqual([
      { id: proseRun, purpose: 'scroll-writer-spike', state: 'completed', policy_version: 'scroll-spike.v3' },
      { id: stagingRun, purpose: 'scroll-writer-spike', state: 'completed', policy_version: 'scroll-spike.v3' },
    ]);
    expect(await contentRows()).toEqual(before);
    expect((await readdir(join(rawDir, 'ci-spike'))).sort()).toEqual([
      'dns-lookup.b.prose.1.json',
      'dns-lookup.b.staging.1.json',
    ]);
  });

  it('arm b: a staging refused twice is rejected, with both findings kept, nothing more sent and its run cancelled', async () => {
    const draft = JSON.parse(JSON.stringify(fixtureStagingV3())) as { stage: { para: number }[] };
    draft.stage[3] = { ...draft.stage[3], para: 12 };
    const p = setup((call) => (stepOf(call) === 'prose' ? answer(fixtureProseV3()) : answer(draft)));
    const { line, document } = await p.spike.writeOne('seasons', 'b', signal());

    expect(line).toMatchObject({ outcome: 'rejected', requests: 3 });
    expect(line.steps[1]?.findings.map((finding) => [finding.attempt, finding.code])).toEqual([
      [1, 'stage_para_unknown'],
      [2, 'stage_para_unknown'],
    ]);
    expect(document).toBeUndefined();
    expect(p.fixture.calls).toHaveLength(3);
    expect((await runs()).map((run) => run.state)).toEqual(['completed', 'cancelled']);
  });

  it('never resends an attempt whose outcome is unknown, and leaves its run open for reconciliation', async () => {
    const p = setup(() => ({ kind: 'timeout_after_dispatch' }));
    const { line } = await p.spike.writeOne('seasons', 'b', signal());
    expect(line.outcome).toBe('unknown');
    expect(p.fixture.calls).toHaveLength(1);
    expect((await runs())[0]?.state).toBe('admitted');
    expect((await attempts()).map((attempt) => attempt.state)).toEqual(['unknown']);
  });

  it('stops at the production scope’s own request cap: the capped job sends nothing and the rest of the batch never starts', async () => {
    const capped: HarnessSettings = {
      ...fixtureSettings,
      caps: { ...fixtureSettings.caps, scope: { requestsPerDay: 1, tokensPerDay: 100_000_000 } },
    };
    const p = setup(() => answer(fixtureReplyV3()), capped);
    const seen: SpikeResultV3[] = [];
    const jobs: SpikeJobV3[] = [
      { key: 'seasons', arm: 'a' },
      { key: 'dns-lookup', arm: 'a' },
      { key: 'seasons', arm: 'b' },
    ];
    const summary = await runSpikeJobs(
      jobs,
      (job) => p.spike.writeOne(job.key, job.arm, signal()),
      (result) => {
        seen.push(result);
        return Promise.resolve();
      },
      1,
    );
    expect(seen.map((result) => result.line.outcome)).toEqual(['accepted_first_take', 'paused']);
    expect(seen[1]?.line.requests).toBe(0);
    expect(seen[1]?.line.code).toContain('requests');
    expect(summary.completed).toBe(2);
    expect(summary.notStarted.map(spikeJobLabel)).toEqual(['seasons.b']);
    expect(p.fixture.calls).toHaveLength(1);
  });
});
