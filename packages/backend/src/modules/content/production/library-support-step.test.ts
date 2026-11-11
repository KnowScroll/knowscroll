import { describe, expect, it } from 'vitest';
import type {
  ProductionAuthority,
  ProductionProposeInput,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { SentenceVerdict } from '../domain/ask-support.js';
import type { LibrarySentence } from '../domain/library-support.js';
import { LIBRARY_SUPPORT_MAX_BATCHES } from './library-support.js';
import { librarySupportRunId, makeLibrarySupportStep } from './library-support-step.js';

const authority: ProductionAuthority = { scopeId: 'scroll-supply', generation: 1 };
const ASSET = '8a7d48fe-0397-4e00-91a8-b4700630880f';
const passages = [{ handle: 'e1', text: 'A passage of a labelled CI fixture, with a few words in it.' }];

const sentences = (count: number): readonly LibrarySentence[] =>
  Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    text: `Sentence ${String(index + 1)} of a labelled CI fixture.`,
    cites: ['e1'],
    part: 's1',
    field: 'paragraph' as const,
  }));

type Reply = (input: ProductionProposeInput<unknown>, call: number) => ProposeOutcome<unknown>;

/** A harness that answers each request as `reply` says and records what it was asked: a labelled CI fixture, never a provider. */
function fakeHarness(reply: Reply) {
  const proposals: ProductionProposeInput<unknown>[] = [];
  const harness = {
    proposeProduction(input: ProductionProposeInput<unknown>) {
      proposals.push(input);
      return Promise.resolve(reply(input, proposals.length));
    },
    readProductionRunAccounting: () => Promise.resolve({ kind: 'accounted' as const, attempts: [] }),
    closeProductionRun: () => Promise.resolve('closed' as const),
  } as unknown as ProductionReasoningHarness;
  const withScope = ((_authority, work) =>
    work({} as never).then((value) => ({ kind: 'entered' as const, value }))) as WithProductionScope;
  return { proposals, step: makeLibrarySupportStep({ authority, withScope, harness }) };
}

/** An accepted reply for the batch the request lists: every sentence supported. */
const supportedReply = (input: ProductionProposeInput<unknown>, repaired = false): ProposeOutcome<unknown> => {
  const listed = input.context.items.find((item) => item.ref === 'support:sentences')!.text.split('\n');
  const verdicts: SentenceVerdict[] = listed.map((line) => ({
    number: (JSON.parse(line) as { n: number }).n,
    verdict: 'supported',
    quote: 'a few words in it',
  }));
  return {
    kind: 'proposed',
    output: { sentences: verdicts },
    attemptId: 'attempt',
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null },
    repaired,
    reconciled: false,
  } as unknown as ProposeOutcome<unknown>;
};

const input = (count: number, overrides: { revision?: number; round?: number } = {}) => ({
  assetId: ASSET,
  revision: overrides.revision ?? 1,
  round: overrides.round ?? 1,
  sentences: sentences(count),
  passages,
  signal: new AbortController().signal,
});

