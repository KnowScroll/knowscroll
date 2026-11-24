import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchRefusal, type ResearchPage } from '../../../../infrastructure/research/public-pages.js';
import type {
  ProductionAttemptAccounting,
  ProductionProposeInput,
  ProductionReasoningHarness,
  ProductionScopeTx,
  ProposeOutcome,
  WithProductionScope,
} from '../../../../reasoning/public.js';
import { fixtureResearchPageAt } from '../orrin.fixture.js';
import { runSpikeJobs, SPIKE_MODEL } from '../spike-run.js';
import { spikeJobLabel, makeWriterSpikeV3, type SpikeJobV3, type SpikeResultV3 } from './run.js';
import { fixtureProseV3, fixtureReplyV3, fixtureStagingV3 } from './writer-v3.fixture.js';

// A labelled fixture harness: it never reaches a provider. It stands in for the real one by running each role's own
// output schema over the answers a test scripts, one for the primary attempt and one for the repair, as the harness does.

type Step = 'one' | 'prose' | 'staging';
const stepOfRole = (version: string): Step =>
  version.startsWith('scroll-stager') ? 'staging' : version.startsWith('scroll-writer-v3b') ? 'prose' : 'one';

interface Script {
  /** The answers of each step: the first is the primary attempt's, the second the repair's. */
  readonly answers: Partial<Record<Step, readonly unknown[]>>;
  /** Replaces what the harness answers for a step, such as an unknown attempt. */
  readonly override?: Partial<Record<Step, (runId: string) => ProposeOutcome<unknown>>>;
  /** The model the ledger says each attempt used. */
  readonly model?: string;
}

const usage = { inputTokens: 4000, outputTokens: 9000, reasoningTokens: 6000, cachedTokens: null };

function wire(script: Script) {
  const attemptsOf = new Map<string, ProductionAttemptAccounting[]>();
  const refused = new Map<string, string>();
  const findings = new Map<string, { code: string; path: string }[]>();
  const calls = {
    proposed: [] as {
      runId: string;
      role: string;
      version: string;
      items: readonly { kind: string; text: string }[];
    }[],
    closed: [] as { runId: string; state: string }[],
  };
  const harness: ProductionReasoningHarness = {
    proposeProduction: <T>(input: ProductionProposeInput<T>) => {
      const step = stepOfRole(input.role.version);
      calls.proposed.push({
        runId: input.run.id,
        role: input.role.id,
        version: input.role.version,
        items: input.context.items,
      });
      const attempts: ProductionAttemptAccounting[] = [];
      attemptsOf.set(input.run.id, attempts);
      const record = (index: number): string => {
        const id = `${input.run.id}-att${String(index + 1)}`;
        attempts.push({
          attemptId: id,
          step: index === 0 ? 'primary' : 'repair',
          state: 'succeeded',
          provider: 'minimax',
          model: script.model ?? SPIKE_MODEL,
          usage: { ...usage, inputTokens: usage.inputTokens + index * 1000 },
        });
        return id;
      };
      const override = script.override?.[step];
      if (override !== undefined) {
        record(0);
        return Promise.resolve(override(input.run.id) as ProposeOutcome<T>);
      }
      const answers = script.answers[step] ?? [];
      const allowed = input.limits?.allowRepair === false ? 1 : 2;
      let lastId = '';
      for (let index = 0; index < Math.min(allowed, answers.length); index += 1) {
        lastId = record(index);
        const parsed = input.role.outputSchema.safeParse(answers[index]);
        if (parsed.success)
          return Promise.resolve({
            kind: 'proposed',
            output: parsed.data,
            attemptId: lastId,
            usage,
            repaired: index === 1,
            reconciled: false,
          } as ProposeOutcome<T>);
        refused.set(lastId, JSON.stringify(answers[index]));
        findings.set(
          lastId,
          parsed.error.issues.map((issue) => ({
            code: String(
              (issue.code === 'custom' ? (issue.params as { safeCode?: string } | undefined)?.safeCode : undefined) ??
                issue.code,
            ),
            path: issue.path.join('.'),
          })),
        );
      }
      return Promise.resolve({ kind: 'invalid_output', attemptId: lastId, reason: 'schema' } as ProposeOutcome<T>);
    },
    readProductionRunAccounting: (_scope, runId) =>
      Promise.resolve({ kind: 'accounted', attempts: attemptsOf.get(runId) ?? [] }),
    closeProductionRun: (_scope, run) => {
      calls.closed.push(run);
      return Promise.resolve('closed');
    },
  };
  const withScope: WithProductionScope = async (_authority, work) => ({
    kind: 'entered',
    value: await work({} as ProductionScopeTx),
  });
  return { harness, withScope, calls, refused, findings };
}

