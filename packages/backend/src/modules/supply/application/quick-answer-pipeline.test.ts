import { describe, expect, it, vi } from 'vitest';
import type { ProposeOutcome, ReasoningContext, ReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import type { CitablePassage, QuickAnswerDraft } from '../domain/quick-answer.js';
import { answerAndCheck, type PipelineInput } from './quick-answer-pipeline.js';
import type { QuickAnswerSupportCheck, SupportFinding } from './quick-answer-support.js';

/**
 * The model steps of one Quick answer and the person's wait (D-253): no paid step starts once the wait is over, because
 * the answer would be dropped when it arrived. The harness and the support check are labelled CI fixtures that record
 * which paid step was asked, and the clock is theirs to move.
 */
const passages: readonly CitablePassage[] = [
  {
    handle: 'e1',
    stopId: 'a',
    text: 'The axis leans twenty-three degrees and keeps pointing the same way all year long.',
  },
];
const draft: QuickAnswerDraft = {
  question: 'Why does the axis keep pointing the same way?',
  answer: 'Nothing turns the axis during a year. It keeps pointing the same way as Earth goes round the Sun.',
  covered: true,
  cites: ['e1'],
};
const authority: PersonalAuthority = {
  universeId: 'u',
  privacyEpoch: 1,
  actor: { kind: 'system', purpose: 'supply.quick-answer' },
};
const waitEndsAt = new Date('2026-11-01T10:04:00.000Z');
const context: ReasoningContext = {
  bundleRef: 'ci',
  items: [{ ref: 'scroll', kind: 'current_scroll', text: 'Seasons' }],
};

/** A run of the pipeline in which `onStep` can move the clock after each paid step. */
function pipeline(onStep: (step: string, clock: { now: Date }) => void = () => undefined) {
  const clock = { now: new Date('2026-11-01T10:00:00.000Z') };
  const steps: string[] = [];
  const written = (): ProposeOutcome<QuickAnswerDraft> =>
    ({
      kind: 'proposed',
      output: draft,
      attemptId: 'ci-attempt',
      usage: {},
      repaired: false,
      reconciled: false,
    }) as never;
  const harness = {
    propose: vi.fn(() => {
      const step = steps.some((one) => one.startsWith('write')) ? 'rewrite' : 'write';
      steps.push(`write:${step}`);
      onStep(step, clock);
      return Promise.resolve(written());
    }),
  } as unknown as ReasoningHarness;
  let checks = 0;
  const findings: SupportFinding[] = [
    {
      kind: 'unsupported',
      unsupported: [{ number: 1, verdict: 'unsupported', kind: 'goes_beyond', problem: 'A CI note.' }],
    },
    { kind: 'supported' },
  ];
  const support: QuickAnswerSupportCheck = (input) => {
    steps.push(`check:${String(input.draft)}`);
    onStep(`check:${String(input.draft)}`, clock);
    const finding = findings[checks] ?? { kind: 'supported' };
    checks += 1;
    return Promise.resolve({ finding, run: { runId: input.runId, end: 'completed' } });
  };
  const input: PipelineInput = {
    authority,
    quickAnswerId: 'qa-1',
    ask: { passage: 'keeps pointing', question: undefined },
    passages,
    context,
    waitEndsAt,
    signal: new AbortController().signal,
  };
  const run = () =>
    answerAndCheck({ harness, support, idFor: (name) => `id:${name}`, now: () => new Date(clock.now) }, input);
  return { run, steps };
}

describe('the model steps of a Quick answer and the person’s wait', () => {
  it('takes every step when the wait is not over: the writer, the check, the one rewrite and its check', async () => {
    const { run, steps } = pipeline();
    const result = await run();
    expect(steps).toEqual(['write:write', 'check:1', 'write:rewrite', 'check:2']);
    expect(result.kind).toBe('shown');
  });

  it('is not late at the instant the wait ends, only after it', async () => {
    const exactly = pipeline((_step, clock) => (clock.now = new Date(waitEndsAt)));
    expect((await exactly.run()).kind).toBe('shown');
    const after = pipeline((_step, clock) => (clock.now = new Date(waitEndsAt.getTime() + 1)));
    expect((await after.run()).kind).toBe('unavailable');
  });

  it('asks for no check once the wait is over after the writer: the answer would be dropped', async () => {
    const { run, steps } = pipeline((step, clock) => {
      if (step === 'write') clock.now = new Date(waitEndsAt.getTime() + 1_000);
    });
    const result = await run();
    expect(steps).toEqual(['write:write']);
    expect(result).toEqual({ kind: 'unavailable', runs: [{ runId: 'qa-1', end: 'completed' }] });
  });

  it('asks for no rewrite once the wait is over after the first check, and closes the runs it paid for', async () => {
    const { run, steps } = pipeline((step, clock) => {
      if (step === 'check:1') clock.now = new Date(waitEndsAt.getTime() + 1_000);
    });
    const result = await run();
    expect(steps).toEqual(['write:write', 'check:1']);
    expect(result.kind).toBe('unavailable');
    expect(result.runs).toHaveLength(2);
  });

  it('asks for no second check once the wait is over after the rewrite', async () => {
    const { run, steps } = pipeline((step, clock) => {
      if (step === 'rewrite') clock.now = new Date(waitEndsAt.getTime() + 1_000);
    });
    const result = await run();
    expect(steps).toEqual(['write:write', 'check:1', 'write:rewrite']);
    expect(result.kind).toBe('unavailable');
    expect(result.runs).toHaveLength(3);
  });
});
