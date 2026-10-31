import { describe, expect, it } from 'vitest';
import { ResearchRefusal } from '../../../../infrastructure/research/public-pages.js';
import type {
  ProductionAttemptAccounting,
  ProductionProposeInput,
  ProductionReasoningHarness,
  ProductionScopeTx,
  ProposeOutcome,
  WithProductionScope,
} from '../../../../reasoning/public.js';
import type { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { runSpikeBatch, makeWriterSpikeV2, SPIKE_MODEL, type SpikeResult } from './run.js';
import type { ScrollTopic } from '../topics.js';
import { fixtureAuthoredV2, fixtureResearchPageAt, fixtureResearchPageV2 } from './writer-v2.fixture.js';

// A labelled fixture harness: it never reaches a provider and returns what each test scripts.

const attempt = (
  id: string,
  step: string,
  usage: { input: number | null; output: number | null; thinking: number | null },
  extra: Partial<ProductionAttemptAccounting> = {},
): ProductionAttemptAccounting => ({
  attemptId: id,
  step,
  state: 'succeeded',
  provider: 'minimax',
  model: SPIKE_MODEL,
  usage: { inputTokens: usage.input, outputTokens: usage.output, reasoningTokens: usage.thinking, cachedTokens: null },
  ...extra,
});

interface Script {
  readonly outcome: (output: AuthoredScrollV2 | undefined) => ProposeOutcome<AuthoredScrollV2>;
  readonly attempts: readonly ProductionAttemptAccounting[];
  /** Attempts whose answer the harness refused (and kept, with findings). */
  readonly refused?: readonly string[];
}

function wire(
  script: Script,
  overrides: {
    model?: string;
    research?: (url: string) => Promise<typeof fixtureResearchPageV2>;
    /** The writer's recorded answer; the Orrin answer drawn with Earth & sky unless a test says otherwise. */
    answer?: () => AuthoredScrollV2;
  } = {},
) {
  const calls = { proposed: 0, closed: [] as { runId: string; state: string }[], accounting: 0, runs: [] as string[] };
  const harness: ProductionReasoningHarness = {
    proposeProduction: <T>(input: ProductionProposeInput<T>) => {
      calls.proposed += 1;
      calls.runs.push(input.run.id);
      // The real harness validates with the role's schema; so does this stand-in.
      const parsed = input.role.outputSchema.safeParse((overrides.answer ?? fixtureAuthoredV2)());
      const output = parsed.success ? (parsed.data as AuthoredScrollV2) : undefined;
      return Promise.resolve(script.outcome(output) as ProposeOutcome<T>);
    },
    readProductionRunAccounting: () => {
      calls.accounting += 1;
      return Promise.resolve({ kind: 'accounted', attempts: script.attempts });
    },
    closeProductionRun: (_scope, run) => {
      calls.closed.push(run);
      return Promise.resolve('closed');
    },
  };
  const withScope: WithProductionScope = async (_authority, work) => ({
    kind: 'entered',
    value: await work({} as ProductionScopeTx),
  });
  let counter = 0;
  const spike = makeWriterSpikeV2({
    harness,
    withScope,
    authority: { scopeId: 'scroll-supply', generation: 1 },
    model: overrides.model ?? SPIKE_MODEL,
    spikeId: 'ci-spike',
    research: overrides.research ?? (() => Promise.resolve(fixtureResearchPageV2)),
    newRunId: () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`,
    findingsOf: (attemptId) =>
      Promise.resolve(
        script.refused?.includes(attemptId) === true
          ? [
              { code: 'stop_too_long', path: 'items.2' },
              { code: 'copied_passage', path: 'items.4' },
            ]
          : [],
      ),
  });
  return { spike, calls };
}

const proposed =
  (repaired: boolean) =>
  (output: AuthoredScrollV2 | undefined): ProposeOutcome<AuthoredScrollV2> =>
    output === undefined
      ? { kind: 'invalid_output', attemptId: 'att-x', reason: 'schema' }
      : {
          kind: 'proposed',
          output,
          attemptId: repaired ? 'att-2' : 'att-1',
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: null },
          repaired,
          reconciled: false,
        };
const never = new AbortController().signal;

describe('the writer spike runs a stage recipe of each drawing kit (D-194)', () => {
  // One recipe of each kit, with the recorded answer drawn with that kit. The fixture is Orrin text, not product content.
  it.each([
    ['tides.v1', 'tides'],
    ['greenhouse.v1', 'greenhouse-radiation'],
    ['star.v1', 'stars-fusion'],
    ['transit.v1', 'exoplanet-transit'],
  ] as const)(
    'accepts the answer drawn with %s for %s, and reports a stage of at least three states',
    async (kit, key) => {
      const { spike, calls } = wire(
        {
          outcome: proposed(false),
          attempts: [attempt('att-1', 'primary', { input: 4000, output: 9000, thinking: 6000 })],
        },
        { answer: () => fixtureAuthoredV2(kit), research: (url) => Promise.resolve(fixtureResearchPageAt(url)) },
      );
      const { line, document } = await spike.writeOne(key, never);
      expect(line).toMatchObject({ key, outcome: 'accepted_first_take', variant: 'stage', findings: [], requests: 1 });
      expect(line.stageStates).toBeGreaterThanOrEqual(3);
      expect(document?.document.stage?.kit).toBe(kit);
      expect(calls.closed).toEqual([{ runId: line.runId, state: 'completed' }]);
      expect(JSON.stringify(line)).not.toContain('Orrin');
    },
  );

  it('rejects the Earth & sky answer for a recipe of another kit, with the finding the repair needs', async () => {
    const { spike } = wire({
      outcome: proposed(false),
      attempts: [attempt('att-1', 'primary', { input: 1, output: 1, thinking: 0 })],
    });
    const { line } = await spike.writeOne('tides', never);
    expect(line.variant).toBe('stage');
    expect(line.outcome).not.toBe('accepted_first_take');
  });
});

describe('the writer spike: one topic', () => {
  it('reports a first-take Scroll with its measures, its tokens (thinking included) and its model, and closes the run', async () => {
    const { spike, calls } = wire({
      outcome: proposed(false),
      attempts: [attempt('att-1', 'primary', { input: 4200, output: 9100, thinking: 6500 })],
    });
    const { line, document } = await spike.writeOne('seasons', never);
    expect(line).toMatchObject({
      key: 'seasons',
      spikeId: 'ci-spike',
      outcome: 'accepted_first_take',
      variant: 'stage',
      misconception: 'myth',
      promptVersion: 'scroll-writer.v17',
      requests: 1,
      findings: [],
      stops: 9,
      calls: 3,
      asides: 1,
      models: [SPIKE_MODEL],
      tokens: { input: 4200, output: 9100, thinking: 6500, complete: true },
    });
    expect(line.stageStates).toBeGreaterThanOrEqual(3);
    expect(line.words).toBeGreaterThan(400);
    expect(line.readingMinutes).toBeGreaterThanOrEqual(3);
    expect(line.notices).toEqual([]);
    expect(line.wallMs.total).toBeGreaterThanOrEqual(0);
    expect(document?.document.schemaVersion).toBe('scroll-document.v2');
    expect(Object.keys(document?.citations ?? {})).toContain('recap');
    expect(calls.closed).toEqual([{ runId: line.runId, state: 'completed' }]);
    expect(JSON.stringify(line)).not.toContain('Orrin');
  });

  it('counts both paid requests of a repaired Scroll and reports the findings that caused the repair', async () => {
    const { spike } = wire({
      outcome: proposed(true),
      refused: ['att-1'],
      attempts: [
        attempt('att-1', 'primary', { input: 4000, output: 8000, thinking: 5000 }),
        attempt('att-2', 'repair', { input: 5200, output: 7000, thinking: 3000 }),
        attempt('att-3', 'repair.2', { input: null, output: null, thinking: null }, { state: 'not_sent' }),
      ],
    });
    const { line } = await spike.writeOne('seasons', never);
    expect(line.outcome).toBe('accepted_after_repair');
    expect(line.requests).toBe(2);
    expect(line.tokens).toEqual({ input: 9200, output: 15_000, thinking: 8000, complete: true });
    expect(line.findings).toEqual([
      { attempt: 1, code: 'stop_too_long', path: 'items.2' },
      { attempt: 1, code: 'copied_passage', path: 'items.4' },
    ]);
  });

  it('says so when a provider did not report usage, instead of guessing', async () => {
    const { spike } = wire({
      outcome: proposed(false),
      attempts: [attempt('att-1', 'primary', { input: 4000, output: null, thinking: null })],
    });
    expect((await spike.writeOne('seasons', never)).line.tokens).toMatchObject({ input: 4000, complete: false });
  });

  it('rejects a Scroll refused twice, with the findings of both answers, and keeps no document', async () => {
    const { spike, calls } = wire({
      outcome: () => ({ kind: 'invalid_output', attemptId: 'att-2', reason: 'schema' }),
      refused: ['att-1'],
      attempts: [
        attempt('att-1', 'primary', { input: 4000, output: 8000, thinking: 5000 }),
        attempt('att-2', 'repair', { input: 5000, output: 7000, thinking: 3000 }),
      ],
    });
    const { line, document } = await spike.writeOne('seasons', never);
    expect(line).toMatchObject({ outcome: 'rejected', code: 'schema', requests: 2 });
    expect(line.findings.map((finding) => finding.code)).toEqual(['stop_too_long', 'copied_passage']);
    expect(document).toBeUndefined();
    expect(calls.closed).toEqual([{ runId: line.runId, state: 'cancelled' }]);
  });

  it('leaves an unknown attempt open and never closes its run', async () => {
    const { spike, calls } = wire({
      outcome: () => ({ kind: 'unknown', attemptId: 'att-1' }),
      attempts: [attempt('att-1', 'primary', { input: null, output: null, thinking: null }, { state: 'unknown' })],
    });
    const { line } = await spike.writeOne('seasons', never);
    expect(line.outcome).toBe('unknown');
    expect(calls.closed).toEqual([]);
  });

  it('reports a reply from another model as a mismatch, and a spent budget as paused with nothing sent', async () => {
    const mismatch = wire({
      outcome: () => ({ kind: 'failed', attemptId: 'att-1', code: 'MODEL_MISMATCH' }),
      attempts: [attempt('att-1', 'primary', { input: 4000, output: 100, thinking: 0 }, { state: 'failed' })],
    });
    expect((await mismatch.spike.writeOne('seasons', never)).line).toMatchObject({
      outcome: 'model_mismatch',
      code: 'MODEL_MISMATCH',
    });
    const paused = wire({
      outcome: () => ({ kind: 'budget_exhausted', dimension: 'global', limit: 'tokens' }),
      attempts: [attempt('att-1', 'primary', { input: null, output: null, thinking: null }, { state: 'not_sent' })],
    });
    const { line } = await paused.spike.writeOne('seasons', never);
    expect(line).toMatchObject({ outcome: 'paused', requests: 0, code: 'budget_global_tokens' });
  });

  it('refuses an accepted answer whose attempts report another model than the one allowed', async () => {
    const { spike } = wire({
      outcome: proposed(false),
      attempts: [attempt('att-1', 'primary', { input: 1, output: 1, thinking: 0 }, { model: 'MiniMax-M3' })],
    });
    const { line, document } = await spike.writeOne('seasons', never);
    expect(line).toMatchObject({ outcome: 'model_mismatch', code: 'attempt_model_differs', models: ['MiniMax-M3'] });
    expect(document).toBeUndefined();
  });

  it('makes no call at all when the harness is configured with another model', async () => {
    const { spike, calls } = wire({ outcome: proposed(false), attempts: [] }, { model: 'MiniMax-M3' });
    const { line } = await spike.writeOne('seasons', never);
    expect(line).toMatchObject({ outcome: 'model_mismatch', code: 'configured_model_not_allowed', requests: 0 });
    expect(calls.proposed).toBe(0);
  });

  it('makes no model call when the research is refused, and none when it holds too little to cite', async () => {
    const refused = wire(
      { outcome: proposed(false), attempts: [] },
      { research: () => Promise.reject(new ResearchRefusal('soft_404')) },
    );
    expect((await refused.spike.writeOne('seasons', never)).line).toMatchObject({
      outcome: 'research_failed',
      code: 'soft_404',
    });
    expect(refused.calls.proposed).toBe(0);
    const thin = wire(
      { outcome: proposed(false), attempts: [] },
      {
        research: () =>
          Promise.resolve({ ...fixtureResearchPageV2, passages: fixtureResearchPageV2.passages.slice(0, 1) }),
      },
    );
    expect((await thin.spike.writeOne('seasons', never)).line.outcome).toMatch(
      /evidence_insufficient|research_failed/u,
    );
    expect(thin.calls.proposed).toBe(0);
  });
});

const result = (key: ScrollTopic, outcome: SpikeResult['line']['outcome']): SpikeResult =>
  ({ line: { key, outcome } }) as unknown as SpikeResult;

describe('the writer spike: a batch', () => {
  const keys: ScrollTopic[] = ['seasons', 'tides', 'greenhouse', 'overfitting', 'dns-lookup'];

  it('runs every topic and hands each result over as soon as it is ready', async () => {
    const seen: string[] = [];
    const summary = await runSpikeBatch(
      keys,
      (key) => Promise.resolve(result(key, 'accepted_first_take')),
      (r) => {
        seen.push(r.line.key);
        return Promise.resolve();
      },
      1,
    );
    expect(seen).toEqual(keys);
    expect(summary).toEqual({ requested: 5, completed: 5, notStarted: [] });
  });

  it('never has more topics in flight than the concurrency asked for, and caps it at four', async () => {
    let active = 0;
    let most = 0;
    const write = async (key: ScrollTopic) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return result(key, 'rejected');
    };
    await runSpikeBatch(keys, write, () => Promise.resolve(), 2);
    expect(most).toBe(2);
    most = 0;
    await runSpikeBatch([...keys, 'tides-coasts', 'greenhouse-limits'], write, () => Promise.resolve(), 99);
    expect(most).toBeLessThanOrEqual(4);
  });

  it.each(['paused', 'unknown', 'refused', 'scope_refused', 'model_mismatch'] as const)(
    'starts no further topic after %s and names the topic that stopped it',
    async (outcome) => {
      const summary = await runSpikeBatch(
        keys,
        (key) => Promise.resolve(result(key, key === 'tides' ? outcome : 'accepted_first_take')),
        () => Promise.resolve(),
        1,
      );
      expect(summary).toEqual({
        requested: 5,
        completed: 2,
        notStarted: ['greenhouse', 'overfitting', 'dns-lookup'],
        stoppedBy: { key: 'tides', outcome },
      });
    },
  );

  it('stops after two provider failures in a row, but not after two apart', async () => {
    const failing = new Set<ScrollTopic>(['seasons', 'tides']);
    const stopped = await runSpikeBatch(
      keys,
      (key) => Promise.resolve(result(key, failing.has(key) ? 'provider_failed' : 'accepted_first_take')),
      () => Promise.resolve(),
      1,
    );
    expect(stopped.stoppedBy).toEqual({ key: 'tides', outcome: 'provider_failed' });
    const apart = new Set<ScrollTopic>(['seasons', 'greenhouse']);
    const survived = await runSpikeBatch(
      keys,
      (key) => Promise.resolve(result(key, apart.has(key) ? 'provider_failed' : 'rejected')),
      () => Promise.resolve(),
      1,
    );
    expect(survived.stoppedBy).toBeUndefined();
    expect(survived.completed).toBe(5);
  });

  it('loses no topic: every key is either completed or listed as not started', async () => {
    const summary = await runSpikeBatch(
      keys,
      (key) => Promise.resolve(result(key, key === 'seasons' ? 'paused' : 'rejected')),
      () => Promise.resolve(),
      3,
    );
    expect(summary.completed + summary.notStarted.length).toBe(5);
  });
});
