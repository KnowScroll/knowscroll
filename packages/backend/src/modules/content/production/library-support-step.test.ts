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
import { LIBRARY_SUPPORT_CHECK_VERSION, LIBRARY_SUPPORT_MAX_BATCHES } from './library-support.js';
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
    // Every run holds one paid attempt.
    readProductionRunAccounting: () => Promise.resolve({ kind: 'accounted' as const, attempts: [{}] }),
    closeProductionRun: () => Promise.resolve('closed' as const),
  } as unknown as ProductionReasoningHarness;
  const withScope = ((_authority, work) =>
    work({} as never).then((value) => ({ kind: 'entered' as const, value }))) as WithProductionScope;
  return { proposals, step: makeLibrarySupportStep({ authority, withScope, harness }) };
}

/** An accepted reply for the batch the request lists: every sentence supported, with the quote the checker gave. */
const supportedReply = (input: ProductionProposeInput<unknown>, repaired = false): ProposeOutcome<unknown> => {
  const listed = input.context.items.find((item) => item.ref === 'support:sentences')!.text.split('\n');
  const verdicts: SentenceVerdict[] = listed.map((line) => ({
    number: (JSON.parse(line) as { n: number }).n,
    verdict: 'supported',
    quote: 'a few words in it',
  }));
  return {
    kind: 'proposed',
    output: { sentences: verdicts, quotes: verdicts.map((verdict) => [verdict.number, 'a few words in it']) },
    attemptId: 'attempt',
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null },
    repaired,
    reconciled: false,
  } as unknown as ProposeOutcome<unknown>;
};

const input = (count: number, overrides: { revision?: number; failures?: Record<number, number> } = {}) => ({
  assetId: ASSET,
  revision: overrides.revision ?? 1,
  failures: overrides.failures ?? {},
  sentences: sentences(count),
  passages,
  signal: new AbortController().signal,
});

