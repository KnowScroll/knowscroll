import { describe, expect, it } from 'vitest';
import { summariseAnswerChecks } from '../domain/answer-check.js';
import { answerChecksOf, emptyAnswerCheckReceipt } from './answer-check.js';

describe('reading the checks back from a job’s outcomes', () => {
  it('finds the answer-check receipts among the other receipts, in draft order, and ignores everything else', () => {
    const verdicts = [{ id: 'c1', consistent: true }];
    expect(
      answerChecksOf([
        { role: 'writer', kind: 'proposed' },
        { role: 'answer_check', kind: 'checked', draft: 2, verdicts, attempts: [] },
        { role: 'answer_check', kind: 'unchecked', draft: 1, code: 'invalid_output' },
        { role: 'answer_check', kind: 'nonsense', draft: 1 },
        'not a receipt',
      ]),
    ).toEqual([
      { draft: 1, kind: 'unchecked', code: 'invalid_output' },
      { draft: 2, kind: 'checked', verdicts },
    ]);
    // A flagged call's question, options, marked answer and explanation survive the round trip.
    const flag = {
      id: 'c2',
      consistent: false,
      problem: 'The key and the explanation disagree.',
      call: { prompt: 'Why?', options: ['One', 'Two'], answer: 1, explain: 'Because.' },
    };
    expect(answerChecksOf([{ role: 'answer_check', kind: 'checked', draft: 1, verdicts: [flag] }])).toEqual([
      { draft: 1, kind: 'checked', verdicts: [flag] },
    ]);
    expect(answerChecksOf(null)).toEqual([]);
    expect(answerChecksOf({})).toEqual([]);
  });
});

describe('the answer check of a document v3 Scroll (D-435, #815)', () => {
  // A document v3 has no calls (decision I1), so its answer check is the empty one: passed, with no request. The model step that asked
  // a checker about a v2 Scroll's answer keys is deleted with the v2 writer.
  it('is a receipt of a passed check with no verdict, which is what the release policy reads back as passed', () => {
    const receipt = emptyAnswerCheckReceipt(1);
    expect(receipt).toEqual({ role: 'answer_check', kind: 'checked', draft: 1, verdicts: [] });
    expect(answerChecksOf([receipt])).toEqual([{ draft: 1, kind: 'checked', verdicts: [] }]);
    expect(summariseAnswerChecks(answerChecksOf([receipt]))).toEqual({ outcome: 'passed', calls: 0 });
  });
});
