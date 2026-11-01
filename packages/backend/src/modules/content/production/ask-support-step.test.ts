import { describe, expect, it, vi } from 'vitest';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import {
  ASK_SUPPORT_BATCH_SENTENCES,
  ASK_SUPPORT_MAX_BATCHES,
  type SentenceUnderCheck,
} from '../domain/ask-support.js';
import { ASK_SUPPORT_CHECK_VERSION, ASK_SUPPORT_INSTRUCTIONS, askSupportRole } from './ask-support.js';
import {
  askSupportRunId,
  makeAskSupportStep,
  type CheckerRoleOf,
  type SupportCheckOutcome,
} from './ask-support-step.js';

/**
 * The step that asks the support checker about a draft, a batch of sentences at a time (D-267), against a labelled CI
 * harness that records each request and answers from a script. The sentences are questions put to the reader, which
 * the checker may always mark as stating no fact, so a reply is valid without any passage.
 */
const authority: ProductionAuthority = { scopeId: 'scroll-supply', generation: 1 };
const withScope: WithProductionScope = (_authority, work) =>
  work({} as never).then((value) => ({ kind: 'entered', value })) as never;

const questions = (count: number): SentenceUnderCheck[] =>
  Array.from({ length: count }, (_unused, index) => ({
    number: index + 1,
    text: `Why does the beam turn, part ${String(index + 1)}?`,
    cites: ['e1'],
  }));
const passages = [{ handle: 'e1', claimId: 'claim-1', pageId: 'page-1', text: 'The lamp turns once a minute.' }];

type Script = (batch: number) => 'ok' | 'ok_after_repair' | Exclude<ProposeOutcome<never>, { kind: 'proposed' }>;

/** A harness that answers each request from `script`, and records the request. */
function harnessOf(script: Script = () => 'ok') {
  const requests: {
    runId: string;
    allowRepair: boolean | undefined;
    numbers: number[];
    roleVersion: string;
    instructions: string;
  }[] = [];
  const harness = {
    proposeProduction: vi.fn((input: Parameters<ProductionReasoningHarness['proposeProduction']>[0]) => {
      const lines = input.context.items.find((item) => item.kind === 'answer_sentences')!.text.split('\n');
      const numbers = lines.map((line) => (JSON.parse(line) as { n: number }).n);
      requests.push({
        runId: input.run.id,
        allowRepair: input.limits?.allowRepair,
        numbers,
        roleVersion: input.role.version,
        instructions: input.role.instructions,
      });
      const outcome = script(requests.length - 1);
      if (typeof outcome !== 'string') return Promise.resolve(outcome);
      const reply = { sentences: numbers.map((n) => ({ n, verdict: 'no_claim' })) };
      return Promise.resolve({
        kind: 'proposed',
        output: input.role.outputSchema.parse(reply),
        attemptId: 'ci-attempt',
        usage: {},
        repaired: outcome === 'ok_after_repair',
        reconciled: false,
      } as ProposeOutcome<unknown>);
    }),
    readProductionRunAccounting: vi.fn(() => Promise.resolve({ kind: 'accounted', attempts: [] })),
  } as unknown as ProductionReasoningHarness;
  return { harness, requests };
}

async function check(sentences: readonly SentenceUnderCheck[], script?: Script, checkerRoleOf?: CheckerRoleOf) {
  const { harness, requests } = harnessOf(script);
  const step = makeAskSupportStep({ authority, withScope, harness }, checkerRoleOf);
  const outcome = await step.check({
    jobId: 'job-1',
    policyVersion: 'ci',
    draft: 1,
    sentences,
    passages,
    signal: new AbortController().signal,
  });
  return { outcome, requests };
}
const done = (outcome: SupportCheckOutcome) => {
  if (outcome.kind !== 'done') throw new Error(`CI: expected a finished check, got ${outcome.kind}`);
  return outcome;
};

describe('which instructions ask the checker (D-280)', () => {
  it('asks with the production instructions and version unless the replay hands the step another role', async () => {
    const { requests } = await check(questions(25));
    expect(requests.map((request) => request.roleVersion)).toEqual(Array(3).fill(ASK_SUPPORT_CHECK_VERSION));
    expect(requests.map((request) => request.instructions)).toEqual(Array(3).fill(ASK_SUPPORT_INSTRUCTIONS));
  });

  it('asks every batch with the role it is handed, and with that role alone', async () => {
    const candidateRole: CheckerRoleOf = (sentences, cited) => ({
      ...askSupportRole(sentences, cited),
      version: 'ask-support-check.cand-ci',
      instructions: 'CI candidate instructions',
    });
    const { requests, outcome } = await check(questions(25), undefined, candidateRole);
    expect(requests.map((request) => request.roleVersion)).toEqual(Array(3).fill('ask-support-check.cand-ci'));
    expect(requests.map((request) => request.instructions)).toEqual(Array(3).fill('CI candidate instructions'));
    expect(done(outcome).record).toMatchObject({ kind: 'checked', batches: 3 });
  });
});