describe('the model step of the library support check (D-415)', () => {
  it('asks a batch of at most ten sentences at a time, in order, one run each, in the library checker’s background role', async () => {
    const { proposals, step } = fakeHarness((request) => supportedReply(request));
    const outcome = await step.check(input(25));
    expect(outcome).toMatchObject({ kind: 'checked', batches: 3, attemptCounts: [1, 1, 1] });
    if (outcome.kind !== 'checked') throw new Error('CI expected a checked outcome');
    expect(outcome.results).toHaveLength(25);
    expect(outcome.results.map((result) => result.n)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(outcome.runs).toEqual(
      [0, 1, 2].map((batch) => ({ runId: librarySupportRunId(ASSET, 1, batch, 0), state: 'completed' })),
    );
    expect(
      proposals.map(
        (proposal) => proposal.context.items.find((item) => item.ref === 'support:sentences')!.text.split('\n').length,
      ),
    ).toEqual([10, 10, 5]);
    for (const proposal of proposals) {
      expect(proposal.role).toMatchObject({
        id: 'content.library-support-check',
        version: LIBRARY_SUPPORT_CHECK_VERSION,
        budgetClass: 'background',
      });
      expect(proposal.run).toMatchObject({ ownerModule: 'content', purpose: 'library-support-check', authority });
      expect(proposal.context.bundleRef).toMatch(new RegExp(`^scroll:${ASSET}:1:library-support:0:[012]$`, 'u'));
    }
    expect(proposals.map((proposal) => proposal.run.id)).toEqual(outcome.runs.map((run) => run.runId));
  });

  it('keeps the quote the checker gave and how it stands to its sentence in each result', async () => {
    const { step } = fakeHarness((request) => supportedReply(request));
    const outcome = await step.check(input(3));
    if (outcome.kind !== 'checked') throw new Error('CI expected a checked outcome');
    expect(outcome.results[0]).toMatchObject({
      outcome: 'supported',
      quote: 'a few words in it',
      shared: expect.any(Number) as number,
      keyWords: expect.any(Number) as number,
      quoteKeyWords: expect.any(Number) as number,
    });
  });

  it('derives a run from the revision, the checker’s version, the batch and how often that batch failed, so a redelivery meets the same one and nothing else does', () => {
    const ids = new Set([
      librarySupportRunId(ASSET, 1, 0, 0),
      librarySupportRunId(ASSET, 1, 1, 0),
      librarySupportRunId(ASSET, 1, 0, 1),
      librarySupportRunId(ASSET, 2, 0, 0),
      librarySupportRunId('cde79338-06f9-4405-aa1c-1ccff9c51d4b', 1, 0, 0),
    ]);
    expect(ids.size).toBe(5);
    expect(librarySupportRunId(ASSET, 1, 0, 0)).toBe(librarySupportRunId(ASSET, 1, 0, 0));
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
      attemptCounts: [],
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

  it('stops at the first batch with no usable reply and names it: nothing is known about a Scroll part of which was not checked', async () => {
    const { proposals, step } = fakeHarness((request, call) =>
      call === 2
        ? ({ kind: 'failed', code: 'HTTP_503' } as unknown as ProposeOutcome<unknown>)
        : supportedReply(request),
    );
    const outcome = await step.check(input(35));
    expect(proposals).toHaveLength(2);
    expect(outcome).toEqual({
      kind: 'unchecked',
      code: 'provider_failed',
      batches: 4,
      failedBatch: 1,
      attemptCounts: [1, 1],
      runs: [
        { runId: librarySupportRunId(ASSET, 1, 0, 0), state: 'completed' },
        { runId: librarySupportRunId(ASSET, 1, 1, 0), state: 'failed' },
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
    expect(outcome).toMatchObject({ kind: 'unchecked', code: 'outcome_unknown', failedBatch: 1 });
    if (outcome.kind !== 'unchecked') throw new Error('CI expected an unchecked outcome');
    expect(outcome.runs).toEqual([{ runId: librarySupportRunId(ASSET, 1, 0, 0), state: 'completed' }]);
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

  describe('a later round after a provider failure', () => {
    // Round one: batches 0 and 1 are answered, batch 2 fails. Round two: the same input and the failure noted.
    const failAtBatch =
      (batch: number): Reply =>
      (request, call) =>
        call === batch + 1
          ? ({ kind: 'failed', code: 'HTTP_503' } as unknown as ProposeOutcome<unknown>)
          : supportedReply(request);

    it('asks the answered batches again by the same runs and the same requests, so the ledger gives them back for nothing, and asks the failed batch in a run of its own', async () => {
      const first = fakeHarness(failAtBatch(2));
      const roundOne = await first.step.check(input(35));
      expect(roundOne).toMatchObject({
        kind: 'unchecked',
        code: 'provider_failed',
        failedBatch: 2,
        attemptCounts: [1, 1, 1],
      });

      const second = fakeHarness((request) => supportedReply(request));
      const roundTwo = await second.step.check(input(35, { failures: { 2: 1 } }));
      expect(roundTwo).toMatchObject({ kind: 'checked', batches: 4 });
      // Batches 0 and 1: the same run and the same request as in round one.
      for (const batch of [0, 1]) {
        expect(second.proposals[batch]!.run.id).toBe(first.proposals[batch]!.run.id);
        expect(second.proposals[batch]!.context).toEqual(first.proposals[batch]!.context);
        expect(second.proposals[batch]!.role.version).toBe(first.proposals[batch]!.role.version);
      }
      // Batch 2 failed: a run of its own, one generation on; batch 3 was never asked and keeps generation zero.
      expect(second.proposals[2]!.run.id).toBe(librarySupportRunId(ASSET, 1, 2, 1));
      expect(second.proposals[2]!.run.id).not.toBe(first.proposals[2]!.run.id);
      expect(second.proposals[2]!.context.bundleRef).toBe(`scroll:${ASSET}:1:library-support:1:2`);
      expect(second.proposals[3]!.run.id).toBe(librarySupportRunId(ASSET, 1, 3, 0));
    });

    it('counts the batches a later round read back from the ledger with their attempts, so the caller can add only what it paid for', async () => {
      const { step } = fakeHarness((request) => supportedReply(request));
      const outcome = await step.check(input(35, { failures: { 2: 1 } }));
      if (outcome.kind !== 'checked') throw new Error('CI expected a checked outcome');
      // One attempt in each of the four runs: the caller knows batches before the failed one (0 and 1) were paid for earlier.
      expect(outcome.attemptCounts).toEqual([1, 1, 1, 1]);
    });
  });
});