const never = new AbortController().signal;

describe('the v3 writer spike: one recipe in one arm', () => {
  let rawDir: string;
  beforeEach(async () => {
    rawDir = await mkdtemp(join(tmpdir(), 'ks-spike-v3-'));
  });
  afterEach(async () => {
    await rm(rawDir, { recursive: true, force: true });
  });

  function setup(
    script: Script,
    options: { model?: string; raw?: boolean; research?: (url: string) => Promise<ResearchPage> } = {},
  ) {
    const wired = wire(script);
    let counter = 0;
    const spike = makeWriterSpikeV3({
      harness: wired.harness,
      withScope: wired.withScope,
      authority: { scopeId: 'scroll-supply', generation: 1 },
      model: options.model ?? SPIKE_MODEL,
      spikeId: 'ci-spike',
      research: options.research ?? ((url) => Promise.resolve(fixtureResearchPageAt(url))),
      newRunId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
      findingsOf: (attemptId) => Promise.resolve(wired.findings.get(attemptId) ?? []),
      rejectedTextOf: (attemptId) => Promise.resolve(wired.refused.get(attemptId)),
      ...(options.raw === false ? {} : { rawDir }),
    });
    return { ...wired, spike };
  }

  /** The fixture reply with its first paragraph opening by pointing back, which the compile refuses. */
  const pointingBack = (): unknown => {
    const draft = JSON.parse(JSON.stringify(fixtureReplyV3())) as { items: { text?: string }[] };
    draft.items[1] = { ...draft.items[1], text: `This ${draft.items[1]?.text ?? ''}` };
    return draft;
  };

  it('arm a: accepts a first-take Scroll in one run, with its measures, tokens and model, and closes the run', async () => {
    const { spike, calls } = setup({ answers: { one: [fixtureReplyV3()] } });
    const { line, document } = await spike.writeOne('seasons', 'a', never);
    expect(line).toMatchObject({
      key: 'seasons',
      spikeId: 'ci-spike',
      arm: 'a',
      outcome: 'accepted_first_take',
      requests: 1,
      tokens: { input: 4000, output: 9000, thinking: 6000, complete: true },
    });
    expect(line.steps).toHaveLength(1);
    expect(line.steps[0]).toMatchObject({
      step: 'one',
      roleVersion: 'scroll-writer-v3a.v2',
      outcome: 'accepted_first_take',
      requests: 1,
      findings: [],
      models: [SPIKE_MODEL],
    });
    expect(line.document).toMatchObject({
      sections: 3,
      beats: 11,
      shows: 4,
      links: 2,
      controls: 1,
      asides: 1,
      plannedKinds: ['statement', 'grid'],
      writtenKinds: ['statement', 'grid'],
      picturesByKind: { statement: 1, grid: 1 },
    });
    expect(line.document?.words).toBeGreaterThanOrEqual(350);
    expect(line.document?.takeawayWords).toBeGreaterThan(10);
    expect(line.wallMs.total).toBeGreaterThanOrEqual(0);
    expect(document?.document.schemaVersion).toBe('scroll-document.v3');
    expect(Object.keys(document?.citations ?? {})).toContain('takeaway');
    expect(calls.proposed).toHaveLength(1);
    expect(calls.proposed[0]).toMatchObject({ role: 'content.scroll-writer', version: 'scroll-writer-v3a.v2' });
    expect(calls.proposed[0]?.items.map((item) => item.kind)).toEqual(['production_brief', 'public_research_passages']);
    expect(calls.closed).toEqual([{ runId: line.steps[0]?.runId, state: 'completed' }]);
    expect(JSON.stringify(line)).not.toContain('Orrin');
  });

  it('arm a: repairs once and reports the findings that caused the repair, at the model’s own item', async () => {
    const { spike } = setup({ answers: { one: [pointingBack(), fixtureReplyV3()] } });
    const { line, document } = await spike.writeOne('seasons', 'a', never);
    expect(line.outcome).toBe('accepted_after_repair');
    expect(line.requests).toBe(2);
    expect(line.tokens).toEqual({ input: 9000, output: 18_000, thinking: 12_000, complete: true });
    expect(line.steps[0]?.findings).toEqual([{ attempt: 1, code: 'first_beat_points_back', path: 'items.1.text' }]);
    expect(document).toBeDefined();
  });

  it('arm a: rejects a Scroll refused twice, with the findings of both answers, and keeps no document', async () => {
    const { spike, calls } = setup({ answers: { one: [pointingBack(), pointingBack()] } });
    const { line, document } = await spike.writeOne('seasons', 'a', never);
    expect(line).toMatchObject({ outcome: 'rejected', code: 'schema', requests: 2, document: null });
    expect(line.steps[0]?.findings.map((finding) => [finding.attempt, finding.code])).toEqual([
      [1, 'first_beat_points_back'],
      [2, 'first_beat_points_back'],
    ]);
    expect(document).toBeUndefined();
    expect(calls.closed).toEqual([{ runId: line.steps[0]?.runId, state: 'cancelled' }]);
  });

  it('arm b: runs the prose and then the staging, two runs with their own ids, both on the line and both closed', async () => {
    const { spike, calls } = setup({ answers: { prose: [fixtureProseV3()], staging: [fixtureStagingV3()] } });
    const { line, document } = await spike.writeOne('seasons', 'b', never);
    expect(line).toMatchObject({ arm: 'b', outcome: 'accepted_first_take', requests: 2 });
    expect(line.steps.map((step) => [step.step, step.roleVersion, step.outcome])).toEqual([
      ['prose', 'scroll-writer-v3b.v2', 'accepted_first_take'],
      ['staging', 'scroll-stager-v3.v2', 'accepted_first_take'],
    ]);
    expect(new Set(line.steps.map((step) => step.runId)).size).toBe(2);
    expect(line.tokens).toEqual({ input: 8000, output: 18_000, thinking: 12_000, complete: true });
    expect(line.document).toMatchObject({ sections: 3, beats: 11, writtenKinds: ['statement', 'grid'] });
    expect(document?.document.pictures).toHaveLength(2);
    expect(calls.proposed.map((call) => [call.role, call.version])).toEqual([
      ['content.scroll-writer', 'scroll-writer-v3b.v2'],
      ['content.scroll-stager', 'scroll-stager-v3.v2'],
    ]);
    // The staging request carries the numbered prose, the passages and the plan, and no brief.
    expect(calls.proposed[1]?.items.map((item) => item.kind)).toEqual([
      'written_prose',
      'public_research_passages',
      'scroll_plan',
    ]);
    expect(calls.proposed[1]?.items[0]?.text).toContain('P1 ');
    expect(calls.closed.map((close) => close.state)).toEqual(['completed', 'completed']);
    expect(calls.closed.map((close) => close.runId)).toEqual(line.steps.map((step) => step.runId));
  });

  it('arm b: is accepted after repair when either step needed one', async () => {
    const draft = JSON.parse(JSON.stringify(fixtureStagingV3())) as { stage: { show?: { picture: number } }[] };
    draft.stage[1] = { ...draft.stage[1], show: { picture: 3 } };
    const { spike } = setup({ answers: { prose: [fixtureProseV3()], staging: [draft, fixtureStagingV3()] } });
    const { line } = await spike.writeOne('seasons', 'b', never);
    expect(line.outcome).toBe('accepted_after_repair');
    expect(line.requests).toBe(3);
    expect(line.steps.map((step) => step.outcome)).toEqual(['accepted_first_take', 'accepted_after_repair']);
    expect(line.steps[1]?.findings).toEqual([
      { attempt: 1, code: 'show_picture_unknown', path: 'stage.1.show.picture' },
    ]);
  });

  it('arm b: names the prose step’s outcome and sends no staging when the prose is refused', async () => {
    const prose = JSON.parse(JSON.stringify(fixtureProseV3())) as { items: { text?: string }[] };
    prose.items[1] = { ...prose.items[1], text: `This ${prose.items[1]?.text ?? ''}` };
    const { spike, calls } = setup({ answers: { prose: [prose, prose], staging: [fixtureStagingV3()] } });
    const { line, document } = await spike.writeOne('seasons', 'b', never);
    expect(line).toMatchObject({ outcome: 'rejected', requests: 2 });
    expect(line.steps.map((step) => step.step)).toEqual(['prose']);
    expect(calls.proposed).toHaveLength(1);
    expect(calls.closed).toEqual([{ runId: line.steps[0]?.runId, state: 'cancelled' }]);
    expect(document).toBeUndefined();
  });

  it('arm b: rejects when the staging is refused twice, keeps the accepted prose step on the line and closes both runs', async () => {
    const draft = JSON.parse(JSON.stringify(fixtureStagingV3())) as { stage: { para: number }[] };
    draft.stage[3] = { ...draft.stage[3], para: 12 };
    const { spike, calls } = setup({ answers: { prose: [fixtureProseV3()], staging: [draft, draft] } });
    const { line, document } = await spike.writeOne('seasons', 'b', never);
    expect(line).toMatchObject({ outcome: 'rejected', code: 'schema', requests: 3, document: null });
    expect(line.steps.map((step) => [step.step, step.outcome])).toEqual([
      ['prose', 'accepted_first_take'],
      ['staging', 'rejected'],
    ]);
    expect(line.steps[1]?.findings.map((finding) => [finding.attempt, finding.code, finding.path])).toEqual([
      [1, 'stage_para_unknown', 'stage.3.para'],
      [2, 'stage_para_unknown', 'stage.3.para'],
    ]);
    expect(document).toBeUndefined();
    expect(calls.closed.map((close) => close.state)).toEqual(['completed', 'cancelled']);
  });

  it('never resends an unknown attempt, leaves its run open, and sends no staging after an unknown prose', async () => {
    const { spike, calls } = setup({
      answers: {},
      override: { prose: (runId) => ({ kind: 'unknown', attemptId: `${runId}-att1` }) },
    });
    const { line } = await spike.writeOne('seasons', 'b', never);
    expect(line.outcome).toBe('unknown');
    expect(calls.proposed).toHaveLength(1);
    expect(calls.closed).toEqual([]);
  });

  it('reports a reply from another model as a mismatch, for the harness and for the ledger, and keeps no document', async () => {
    const harnessSaid = setup({
      answers: {},
      override: { one: (runId) => ({ kind: 'failed', attemptId: `${runId}-att1`, code: 'MODEL_MISMATCH' }) },
    });
    expect((await harnessSaid.spike.writeOne('seasons', 'a', never)).line).toMatchObject({
      outcome: 'model_mismatch',
      code: 'MODEL_MISMATCH',
    });
    const ledgerSaid = setup({ answers: { one: [fixtureReplyV3()] }, model: 'MiniMax-M3' });
    const { line, document } = await ledgerSaid.spike.writeOne('seasons', 'a', never);
    expect(line).toMatchObject({ outcome: 'model_mismatch', code: 'attempt_model_differs', document: null });
    expect(line.steps[0]?.models).toEqual(['MiniMax-M3']);
    expect(document).toBeUndefined();
    // The prose step of arm b too: no staging is sent after another model answered the prose.
    const arm = setup({ answers: { prose: [fixtureProseV3()], staging: [fixtureStagingV3()] }, model: 'MiniMax-M3' });
    expect((await arm.spike.writeOne('seasons', 'b', never)).line.outcome).toBe('model_mismatch');
    expect(arm.calls.proposed).toHaveLength(1);
  });

  it('makes no call at all when the harness is configured with another model', async () => {
    const { spike, calls } = setup({ answers: { one: [fixtureReplyV3()] } }, { model: 'MiniMax-M3' });
    const { line } = await spike.writeOne('seasons', 'a', never);
    expect(line).toMatchObject({ outcome: 'model_mismatch', code: 'configured_model_not_allowed', requests: 0 });
    expect(calls.proposed).toHaveLength(0);
  });

  it('makes no model call when the research is refused, and none when it holds too little to cite', async () => {
    const refused = setup(
      { answers: { one: [fixtureReplyV3()] } },
      { research: () => Promise.reject(new ResearchRefusal('soft_404')) },
    );
    expect((await refused.spike.writeOne('seasons', 'a', never)).line).toMatchObject({
      outcome: 'research_failed',
      code: 'soft_404',
    });
    expect(refused.calls.proposed).toHaveLength(0);
    const thin = setup(
      { answers: { one: [fixtureReplyV3()] } },
      {
        research: () => {
          const page = fixtureResearchPageAt('https://spaceplace.nasa.gov/seasons/en/');
          return Promise.resolve({ ...page, passages: page.passages.slice(0, 1) });
        },
      },
    );
    expect((await thin.spike.writeOne('seasons', 'a', never)).line.outcome).toMatch(
      /evidence_insufficient|research_failed/u,
    );
    expect(thin.calls.proposed).toHaveLength(0);
  });

  describe('the raw replies', () => {
    const readRaw = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(rawDir, 'ci-spike', name), 'utf8')) as Record<string, unknown>;

    it('are one file for each paid attempt, named by recipe, arm, step and attempt, in the folder of the spike', async () => {
      const { spike } = setup({ answers: { one: [pointingBack(), fixtureReplyV3()] } });
      const { line } = await spike.writeOne('seasons', 'a', never);
      expect((await readdir(join(rawDir, 'ci-spike'))).sort()).toEqual([
        'seasons.a.one.1.json',
        'seasons.a.one.2.json',
      ]);
      expect(line.rawFiles).toEqual(['seasons.a.one.1.json', 'seasons.a.one.2.json']);
      expect(line.rawFilesFailed).toBe(0);
      const first = await readRaw('seasons.a.one.1.json');
      expect(first).toMatchObject({
        key: 'seasons',
        arm: 'a',
        step: 'one',
        attempt: 1,
        attemptId: line.steps[0]?.attempts[0]?.attemptId,
        state: 'succeeded',
        model: SPIKE_MODEL,
      });
      // The refused attempt holds the kept refused answer; the accepted one the output, re-serialised.
      expect(JSON.parse(first.text as string)).toEqual(pointingBack());
      const second = await readRaw('seasons.a.one.2.json');
      expect(JSON.parse(second.text as string)).toEqual(JSON.parse(JSON.stringify(fixtureReplyV3())));
    });

    it('name both steps of arm b, and hold the staging answer beside the prose', async () => {
      const { spike } = setup({ answers: { prose: [fixtureProseV3()], staging: [fixtureStagingV3()] } });
      await spike.writeOne('dns-lookup', 'b', never);
      expect((await readdir(join(rawDir, 'ci-spike'))).sort()).toEqual([
        'dns-lookup.b.prose.1.json',
        'dns-lookup.b.staging.1.json',
      ]);
      const staging = await readRaw('dns-lookup.b.staging.1.json');
      expect(staging).toMatchObject({ arm: 'b', step: 'staging', attempt: 1 });
      expect(Object.keys(JSON.parse(staging.text as string) as object)).toEqual(['pictures', 'stage']);
    });

    it('hold null for a refused attempt whose answer the harness did not keep', async () => {
      const wired = wire({ answers: { one: [pointingBack(), pointingBack()] } });
      wired.refused.clear();
      let counter = 0;
      const spike = makeWriterSpikeV3({
        harness: wired.harness,
        withScope: wired.withScope,
        authority: { scopeId: 'scroll-supply', generation: 1 },
        model: SPIKE_MODEL,
        spikeId: 'ci-spike',
        research: (url) => Promise.resolve(fixtureResearchPageAt(url)),
        newRunId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
        rejectedTextOf: () => Promise.resolve(undefined),
        rawDir,
      });
      await spike.writeOne('seasons', 'a', never);
      expect((await readRaw('seasons.a.one.1.json')).text).toBeNull();
    });

    it('are not written without a raw folder, and a spike id that could leave the folder is refused', async () => {
      const { spike } = setup({ answers: { one: [fixtureReplyV3()] } }, { raw: false });
      const { line } = await spike.writeOne('seasons', 'a', never);
      expect(line.rawFiles).toEqual([]);
      expect(await readdir(rawDir)).toEqual([]);
      const wired = wire({ answers: {} });
      expect(() =>
        makeWriterSpikeV3({
          harness: wired.harness,
          withScope: wired.withScope,
          authority: { scopeId: 'scroll-supply', generation: 1 },
          model: SPIKE_MODEL,
          spikeId: '../../etc',
          newRunId: () => 'x',
          rawDir,
        }),
      ).toThrow(/spike id/u);
    });

    it('count a file that cannot be written, and never fail the run for it', async () => {
      const wired = wire({ answers: { one: [fixtureReplyV3()] } });
      const spike = makeWriterSpikeV3({
        harness: wired.harness,
        withScope: wired.withScope,
        authority: { scopeId: 'scroll-supply', generation: 1 },
        model: SPIKE_MODEL,
        spikeId: 'ci-spike',
        research: (url) => Promise.resolve(fixtureResearchPageAt(url)),
        newRunId: () => '00000000-0000-4000-8000-000000000001',
        // A folder under a file cannot be made.
        rawDir: join(rawDir, 'ci-spike-is-a-file.txt', 'nested'),
      });
      await writeFile(join(rawDir, 'ci-spike-is-a-file.txt'), 'x');
      const { line } = await spike.writeOne('seasons', 'a', never);
      expect(line.outcome).toBe('accepted_first_take');
      expect(line.rawFilesFailed).toBe(1);
      expect(line.rawFiles).toEqual([]);
    });
  });
});

