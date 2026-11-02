import { describe, expect, it } from 'vitest';
import type { ProposeOutcome, ReasoningContext } from '../../../reasoning/public.js';
import { ANSWER_PAID_ATTEMPTS, type GroundPassage } from '../domain/answer-support.js';
import { AMBIENT_CHECK_ROLE_ID, ASKED_CHECK_ROLE_ID } from './answer-check.js';
import {
  answerAndCheck,
  type AnswerModel,
  type AnswerVerdict,
  type ModelCall,
  type ModelRun,
  type PipelineInput,
  type PipelineResult,
} from './answer-pipeline.js';
import { inhabitantRole, type ContributionMaterial } from './inhabitant-role.js';
import { residentRole } from './resident-role.js';

/** CI fixtures: invented passages about an invented moon and a scripted model, never provider output. */
const GROUND: readonly GroundPassage[] = [
  {
    handle: 'e1',
    assetId: '00000000-0000-4000-8000-0000000000a1',
    assetRevision: 1,
    blockId: 's1',
    text: 'The moon of Veld drifts away from its planet by about 3.8 centimetres every year.',
  },
  {
    handle: 'e2',
    assetId: '00000000-0000-4000-8000-0000000000a2',
    assetRevision: 2,
    blockId: 's4',
    text: 'Lasers bounced off mirrors on the surface time the trip to a billionth of a second.',
  },
];
const MATERIAL: ContributionMaterial = {
  turnId: 'turn-1',
  roomName: 'A room',
  topicMeaning: undefined,
  guidelines: undefined,
  discussionTitle: undefined,
  content: undefined,
  messages: [{ speaker: 'Member 1', text: 'How do we know the moon drifts?' }],
  focus: 1,
};

const SUPPORTED = 'The moon of Veld drifts away from its planet by about 3.8 centimetres every year.';
const INVENTED = 'The moon moves away by 1.25 million metres each second.';
const ANOTHER_CLAIM = 'It does so because of the tides.';

const usage = { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null };
const proposed = <T>(output: T, attemptId = 'attempt'): ProposeOutcome<T> => ({
  kind: 'proposed',
  output,
  attemptId,
  usage,
  repaired: false,
  reconciled: false,
});
const writes = (kind: string, text: string, cites: readonly string[] = ['e1']) => proposed({ kind, text, cites });
/** The checker's reply: one verdict per sentence listed, `bad` naming the numbers it finds unsupported. */
const checks = (count: number, bad: readonly number[] = []) =>
  proposed({
    sentences: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      return bad.includes(number)
        ? { number, verdict: 'unsupported', kind: 'not_stated', problem: 'A note in the checker’s own words.' }
        : { number, verdict: 'supported', quote: 'fixture quote' };
    }),
  });

interface Call {
  readonly step: 'write' | 'check';
  readonly runId: string;
  readonly roleId: string;
  readonly version: string;
  readonly allowRepair: boolean;
  readonly context: ReasoningContext;
  readonly budgetClass: string | undefined;
}

/** A model that plays `replies` in order and records every call. An exhausted script is a test failure. */
function scripted(...replies: readonly ProposeOutcome<unknown>[]) {
  const calls: Call[] = [];
  const model: AnswerModel = <T>(call: ModelCall<T>) => {
    const reply = replies[calls.length];
    if (reply === undefined) throw new Error(`the script ran out at call ${String(calls.length + 1)}`);
    calls.push({
      step: call.step,
      runId: call.runId,
      roleId: call.role.id,
      version: call.role.version,
      allowRepair: call.allowRepair,
      context: call.context,
      budgetClass: call.role.budgetClass,
    });
    const run: ModelRun = {
      runId: call.runId,
      end: reply.kind === 'proposed' ? 'completed' : reply.kind === 'invalid_output' ? 'failed' : undefined,
    };
    return Promise.resolve({ outcome: reply as ProposeOutcome<T>, run });
  };
  return { model, calls };
}

const input = (origin: 'asked' | 'unprompted' = 'asked'): PipelineInput => ({
  origin,
  turnId: 'turn-1',
  material: MATERIAL,
  ground: GROUND,
  writer: origin === 'asked' ? inhabitantRole('explainer', ['e1', 'e2']) : residentRole('explainer', ['e1', 'e2']),
  idFor: (name) => `id(${name})`,
});

