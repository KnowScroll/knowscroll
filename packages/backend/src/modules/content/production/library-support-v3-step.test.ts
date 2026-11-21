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
import { librarySupportRunId } from './library-support-step.js';
import { LIBRARY_SUPPORT_V3_BATCH_SENTENCES, LIBRARY_SUPPORT_V3_CHECK_VERSION } from './library-support-v3.js';
import { librarySupportRunIdV3, makeLibrarySupportStepV3 } from './library-support-v3-step.js';

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
  return { proposals, step: makeLibrarySupportStepV3({ authority, withScope, harness }) };
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

describe('the model step of the support check of a document v3 Scroll (D-435)', () => {
  it('asks thirteen sentences at a time, in order, one run each, in the library checker’s background role under the v3 version', async () => {
    expect(LIBRARY_SUPPORT_V3_BATCH_SENTENCES).toBe(13);
    const { proposals, step } = fakeHarness((request) => supportedReply(request));
    const outcome = await step.check(input(30));
    expect(outcome).toMatchObject({ kind: 'checked', batches: 3, attemptCounts: [1, 1, 1] });
    if (outcome.kind !== 'checked') throw new Error('CI expected a checked outcome');
    expect(outcome.results.map((result) => result.n)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(outcome.runs).toEqual(
      [0, 1, 2].map((batch) => ({ runId: librarySupportRunIdV3(ASSET, 1, batch, 0), state: 'completed' })),
    );
    expect(
      proposals.map(
        (proposal) => proposal.context.items.find((item) => item.ref === 'support:sentences')!.text.split('\n').length,
      ),
    ).toEqual([13, 13, 4]);
    for (const proposal of proposals) {
      expect(proposal.role).toMatchObject({
        id: 'content.library-support-check',
        version: LIBRARY_SUPPORT_V3_CHECK_VERSION,
        budgetClass: 'background',
      });
      expect(proposal.run).toMatchObject({
        ownerModule: 'content',
        purpose: 'library-support-check',
        policyVersion: LIBRARY_SUPPORT_V3_CHECK_VERSION,
        authority,
      });
      expect(proposal.context.bundleRef).toMatch(new RegExp(`^scroll:${ASSET}:1:library-support:0:[012]$`, 'u'));
    }
  });

  it('never meets a run of the v2 check: the version is in the run, so the same revision is checked afresh', () => {
    expect(librarySupportRunIdV3(ASSET, 1, 0, 0)).toBe(librarySupportRunIdV3(ASSET, 1, 0, 0));
    expect(librarySupportRunIdV3(ASSET, 1, 0, 0)).not.toBe(librarySupportRunId(ASSET, 1, 0, 0));
    expect(
      new Set([0, 1].flatMap((batch) => [0, 1].map((generation) => librarySupportRunIdV3(ASSET, 1, batch, generation))))
        .size,
    ).toBe(4);
    expect(LIBRARY_SUPPORT_V3_CHECK_VERSION).not.toBe(LIBRARY_SUPPORT_CHECK_VERSION);
  });

  it('keeps the bound of the v2 check: ten batches, so a document v3 at the format’s limits (121 sentences in the labelled fixtures) is checked', async () => {
    const limit = LIBRARY_SUPPORT_MAX_BATCHES * LIBRARY_SUPPORT_V3_BATCH_SENTENCES;
    const tooLong = fakeHarness((request) => supportedReply(request));
    expect(await tooLong.step.check(input(limit + 1))).toEqual({
      kind: 'unchecked',
      code: 'revision_too_long',
      batches: LIBRARY_SUPPORT_MAX_BATCHES + 1,
      attemptCounts: [],
      runs: [],
    });
    expect(tooLong.proposals).toEqual([]);
    const fixture = fakeHarness((request) => supportedReply(request));
    expect(await fixture.step.check(input(121))).toMatchObject({ kind: 'checked', batches: 10 });
    expect(fixture.proposals).toHaveLength(10);
  });

  it('allows the harness’s one repair in the whole check, and stops at the first batch with no usable reply', async () => {
    const { proposals, step } = fakeHarness((request, call) => supportedReply(request, call === 1));
    await step.check(input(30));
    expect(proposals.map((proposal) => proposal.limits?.allowRepair)).toEqual([true, false, false]);
    const failing = fakeHarness((request, call) =>
      call === 2
        ? ({ kind: 'failed', code: 'HTTP_503' } as unknown as ProposeOutcome<unknown>)
        : supportedReply(request),
    );
    expect(await failing.step.check(input(40))).toMatchObject({
      kind: 'unchecked',
      code: 'provider_failed',
      batches: 4,
      failedBatch: 1,
      runs: [
        { runId: librarySupportRunIdV3(ASSET, 1, 0, 0), state: 'completed' },
        { runId: librarySupportRunIdV3(ASSET, 1, 1, 0), state: 'failed' },
      ],
    });
    expect(failing.proposals).toHaveLength(2);
  });
});
