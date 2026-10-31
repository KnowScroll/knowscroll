import { describe, expect, it } from 'vitest';
import { flaggedCalls, summariseAnswerChecks, type AnswerCheckRecord, type CallVerdict } from './answer-check.js';

const ok = (id: string): CallVerdict => ({ id, consistent: true });
const flag = (id: string, problem = 'The key says B but the explanation says A.'): CallVerdict => ({
  id,
  consistent: false,
  problem,
});
const checked = (draft: 1 | 2, ...verdicts: CallVerdict[]): AnswerCheckRecord => ({ draft, kind: 'checked', verdicts });
const unchecked = (draft: 1 | 2, code = 'invalid_output'): AnswerCheckRecord => ({ draft, kind: 'unchecked', code });

describe('what an operator is told about a job’s answer check', () => {
  it('says nothing when no check ran (a v1 Scroll, or one made before the check)', () => {
    expect(summariseAnswerChecks([])).toBeUndefined();
  });

  it('passes a first draft whose every call is consistent, and counts the calls', () => {
    expect(summariseAnswerChecks([checked(1, ok('c1'), ok('c2'), ok('final'))])).toEqual({
      outcome: 'passed',
      calls: 3,
    });
  });

  it('calls a draft repaired when the first was flagged and the second passed, and keeps what was flagged', () => {
    expect(summariseAnswerChecks([checked(1, ok('c1'), flag('c2')), checked(2, ok('c1'), ok('c2'))])).toEqual({
      outcome: 'repaired',
      calls: 2,
      firstDraftFlags: [flag('c2')],
    });
  });

  it('calls a draft flagged when a flag stands, whether it is the first draft (no repair left) or the second', () => {
    expect(summariseAnswerChecks([checked(1, flag('c1'))])).toEqual({
      outcome: 'flagged',
      flags: [flag('c1')],
      firstDraftFlags: [],
    });
    expect(
      summariseAnswerChecks([checked(1, flag('c1')), checked(2, ok('c1'), flag('final', 'Another problem here.'))]),
    ).toEqual({
      outcome: 'flagged',
      flags: [flag('final', 'Another problem here.')],
      firstDraftFlags: [flag('c1')],
    });
  });

  it('reports a check that gave no usable answer as unchecked, with the reason, and never as passed', () => {
    expect(summariseAnswerChecks([unchecked(1, 'outcome_unknown')])).toEqual({
      outcome: 'unchecked',
      code: 'outcome_unknown',
      firstDraftFlags: [],
    });
    // The repaired draft could not be checked: the earlier flags are kept, so the reader knows what was repaired.
    expect(summariseAnswerChecks([checked(1, flag('c2')), unchecked(2, 'provider_failed')])).toEqual({
      outcome: 'unchecked',
      code: 'provider_failed',
      firstDraftFlags: [flag('c2')],
    });
  });

  it('lists only the flagged calls', () => {
    expect(flaggedCalls([ok('a'), flag('b'), ok('c'), flag('d')]).map((verdict) => verdict.id)).toEqual(['b', 'd']);
  });
});