const run = (model: AnswerModel, origin: 'asked' | 'unprompted' = 'asked'): Promise<PipelineResult> =>
  answerAndCheck(model, input(origin), new AbortController().signal);

const posted = (result: PipelineResult): Extract<AnswerVerdict, { kind: 'post' }> => {
  if (result.verdict.kind !== 'post') throw new Error(`expected a post, got ${result.verdict.kind}`);
  return result.verdict;
};

/** The most paid attempts a sequence of calls may make: each call, and a repair after it when it may have one. */
const attemptsOf = (calls: readonly Call[]): number =>
  calls.reduce((total, call) => total + (call.allowRepair ? 2 : 1), 0);

describe('an answer that stands on its passages', () => {
  it('is posted after one writer call and one check, with the passages it cites kept on the turn', async () => {
    const { model, calls } = scripted(writes('explanation', SUPPORTED), checks(1));
    const result = await run(model);
    expect(posted(result).answer).toEqual({ kind: 'explanation', text: SUPPORTED });
    expect(result.support).toEqual({
      policy: 'rooms-answer-support.v1',
      result: 'cleared',
      cited: [{ assetId: GROUND[0]!.assetId, assetRevision: 1, blockId: 's1' }],
      flagged: [0],
    });
    expect(calls.map((call) => [call.step, call.roleId])).toEqual([
      ['write', 'rooms.explainer'],
      ['check', ASKED_CHECK_ROLE_ID],
    ]);
    // The writer's run is the turn's own, which the caller closes with the message; the check has a run named from it.
    expect(result.runs.map((entry) => entry.runId)).toEqual(['turn-1', 'id(rooms-answer:turn-1:check:1)']);
  });

  it('is offered the passages under their handles, and the checker is shown the sentences against those it cites', async () => {
    const { model, calls } = scripted(writes('explanation', SUPPORTED, ['e1', 'e2']), checks(1));
    await run(model);
    expect(calls[0]!.context.items.filter((item) => item.kind === 'passage').map((item) => item.ref)).toEqual([
      'passage:e1',
      'passage:e2',
    ]);
    const checker = calls[1]!.context.items;
    expect(checker.find((item) => item.ref === 'support:passages')!.text).toContain('[e2] Lasers bounced');
    expect(checker.find((item) => item.ref === 'support:sentences')!.text).toContain('"cites":["e1","e2"]');
  });

  it('is not asked for twice: the writer may be repaired once, the check once', async () => {
    const { model, calls } = scripted(writes('explanation', SUPPORTED), checks(1));
    await run(model);
    expect(calls.map((call) => call.allowRepair)).toEqual([true, true]);
  });
});

describe('a flagged sentence earns one rewrite', () => {
  it('is rewritten once with fixed hints, checked again and posted as the rewrite', async () => {
    const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;
    const { model, calls } = scripted(
      writes('explanation', draft),
      checks(2, [2]),
      writes('explanation', SUPPORTED),
      checks(1),
    );
    const result = await run(model);
    expect(posted(result).answer.text).toBe(SUPPORTED);
    expect(result.support).toMatchObject({ result: 'cleared_after_rewrite', flagged: [1, 0] });
    expect(calls.map((call) => call.step)).toEqual(['write', 'check', 'write', 'check']);
    // The rewrite is a revision of the writer's role, on a run of its own, told the sentence and what to do, in fixed words.
    expect(calls[2]!.version).toBe(`${calls[0]!.version}.fix`);
    expect(calls[2]!.runId).toBe('id(rooms-answer:turn-1:rewrite)');
    const problems = calls[2]!.context.items.find((item) => item.ref === 'check:problems')!.text;
    expect(problems).toBe(
      `Sentence "${ANOTHER_CLAIM}": No passage you cite states this. Remove the sentence, or say only what a cited passage states.`,
    );
    expect(problems).not.toContain('checker');
    // Neither the rewrite nor the second check is repaired: the bound counts on it.
    expect(calls.map((call) => call.allowRepair)).toEqual([true, true, false, false]);
  });

  it('never posts the first draft when it was flagged, however the rewrite ends', async () => {
    const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;
    const { model } = scripted(
      writes('explanation', draft),
      checks(2, [2]),
      writes('explanation', draft),
      checks(2, [2]),
    );
    const result = await run(model);
    expect(result.verdict).toEqual({ kind: 'not_covered', attemptId: 'attempt' });
    expect(result.support).toEqual({
      policy: 'rooms-answer-support.v1',
      result: 'not_covered',
      cited: [],
      flagged: [1, 1],
    });
  });

  it('is not covered when the rewrite finds nothing supported left to say, or is no usable answer', async () => {
    const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;
    for (const rewrite of [
      proposed({ kind: 'not_covered', text: '', cites: [] }),
      proposed({ kind: 'nothing_to_add', text: '', cites: [] }),
      { kind: 'invalid_output', attemptId: 'x', reason: 'schema' } as const,
    ]) {
      const { model, calls } = scripted(writes('explanation', draft), checks(2, [2]), rewrite);
      const result = await run(model);
      expect(result.verdict.kind).toBe('not_covered');
      // No second check is paid for an answer that is not there.
      expect(calls).toHaveLength(3);
    }
  });

  it('fails, rather than says the library does not cover it, when the rewrite could not be made', async () => {
    const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;
    const { model } = scripted(writes('explanation', draft), checks(2, [2]), {
      kind: 'failed',
      attemptId: 'x',
      code: 'HTTP_500',
    });
    expect((await run(model)).verdict).toEqual({ kind: 'failed', dispatched: true, end: 'failed' });
  });
});