describe('the model step of the library support check (D-415)', () => {
  it('asks a batch of at most ten sentences at a time, in order, one run each, in the library checker’s background role', async () => {
    const { proposals, step } = fakeHarness((request) => supportedReply(request));
    const outcome = await step.check(input(25));
    expect(outcome).toMatchObject({ kind: 'checked', batches: 3 });
    if (outcome.kind !== 'checked') throw new Error('CI expected a checked outcome');
    expect(outcome.results).toHaveLength(25);
    expect(outcome.results.map((result) => result.n)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(outcome.runs).toEqual(
      [0, 1, 2].map((batch) => ({ runId: librarySupportRunId(ASSET, 1, 1, batch), state: 'completed' })),
    );
    expect(
      proposals.map(
        (proposal) => proposal.context.items.find((item) => item.ref === 'support:sentences')!.text.split('\n').length,
      ),
    ).toEqual([10, 10, 5]);
    for (const proposal of proposals) {
      expect(proposal.role).toMatchObject({
        id: 'content.library-support-check',
        version: 'library-support-check.v1',
        budgetClass: 'background',
      });
      expect(proposal.run).toMatchObject({ ownerModule: 'content', purpose: 'library-support-check', authority });
      expect(proposal.context.bundleRef).toMatch(new RegExp(`^scroll:${ASSET}:1:library-support:1:[012]$`, 'u'));
    }
    expect(proposals.map((proposal) => proposal.run.id)).toEqual(outcome.runs.map((run) => run.runId));
  });

  it('derives a run from the revision, the checker’s version, the round and the batch, so a redelivery meets the same one and nothing else does', () => {
    const ids = new Set([
      librarySupportRunId(ASSET, 1, 1, 0),
      librarySupportRunId(ASSET, 1, 1, 1),
      librarySupportRunId(ASSET, 1, 2, 0),
      librarySupportRunId(ASSET, 2, 1, 0),
      librarySupportRunId('cde79338-06f9-4405-aa1c-1ccff9c51d4b', 1, 1, 0),
    ]);
    expect(ids.size).toBe(5);
    expect(librarySupportRunId(ASSET, 1, 1, 0)).toBe(librarySupportRunId(ASSET, 1, 1, 0));
  });

  it('allows the harness’s one repair of an unusable reply in the whole check, not one for each batch', async () => {
    const { proposals, step } = fakeHarness((request, call) => supportedReply(request, call === 1));
    await step.check(input(25));
    // The first batch was repaired, so no later batch may be.
    expect(proposals.map((proposal) => proposal.limits?.allowRepair)).toEqual([true, false, false]);
    const unrepaired = fakeHarness((request) => supportedReply(request));
    await unrepaired.step.check(input(25));
    expect(unrepaired.proposals.map((proposal) => proposal.limits?.allowRepair)).toEqual([true, true, true]);
  });

  it('sends nothing for a revision of more batches than a check may need, and checks one of exactly that many', async () => {
    const tooLong = fakeHarness((request) => supportedReply(request));
    expect(await tooLong.step.check(input(LIBRARY_SUPPORT_MAX_BATCHES * 10 + 1))).toEqual({
      kind: 'unchecked',
      code: 'revision_too_long',
      batches: LIBRARY_SUPPORT_MAX_BATCHES + 1,
      attempts: [],
      runs: [],
    });
    expect(tooLong.proposals).toEqual([]);
    const longest = fakeHarness((request) => supportedReply(request));
    expect(await longest.step.check(input(LIBRARY_SUPPORT_MAX_BATCHES * 10))).toMatchObject({
      kind: 'checked',
      batches: 10,
    });
    expect(longest.proposals).toHaveLength(10);
  });

  it('stops at the first batch with no usable reply: nothing is known about a Scroll part of which was not checked', async () => {
    const { proposals, step } = fakeHarness((request, call) =>
      call === 2
        ? ({ kind: 'invalid_output', attemptId: 'attempt', issues: [] } as unknown as ProposeOutcome<unknown>)
        : supportedReply(request),
    );
    const outcome = await step.check(input(35));
    expect(proposals).toHaveLength(2);
    expect(outcome).toEqual({
      kind: 'unchecked',
      code: 'invalid_output',
      batches: 4,
      attempts: [],
      runs: [
        { runId: librarySupportRunId(ASSET, 1, 1, 0), state: 'completed' },
        { runId: librarySupportRunId(ASSET, 1, 1, 1), state: 'failed' },
      ],
    });
  });

  it('never closes the run of an attempt of unknown outcome, so nothing resends it', async () => {
    const { proposals, step } = fakeHarness((request, call) =>
      call === 2
        ? ({ kind: 'unknown', attemptId: 'attempt' } as unknown as ProposeOutcome<unknown>)
        : supportedReply(request),
    );
    const outcome = await step.check(input(35));
    expect(proposals).toHaveLength(2);
    expect(outcome).toMatchObject({ kind: 'unchecked', code: 'outcome_unknown' });
    if (outcome.kind !== 'unchecked') throw new Error('CI expected an unchecked outcome');
    expect(outcome.runs).toEqual([{ runId: librarySupportRunId(ASSET, 1, 1, 0), state: 'completed' }]);
  });

  it('pauses, without a verdict, on a spent budget or quota or a full failure brake, and says another delivery finished when a run is closed', async () => {
    const paused = (outcome: unknown) => fakeHarness(() => outcome as ProposeOutcome<unknown>).step.check(input(12));
    expect(await paused({ kind: 'budget_exhausted', dimension: 'background_global', limit: 'requests' })).toEqual({
      kind: 'paused',
      code: 'budget_background_global_requests',
    });
    expect(await paused({ kind: 'quota_unavailable' })).toEqual({ kind: 'paused', code: 'quota_unavailable' });
    expect(await paused({ kind: 'refused', reason: 'failure_brake' })).toEqual({
      kind: 'paused',
      code: 'failure_brake',
    });
    expect(await paused({ kind: 'refused', reason: 'run_closed' })).toEqual({ kind: 'advanced' });
    // Any other refusal is a code, not a pause.
    expect(await paused({ kind: 'refused', reason: 'attempt_written_off' })).toMatchObject({
      kind: 'unchecked',
      code: 'refused_attempt_written_off',
    });
  });
});