describe('asking the checker about a long draft in batches (D-267)', () => {
  it('sends the sentences in order, ten at most to a request, each batch in a run of its own', async () => {
    const { outcome, requests } = await check(questions(25));
    expect(requests.map((request) => request.numbers.length)).toEqual([10, 10, 5]);
    expect(requests.flatMap((request) => request.numbers)).toEqual(Array.from({ length: 25 }, (_u, i) => i + 1));
    expect(requests.map((request) => request.runId)).toEqual(
      [0, 1, 2].map((batch) => askSupportRunId('job-1', 1, batch)),
    );
    expect(new Set(requests.map((request) => request.runId)).size).toBe(3);
    const finished = done(outcome);
    expect(finished.record).toMatchObject({ kind: 'checked', sentences: 25, batches: 3, unsupported: [] });
    expect(finished.verdicts).toHaveLength(25);
    expect(finished.runs.map((run) => run.state)).toEqual(['completed', 'completed', 'completed']);
    expect(finished.receipt).toMatchObject({ role: 'support_check', kind: 'checked', sentences: 25, batches: 3 });
  });

  it('asks a short draft in one request', async () => {
    const { outcome, requests } = await check(questions(ASK_SUPPORT_BATCH_SENTENCES));
    expect(requests).toHaveLength(1);
    expect(done(outcome).record.batches).toBe(1);
  });

  it('lets the harness repair one unusable reply in the whole check, wherever it happens', async () => {
    const first = await check(questions(25));
    expect(first.requests.map((request) => request.allowRepair)).toEqual([true, true, true]);
    // The first batch needed its repair, so the later ones have none left.
    const repaired = await check(questions(25), (batch) => (batch === 0 ? 'ok_after_repair' : 'ok'));
    expect(repaired.requests.map((request) => request.allowRepair)).toEqual([true, false, false]);
    expect(done(repaired.outcome).record.kind).toBe('checked');
  });

  it('is unusable as a whole at the first batch with no usable reply, and does not ask for the batches after it', async () => {
    const { outcome, requests } = await check(questions(25), (batch) =>
      batch === 1 ? { kind: 'invalid_output', attemptId: 'ci', reason: 'OUTPUT_TRUNCATED' } : 'ok',
    );
    expect(requests).toHaveLength(2);
    const finished = done(outcome);
    expect(finished.record).toMatchObject({ kind: 'unchecked', code: 'invalid_output', sentences: 25, batches: 3 });
    // Nothing is known about the answer, not even about the first ten sentences.
    expect(finished.verdicts).toEqual([]);
    expect(finished.runs.map((run) => run.state)).toEqual(['completed', 'failed']);
  });

  it('never resends a batch of unknown outcome and says so', async () => {
    const { outcome, requests } = await check(questions(25), (batch) =>
      batch === 2 ? { kind: 'unknown', attemptId: 'ci' } : 'ok',
    );
    expect(requests).toHaveLength(3);
    expect(done(outcome).record).toMatchObject({ kind: 'unchecked', code: 'outcome_unknown' });
  });

  it('pauses, asking nothing more, when a budget or the quota is spent between two batches', async () => {
    const { outcome, requests } = await check(questions(25), (batch) =>
      batch === 1 ? { kind: 'quota_unavailable', attemptId: 'ci' } : 'ok',
    );
    expect(requests).toHaveLength(2);
    expect(outcome).toEqual({ kind: 'paused', code: 'quota_unavailable' });
  });

  it('reports a run that another delivery already closed', async () => {
    const { outcome } = await check(questions(25), (batch) =>
      batch === 1 ? { kind: 'refused', reason: 'run_closed' } : 'ok',
    );
    expect(outcome).toEqual({ kind: 'advanced' });
  });

  it('does not ask about an answer longer than the most batches a draft may need, and says why', async () => {
    const longest = ASK_SUPPORT_MAX_BATCHES * ASK_SUPPORT_BATCH_SENTENCES;
    expect((await check(questions(longest))).requests).toHaveLength(ASK_SUPPORT_MAX_BATCHES);
    const { outcome, requests } = await check(questions(longest + 1));
    expect(requests).toEqual([]);
    expect(done(outcome).record).toMatchObject({ kind: 'unchecked', code: 'answer_too_long', sentences: longest + 1 });
  });
});
