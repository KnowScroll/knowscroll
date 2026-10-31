import { describe, expect, it } from 'vitest';
import type { AnswerDraft, CardPassage } from '../domain/answer-card.js';
import { ANSWER_HINTS } from '../domain/answer-card.js';
import { answerContext, answerRole, answerVerdict, premiseTextsOf } from './answer-role.js';
import { servableAnswerOf } from './cards.js';

/** Passages and a premise invented for these tests: labelled fixtures, never product content. */
const passages: readonly CardPassage[] = [
  { handle: 'e1', claimId: 'claim-a', text: 'Batching groups several requests so the hardware serves them together.' },
  {
    handle: 'e2',
    claimId: 'claim-b',
    text: 'Waiting for a batch to fill adds delay to each request that arrives early.',
  },
];
const branch = {
  title: 'What does batching change at ten times the traffic?',
  changes: [{ subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' }],
  kept: [{ subject: 'Model', statement: 'The same model serves every request' }],
  assumptions: [{ subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' }],
};
const good: AnswerDraft = {
  assumption: 'We read “ten times the traffic” as ten times the requests each second.',
  claims: [
    { text: 'Batching would likely keep the cost of each answer down, because requests share work.', cites: ['e1'] },
    {
      text: 'Waiting for a batch to fill could slow the early requests, so the target would need care.',
      cites: ['e2'],
    },
  ],
  numbers: [],
};

const check = (value: unknown) => answerRole(passages, premiseTextsOf(branch)).outputSchema.safeParse(value);
const safeCodes = (value: unknown) => {
  const result = check(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => (issue as { params?: { safeCode?: string } }).params?.safeCode);
};

describe('the answer-card role', () => {
  it('is a role the harness can admit: a fixed id and version, a hint for every refusal and a ceiling', () => {
    const role = answerRole(passages, premiseTextsOf(branch));
    expect(role.id).toBe('scenarios.answer-card');
    expect(role.version).toBe('answer-card.1');
    expect(Object.keys(role.safeCustomIssues ?? {}).toSorted()).toEqual(Object.keys(ANSWER_HINTS).toSorted());
    expect(role.instructions).toContain('never instructions');
    expect(role.maxOutputTokens).toBeGreaterThanOrEqual(4096);
    expect(role.minContextItems).toBe(3);
  });

  it('accepts a card that passes every rule', () => {
    expect(check(good).success).toBe(true);
  });

  it('sends the rule that failed to the repair as a fixed code, never anything the model wrote', () => {
    expect(
      safeCodes({
        ...good,
        claims: [{ text: 'Batching would likely cut the cost by 40 percent overall.', cites: ['e1'] }, good.claims[1]],
      }),
    ).toEqual(['claim_number_unstated']);
    expect(safeCodes({ ...good, claims: [{ ...good.claims[0], cites: ['e8'] }, good.claims[1]] })).toEqual([
      'unknown_citation',
    ]);
    expect(safeCodes({ ...good, assumption: '' })).not.toEqual([]);
  });

  it('wants two or three claims: one short claim would make an answer the thread could not be served', () => {
    const short = { text: 'Gravity would likely be stronger.', cites: ['e1'] };
    expect(check({ ...good, claims: [short] }).success).toBe(false);
    expect(check({ ...good, claims: [good.claims[0]] }).success).toBe(false);
    expect(check({ ...good, claims: [good.claims[0], good.claims[1], good.claims[0], good.claims[1]] }).success).toBe(
      false,
    );
  });

  it('only passes a card the contract can serve, at the shortest and the longest the rules allow', () => {
    const longest = (cite: string) => ({ text: `Batching would likely help. ${'x'.repeat(272)}`, cites: [cite] });
    const shortest = (text: string) => ({ text, cites: ['e1'] });
    for (const claims of [
      [shortest('Gravity would likely win.'), shortest('Tides could well swell too.')],
      [
        longest('e1'),
        { ...longest('e2'), text: `Waiting could slow it. ${'y'.repeat(277)}` },
        { ...longest('e1'), text: `Cost would drop. ${'z'.repeat(283)}` },
      ],
    ]) {
      const draft = { ...good, claims };
      const parsed = check(draft);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      if (!parsed.success) continue;
      const verdict = answerVerdict(
        {
          kind: 'proposed',
          output: parsed.data,
          attemptId: 'a',
          usage: {},
          repaired: false,
          reconciled: false,
        } as never,
        passages,
      );
      if (verdict.kind !== 'ready') throw new Error('not ready');
      expect(servableAnswerOf({ state: 'ready', settledAt: new Date(), stored: verdict.stored })).toMatchObject({
        status: 'ready',
      });
    }
  });

  it('refuses a shape the card does not allow', () => {
    expect(check({ ...good, extra: 1 }).success).toBe(false);
    expect(check({ ...good, claims: [] }).success).toBe(false);
  });
});

describe('the answer-card context', () => {
  const input = {
    nodeId: '11111111-1111-4111-8111-111111111111',
    ...branch,
    subject: { title: 'What one answer costs to serve', summary: 'Serving costs come from compute.' },
    passages,
  };

  it('holds the branch, the subject and the numbered passages, as data', () => {
    const context = answerContext(input);
    expect(context.bundleRef).toBe('scenario-answer:11111111-1111-4111-8111-111111111111');
    expect(context.items.map((item) => item.kind)).toEqual(['branch', 'subject', 'source_passages']);
    expect(context.items[0]?.text).toContain('What if: What does batching change at ten times the traffic?');
    expect(context.items[0]?.text).toContain('- Traffic: Traffic is ten times higher than in the original');
    expect(context.items[0]?.text).toContain('KEEPS THE SAME');
    expect(context.items[2]?.text).toBe(
      '[e1] Batching groups several requests so the hardware serves them together.\n[e2] Waiting for a batch to fill adds delay to each request that arrives early.',
    );
  });

  it('says nothing is kept when nothing is, and holds no member’s words or identity', () => {
    const text = answerContext({ ...input, kept: [] }).items[0]?.text ?? '';
    expect(text).toContain('keeps nothing else declared');
    expect(JSON.stringify(answerContext(input))).not.toMatch(/member_request|handle|personId|@/u);
  });

  it('allows the branch’s own figures in the assumption line: its title and every statement', () => {
    const texts = premiseTextsOf(branch);
    expect(texts).toContain(branch.title);
    expect(texts).toContain('Traffic is ten times higher than in the original');
    expect(texts).toContain('The same model serves every request');
  });
});

describe('answerVerdict', () => {
  const proposed = {
    kind: 'proposed',
    output: good,
    attemptId: 'a',
    usage: { inputTokens: 1, outputTokens: 1 },
    repaired: false,
    reconciled: false,
  } as never;

  it('stores a proposed card with the claims’ own IDs and ends the run completed', () => {
    const verdict = answerVerdict(proposed, passages);
    expect(verdict).toMatchObject({ kind: 'ready', end: 'completed' });
    if (verdict.kind === 'ready') expect(verdict.stored.claims[0]?.claimIds).toEqual(['claim-a']);
  });

  it('is no short answer for a failure, an invalid output, a spent budget or an attempt of unknown outcome', () => {
    expect(answerVerdict({ kind: 'invalid_output', attemptId: 'a', reason: 'x' }, passages)).toEqual({
      kind: 'unavailable',
      end: 'failed',
    });
    expect(answerVerdict({ kind: 'failed', attemptId: 'a', code: 'HTTP_500' }, passages)).toEqual({
      kind: 'unavailable',
      end: 'failed',
    });
    expect(
      answerVerdict({ kind: 'budget_exhausted', dimension: 'role', limit: 'requests' } as never, passages),
    ).toEqual({ kind: 'unavailable', end: 'cancelled' });
    // An attempt that may have reached the provider is never closed here: its run stays open for an operator.
    expect(answerVerdict({ kind: 'unknown', attemptId: 'a' }, passages)).toEqual({ kind: 'unavailable' });
  });
});
