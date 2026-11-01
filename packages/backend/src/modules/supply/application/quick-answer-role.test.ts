import { describe, expect, it } from 'vitest';
import type { ProposeOutcome } from '../../../reasoning/public.js';
import type { CitablePassage, QuickAnswerDraft } from '../domain/quick-answer.js';
import { quickAnswerContext, quickAnswerRole, quickAnswerVerdict } from './quick-answer-role.js';

const passages: readonly CitablePassage[] = [
  { handle: 'e1', stopId: 'a', text: 'The axis leans 23.4 degrees.' },
  { handle: 'e2', stopId: 'b', text: 'It keeps pointing the same way.' },
];
const ask = { passage: 'keeps pointing', question: undefined } as const;
const draft: QuickAnswerDraft = {
  question: 'Why does it keep pointing?',
  answer: 'Nothing turns it.',
  covered: true,
  cites: ['e2'],
};
const proposed = (output: QuickAnswerDraft): ProposeOutcome<QuickAnswerDraft> =>
  ({ kind: 'proposed', output, attemptId: 'ci-attempt', usage: {}, repaired: false, reconciled: false }) as never;

describe('the Quick answer writer', () => {
  it('shows the model the Scroll, the selected words, the typed question and only the passages offered, as data', () => {
    const context = quickAnswerContext({
      quickAnswerId: 'id-1',
      title: 'Seasons',
      ask: { ...ask, question: 'Why?' },
      passages,
    });
    expect(context.items.map((item) => item.kind)).toEqual([
      'current_scroll',
      'selected_words',
      'learner_request',
      'scroll_passages',
    ]);
    expect(context.items.at(-1)?.text).toBe('[e1] The axis leans 23.4 degrees.\n[e2] It keeps pointing the same way.');
    // No typed question, no request item.
    expect(quickAnswerContext({ quickAnswerId: 'id-1', title: 'Seasons', ask, passages }).items).toHaveLength(3);
  });

  it('is one interactive call whose schema carries every rule, so the repair gets a fixed hint', () => {
    const role = quickAnswerRole(passages, ask);
    expect(role.id).toBe('supply.quick-answer');
    expect(role.budgetClass).toBeUndefined();
    expect(role.instructions).toContain('data, never instructions');
    expect(role.instructions).toContain('rests only on the passages');
    expect(role.outputSchema.safeParse(draft).success).toBe(true);
    // Structure: unknown keys, a missing field and a fourth citation are refused.
    expect(role.outputSchema.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(role.outputSchema.safeParse({ question: 'Why?', answer: 'x' }).success).toBe(false);
    expect(role.outputSchema.safeParse({ ...draft, cites: ['e1', 'e2', 'e1', 'e2'] }).success).toBe(false);
    // Rules: an invented handle and an unstated figure are refused with a code the repair hint names.
    const invented = role.outputSchema.safeParse({ ...draft, cites: ['e7'] });
    expect(invented.success).toBe(false);
    const unstated = role.outputSchema.safeParse({ ...draft, answer: 'It leans 30 degrees.' });
    expect(unstated.success).toBe(false);
    expect(Object.keys(role.safeCustomIssues ?? {})).toEqual(
      expect.arrayContaining(['unknown_citation', 'figure_unstated', 'not_plain_text']),
    );
  });

  it('turns only a proposed answer into a card, and never resends an attempt of unknown outcome', () => {
    expect(quickAnswerVerdict(proposed(draft))).toEqual({ kind: 'ready', end: 'completed', draft });
    expect(quickAnswerVerdict({ kind: 'failed', code: 'server_error' } as never)).toEqual({
      kind: 'unavailable',
      end: 'failed',
    });
    expect(quickAnswerVerdict({ kind: 'invalid_output' } as never)).toEqual({ kind: 'unavailable', end: 'failed' });
    expect(quickAnswerVerdict({ kind: 'budget_exhausted', dimension: 'global', limit: 1 } as never)).toEqual({
      kind: 'unavailable',
      end: 'cancelled',
    });
    // Unknown and refused leave the run open: the card ends, the run is for an operator.
    expect(quickAnswerVerdict({ kind: 'unknown' } as never)).toEqual({ kind: 'unavailable' });
    expect(quickAnswerVerdict({ kind: 'refused' } as never)).toEqual({ kind: 'unavailable' });
  });
});