describe('a rewrite that is never sent', () => {
  const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;

  it('still counts the turn, because the draft and its check were paid for', async () => {
    const cases = [
      [
        { kind: 'budget_exhausted', dimension: 'role', limit: 'requests' },
        { kind: 'failed', dispatched: true, end: 'cancelled' },
      ],
      [
        { kind: 'quota_unavailable', attemptId: 'x' },
        { kind: 'failed', dispatched: true, end: 'cancelled' },
      ],
      [
        { kind: 'refused', reason: 'scope_refused' },
        { kind: 'failed', dispatched: true },
      ],
      [
        { kind: 'unknown', attemptId: 'x' },
        { kind: 'failed', dispatched: true },
      ],
    ] as const;
    for (const [reply, verdict] of cases) {
      const { model, calls } = scripted(writes('explanation', draft), checks(2, [2]), reply);
      expect((await run(model)).verdict).toEqual(verdict);
      expect(calls).toHaveLength(3);
    }
  });

  it('is handed back only when nothing was paid for: the first writer refused before it was sent', async () => {
    const { model } = scripted({ kind: 'refused', reason: 'scope_refused' });
    expect((await run(model)).verdict).toEqual({ kind: 'failed', dispatched: false });
  });
});

describe('the figure rule (D-208)', () => {
  it('flags a figure no cited passage writes even when the checker finds the sentence supported', async () => {
    const { model, calls } = scripted(
      writes('explanation', INVENTED),
      checks(1),
      writes('explanation', SUPPORTED),
      checks(1),
    );
    const result = await run(model);
    expect(posted(result).answer.text).toBe(SUPPORTED);
    expect(result.support).toMatchObject({ result: 'cleared_after_rewrite', flagged: [1, 0] });
    expect(calls[2]!.context.items.find((item) => item.ref === 'check:problems')!.text).toContain(
      'a passage you cite writes that same number the same way',
    );
  });

  it('does not pay for the check of a rewrite that still carries a figure no passage writes', async () => {
    const { model, calls } = scripted(writes('explanation', INVENTED), checks(1), writes('explanation', INVENTED));
    const result = await run(model);
    expect(result.verdict.kind).toBe('not_covered');
    expect(result.support).toMatchObject({ result: 'not_covered', flagged: [1, 1] });
    expect(calls.map((call) => call.step)).toEqual(['write', 'check', 'write']);
  });

  it('still rewrites a draft with an invented figure when the checker gave no usable reply', async () => {
    const { model } = scripted(
      writes('explanation', INVENTED),
      { kind: 'invalid_output', attemptId: 'x', reason: 'schema' },
      writes('explanation', SUPPORTED),
      checks(1),
    );
    expect(posted(await run(model)).answer.text).toBe(SUPPORTED);
  });
});