const result = (
  key: SpikeJobV3['key'],
  arm: SpikeJobV3['arm'],
  outcome: SpikeResultV3['line']['outcome'],
): SpikeResultV3 => ({ line: { key, arm, outcome } }) as unknown as SpikeResultV3;

describe('the v3 spike: a batch of recipes and arms', () => {
  const jobs: SpikeJobV3[] = [
    { key: 'seasons', arm: 'a' },
    { key: 'seasons', arm: 'b' },
    { key: 'dns-lookup', arm: 'a' },
    { key: 'dns-lookup', arm: 'b' },
  ];

  it('runs every recipe in every arm and hands each result over as soon as it is ready', async () => {
    const seen: string[] = [];
    const summary = await runSpikeJobs(
      jobs,
      (job) => Promise.resolve(result(job.key, job.arm, 'accepted_first_take')),
      (r) => {
        seen.push(spikeJobLabel({ key: r.line.key, arm: r.line.arm }));
        return Promise.resolve();
      },
      1,
    );
    expect(seen).toEqual(['seasons.a', 'seasons.b', 'dns-lookup.a', 'dns-lookup.b']);
    expect(summary).toEqual({ requested: 4, completed: 4, notStarted: [] });
  });

  it('starts no further job after an outcome that is not about the job, and names the job that stopped it', async () => {
    const summary = await runSpikeJobs(
      jobs,
      (job) => Promise.resolve(result(job.key, job.arm, job.arm === 'b' ? 'paused' : 'accepted_first_take')),
      () => Promise.resolve(),
      1,
    );
    expect(summary.completed).toBe(2);
    expect(summary.notStarted.map(spikeJobLabel)).toEqual(['dns-lookup.a', 'dns-lookup.b']);
    expect(summary.stoppedBy).toEqual({ key: { key: 'seasons', arm: 'b' }, outcome: 'paused' });
  });
});
