import { describe, expect, it, vi } from 'vitest';
import { ASK_SUPPORT_BATCH_SENTENCES, askSupportRole } from '../../content/public.js';
import type { ProposeOutcome, RecordingReasoningHarness } from '../../../reasoning/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import type { CitablePassage, QuickAnswerDraft } from '../domain/quick-answer.js';
import {
  QUICK_ANSWER_SUPPORT_ROLE_ID,
  findingOf,
  makeSupportCheck,
  rewriteItems,
  sentencesOf,
} from './quick-answer-support.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const passages: readonly CitablePassage[] = [
  {
    handle: 'e1',
    stopId: 'a',
    text: 'The axis leans twenty-three degrees and keeps pointing the same way all year long.',
  },
  {
    handle: 'e2',
    stopId: 'b',
    text: 'When Delhi leans toward the Sun, sunlight arrives steeper and the days run longer.',
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
const proposed = (output: unknown) =>
  ({
    kind: 'proposed',
    output,
    attemptId: 'ci',
    usage: {},
    repaired: false,
    reconciled: false,
  }) as ProposeOutcome<never>;

const reply = (...verdicts: unknown[]) => ({ sentences: verdicts });
const supported = (n: number, quote: string) => ({ n, verdict: 'supported', quote });

describe('the sentences of an answer', () => {
  it('are numbered in reading order, and each rests on the passages the whole answer cites', () => {
    expect(sentencesOf(draft)).toEqual([
      { number: 1, text: 'Nothing turns the axis during a year.', cites: ['e1'] },
      { number: 2, text: 'It keeps pointing the same way as Earth goes round the Sun.', cites: ['e1'] },
    ]);
  });
});

describe('the checker’s role for a Quick answer', () => {
  const sentences = sentencesOf(draft);
  const role = askSupportRole(sentences, passages);

  it('is S-7b’s checker, with its own role ID so its failure brake and budget are not the writer’s or an ask order’s', () => {
    expect(role.id).toBe('content.ask-support-check');
    expect(QUICK_ANSWER_SUPPORT_ROLE_ID).toBe('supply.quick-answer-support');
    expect(QUICK_ANSWER_SUPPORT_ROLE_ID).not.toBe(role.id);
  });

  it('is a released version of the checker, never a candidate: a Quick answer cannot be checked by instructions from a file (D-280)', () => {
    expect(role.version).toMatch(/^ask-support-check\.v\d+$/u);
  });

  it('accepts a reply whose quotes are in a cited passage and about the sentence, and sets aside the sentence whose verdict code can see is made up', () => {
    const good = reply(
      supported(1, 'The axis leans twenty-three degrees and keeps pointing the same way all year long'),
      supported(2, 'keeps pointing the same way all year long'),
    );
    const judged = (...verdicts: unknown[]) => role.outputSchema.parse(reply(...verdicts)).sentences;
    expect(role.outputSchema.safeParse(good).success).toBe(true);
    expect(judged(...good.sentences).map((verdict) => verdict.verdict)).toEqual(['supported', 'supported']);
    // A quote that is not in any passage the sentence cites proves nothing: that sentence is unsupported, the other stands (D-265).
    expect(
      judged(supported(1, 'sunlight arrives steeper and the days run longer'), good.sentences[1]).map((verdict) =>
        verdict.verdict === 'unsupported' ? verdict.code : verdict.verdict,
      ),
    ).toEqual(['quote_not_in_cited_passages', 'supported']);
    // A reply that skips a sentence, or gives them out of order, is refused whole.
    expect(role.outputSchema.safeParse(reply(good.sentences[0])).success).toBe(false);
    expect(role.outputSchema.safeParse(reply(good.sentences[1], good.sentences[0])).success).toBe(false);
    // "States no fact" is accepted only where code can see the sentence states none: this one has a subject in the passage.
    expect(
      judged({ n: 1, verdict: 'no_claim' }, good.sentences[1]).map((verdict) =>
        verdict.verdict === 'unsupported' ? verdict.code : verdict.verdict,
      ),
    ).toEqual(['no_claim_without_ground', 'supported']);
  });

  it('is asked about no more sentences than one request carries, because a Quick answer is checked in one request', () => {
    expect(ASK_SUPPORT_BATCH_SENTENCES).toBe(10);
  });
});

describe('what a check came to', () => {
  const role = askSupportRole(sentencesOf(draft), passages);
  const unsupported = {
    n: 1,
    verdict: 'unsupported',
    kind: 'goes_beyond',
    problem: 'The passage says less than this.',
  };

  it('clears an answer only when a reply came and found nothing unsupported', () => {
    expect(
      findingOf(
        proposed(
          role.outputSchema.parse(
            reply(
              supported(1, 'The axis leans twenty-three degrees and keeps pointing the same way all year long'),
              supported(2, 'keeps pointing the same way all year long'),
            ),
          ),
        ),
      ),
    ).toEqual({
      finding: { kind: 'supported' },
      end: 'completed',
    });
    const found = findingOf(
      proposed(role.outputSchema.parse(reply(unsupported, supported(2, 'keeps pointing the same way all year long')))),
    );
    expect(found.finding).toMatchObject({ kind: 'unsupported', unsupported: [{ number: 1, kind: 'goes_beyond' }] });
    expect(found.end).toBe('completed');
  });

  it('finds a sentence unsupported when code set its verdict aside, and does not call the check unusable', () => {
    const found = findingOf(
      proposed(
        role.outputSchema.parse(
          reply(
            supported(1, 'words that no passage ever contained'),
            supported(2, 'keeps pointing the same way all year long'),
          ),
        ),
      ),
    );
    expect(found.finding).toMatchObject({
      kind: 'unsupported',
      unsupported: [{ number: 1, kind: 'not_stated', code: 'quote_not_in_cited_passages' }],
    });
    expect(found.end).toBe('completed');
  });

  it('is nothing known when the checker failed, was refused, ran out of budget or its attempt may have been sent: never a pass', () => {
    for (const [kind, end] of [
      ['failed', 'failed'],
      ['invalid_output', 'failed'],
      ['budget_exhausted', 'cancelled'],
      ['quota_unavailable', 'cancelled'],
      ['unknown', undefined],
      ['refused', undefined],
    ] as const)
      expect(findingOf({ kind } as never)).toEqual({ finding: { kind: 'unchecked' }, end });
  });
});

describe('asking the checker through the harness', () => {
  function harness(outcome: unknown) {
    const propose = vi.fn((_input: unknown) => Promise.resolve(outcome));
    return {
      propose,
      value: { proposePersonal: propose, contextDigest: () => 'b'.repeat(64) } as unknown as RecordingReasoningHarness,
    };
  }
  const input = (allowRepair: boolean) => ({
    authority,
    owner: {
      accountId: id(2),
      universeId: id(1),
      privacyEpoch: 1,
      recordId: id(50),
      recordingGeneration: 3,
    },
    quickAnswerId: 'quick-1',
    runId: 'run-1',
    draft: 1 as const,
    sentences: sentencesOf(draft),
    passages,
    allowRepair,
    signal: new AbortController().signal,
  });

  it('asks nothing about an answer of more sentences than one request carries, and says nothing is known (D-267)', async () => {
    const model = harness(proposed(reply()));
    const long = Array.from({ length: ASK_SUPPORT_BATCH_SENTENCES + 1 }, (_unused, index) => ({
      number: index + 1,
      text: `Sentence ${String(index + 1)} of an answer that ran on.`,
      cites: ['e1'],
    }));
    const result = await makeSupportCheck(model.value)({ ...input(true), sentences: long });
    expect(model.propose).not.toHaveBeenCalled();
    // No run was started, so none is closed: the result has no end.
    expect(result).toMatchObject({ finding: { kind: 'unchecked' }, run: { runId: 'run-1' } });
    expect(result.run.end).toBeUndefined();
  });

  it('makes one proposal on its own run and role, shows it only the passages the answer cites, and says how the run ended', async () => {
    const model = harness(
      proposed(
        reply(
          supported(1, 'The axis leans twenty-three degrees and keeps pointing the same way all year long'),
          supported(2, 'keeps pointing the same way all year long'),
        ),
      ),
    );
    const result = await makeSupportCheck(model.value)(input(true));
    expect(model.propose).toHaveBeenCalledTimes(1);
    const sent = (
      model.propose.mock.calls[0] as unknown as [
        {
          run: { id: string; purpose: string; ownerModule: string };
          role: { id: string };
          limits: { allowRepair: boolean };
          context: { items: { kind: string; text: string }[] };
          recordingPurpose: Record<string, unknown>;
        },
      ]
    )[0];
    // The run is stamped with the generation its Quick answer was asked at, and names that answer as its record (D-264).
    expect(sent.recordingPurpose).toMatchObject({
      ownerModule: 'supply',
      purpose: 'quick-answer-support',
      businessRunId: 'run-1',
      recordingGeneration: 3,
      accountId: id(2),
      claimId: id(50),
    });
    expect(sent.run).toMatchObject({ id: 'run-1', purpose: 'quick-answer-support', ownerModule: 'supply' });
    expect(sent.role.id).toBe('supply.quick-answer-support');
    expect(sent.limits).toEqual({ allowRepair: true });
    expect(sent.context.items.find((item) => item.kind === 'cited_passages')?.text).toBe(`[e1] ${passages[0]!.text}`);
    expect(result).toEqual({
      finding: { kind: 'supported' },
      run: { runId: 'run-1', purpose: sent.recordingPurpose, end: 'completed' },
    });
    // The second draft's check has no repair of its own.
    await makeSupportCheck(model.value)(input(false));
    expect((model.propose.mock.calls[1] as unknown as [{ limits: { allowRepair: boolean } }])[0].limits).toEqual({
      allowRepair: false,
    });
  });

  it('leaves the run open when the attempt may have reached the provider, so it is never resent', async () => {
    const result = await makeSupportCheck(harness({ kind: 'unknown' }).value)(input(true));
    expect(result).toEqual({
      finding: { kind: 'unchecked' },
      run: { runId: 'run-1', purpose: expect.objectContaining({ businessRunId: 'run-1' }) as unknown },
    });
  });
});

describe('what a rewrite is told', () => {
  it('is each unsupported sentence by its own words with the fixed hint of its kind, never the checker’s note, and the draft', () => {
    const sentences = sentencesOf(draft);
    const items = rewriteItems(
      sentences,
      [{ number: 2, verdict: 'unsupported', kind: 'not_stated', problem: 'NOTE-FROM-THE-CHECKER about Earth.' }],
      draft,
    );
    const problems = items.find((item) => item.kind === 'check_problems')!.text;
    expect(problems).toContain('Sentence "It keeps pointing the same way as Earth goes round the Sun."');
    expect(problems).toContain('No passage you cite states this');
    expect(problems).not.toContain('NOTE-FROM-THE-CHECKER');
    expect(JSON.parse(items.find((item) => item.kind === 'previous_draft')!.text)).toEqual(draft);
  });
});