describe('what ends a turn without a post', () => {
  it('fails closed when the checker gives no usable reply: nothing unchecked is posted', async () => {
    for (const reply of [
      { kind: 'invalid_output', attemptId: 'x', reason: 'schema' } as const,
      { kind: 'unknown', attemptId: 'x' } as const,
      { kind: 'failed', attemptId: 'x', code: 'HTTP_500' } as const,
      { kind: 'budget_exhausted', dimension: 'role', limit: 'requests' } as const,
    ]) {
      const { model, calls } = scripted(writes('explanation', SUPPORTED), reply);
      const result = await run(model);
      expect(result.verdict).toEqual({ kind: 'failed', dispatched: true });
      expect(result.support).toBeUndefined();
      expect(calls).toHaveLength(2);
    }
  });

  it('fails closed when the second check gives no usable reply', async () => {
    const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;
    const { model } = scripted(writes('explanation', draft), checks(2, [2]), writes('explanation', SUPPORTED), {
      kind: 'unknown',
      attemptId: 'x',
    });
    expect((await run(model)).verdict).toEqual({ kind: 'failed', dispatched: true });
  });

  it('counts a writer that failed as the harness does, and never goes on to a check', async () => {
    const cases = [
      [
        { kind: 'unknown', attemptId: 'x' },
        { kind: 'failed', dispatched: true },
      ],
      [
        { kind: 'failed', attemptId: 'x', code: 'HTTP_500' },
        { kind: 'failed', dispatched: true, end: 'failed' },
      ],
      [
        { kind: 'budget_exhausted', dimension: 'role', limit: 'requests' },
        { kind: 'failed', dispatched: false, end: 'cancelled' },
      ],
      [
        { kind: 'invalid_output', attemptId: 'x', reason: 'schema' },
        { kind: 'failed', dispatched: true, end: 'failed' },
      ],
    ] as const;
    for (const [reply, verdict] of cases) {
      const { model, calls } = scripted(reply);
      expect((await run(model)).verdict).toEqual(verdict);
      expect(calls).toHaveLength(1);
    }
  });

  it('ends with the writer’s own word when it has nothing to add or the passages do not cover the question', async () => {
    const nothing = scripted(proposed({ kind: 'nothing_to_add', text: '', cites: [] }));
    const none = await run(nothing.model);
    expect(none.verdict).toEqual({ kind: 'nothing_to_add' });
    expect(none.support).toBeUndefined();
    expect(nothing.calls).toHaveLength(1);

    const uncovered = scripted(proposed({ kind: 'not_covered', text: '', cites: [] }));
    const result = await run(uncovered.model);
    expect(result.verdict).toEqual({ kind: 'not_covered', attemptId: 'attempt' });
    expect(result.support).toMatchObject({ result: 'not_covered', cited: [], flagged: [] });
    expect(uncovered.calls).toHaveLength(1);
  });

  it('does not send an answer of more sentences than one request carries to the checker', async () => {
    const long = Array.from({ length: 11 }, () => 'It drifts.').join(' ');
    const { model, calls } = scripted(writes('explanation', long));
    expect((await run(model)).verdict).toEqual({ kind: 'failed', dispatched: true });
    expect(calls).toHaveLength(1);
  });
});

describe('the bound', () => {
  it('is the most attempts any path makes, and is the one the job’s claim is sized from', async () => {
    const draft = `${SUPPORTED} ${ANOTHER_CLAIM}`;
    const { model, calls } = scripted(
      writes('explanation', draft),
      checks(2, [2]),
      writes('explanation', draft),
      checks(2, [2]),
    );
    await run(model);
    expect(calls).toHaveLength(4);
    expect(attemptsOf(calls)).toBe(ANSWER_PAID_ATTEMPTS);
  });
});

describe('a resident that speaks on its own', () => {
  it('is checked by an ambient role of its own, so its spend stays within the ambient share', async () => {
    const { model, calls } = scripted(writes('explanation', SUPPORTED), checks(1));
    await run(model, 'unprompted');
    expect(calls.map((call) => [call.roleId, call.budgetClass])).toEqual([
      ['rooms.ambient-explainer', 'ambient'],
      [AMBIENT_CHECK_ROLE_ID, 'ambient'],
    ]);
  });
});
