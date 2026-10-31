import { describe, expect, it } from 'vitest';
import { makeAnswerCheckStep } from './answer-check-step.js';
import { evidencePassages } from './evidence.js';
import {
  ANSWER_CHECK_INSTRUCTIONS,
  ANSWER_CHECK_ROLE_ID,
  answerCheckContext,
  answerCheckRole,
  answerCheckSchema,
  answerChecksOf,
  callsOfStoredDocument,
  checkRepairItems,
  checkRepairRole,
  verdictsOf,
} from './answer-check.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { storedScrollV2 } from './stored-v2.js';
import { publicationV2, writerRoleV2, type WriterV2Context } from './writer-v2.js';

const context: WriterV2Context = {
  publication: publicationV2('seasons'),
  recipe: { variant: 'stage', misconception: { kind: 'none' } },
  passages: evidencePassages([fixtureResearchPageV2]),
  pages: [fixtureResearchPageV2],
};

/** The labelled Orrin fixture (invented, never product content), compiled the way production stores it. */
function orrinDocument(): unknown {
  const outcome = storedScrollV2(fixtureAuthoredV2(), context, {
    runId: 'run-ci-1',
    attemptIds: ['attempt-ci-1'],
    model: 'MiniMax-M3.1-Flash',
  });
  if (outcome.kind !== 'compiled') throw new Error('CI expected a compile');
  return outcome.document;
}

describe('what the answer checker is shown (labelled CI fixture)', () => {
  const calls = callsOfStoredDocument(orrinDocument());

  it('lists every call and the Final call in reading order, with the stop that came before', () => {
    expect(calls.map((call) => call.kind)).toEqual(['call_it', 'call_it', 'final_call']);
    expect(calls.map((call) => call.id)).toHaveLength(new Set(calls.map((call) => call.id)).size);
    // The first call follows the hook; the second follows the stop about the lean of the axis.
    expect(calls[0]!.stopBefore).toContain('Orrin has long warm summers');
    expect(calls[1]!.stopBefore).toContain('lean of the axis');
    for (const call of calls) {
      expect(call.options.length).toBeGreaterThanOrEqual(2);
      expect(call.answer).toBeGreaterThanOrEqual(0);
      expect(call.answer).toBeLessThan(call.options.length);
    }
  });

  it('names no calls for a document that is not a v2 Scroll', () => {
    expect(callsOfStoredDocument({ schemaVersion: 'scroll-document.v1' })).toEqual([]);
    expect(callsOfStoredDocument(null)).toEqual([]);
  });

  it('puts each call in its own context item, as data: lettered options, the marked letter, the explanation and the twist', () => {
    const items = answerCheckContext(calls);
    expect(items.map((item) => item.ref)).toEqual(calls.map((call) => `answer-check:${call.id}`));
    for (const [index, item] of items.entries()) {
      const call = calls[index]!;
      const shown = JSON.parse(item.text) as Record<string, unknown>;
      expect(shown['markedAnswer']).toBe(String.fromCharCode(65 + call.answer));
      expect(shown['options']).toEqual(call.options.map((option, at) => `${String.fromCharCode(65 + at)}. ${option}`));
      expect(shown['explanation']).toBe(call.explain);
      expect(shown['twist']).toBe(call.twist);
      expect(shown['stopBefore']).toBe(call.stopBefore);
      expect(shown['prompt']).toBe(call.prompt);
    }
  });

  it('is a role of its own, so its failure brake and budget never touch the writer’s', () => {
    const role = answerCheckRole(calls.map((call) => call.id));
    expect(role.id).toBe(ANSWER_CHECK_ROLE_ID);
    expect(role.id).not.toBe('content.scroll-writer');
    expect(role.budgetClass).toBeUndefined();
    expect(role.instructions).toBe(ANSWER_CHECK_INSTRUCTIONS);
    // It judges agreement, not sources: it is told no source passage.
    expect(ANSWER_CHECK_INSTRUCTIONS).not.toMatch(/passage|evidence|cite/iu);
  });
});

describe('the checker’s answer is strict JSON in a closed shape', () => {
  const ids = ['c1', 'c2', 'final'];
  const schema = answerCheckSchema(ids);
  const consistent = (id: string) => ({ id, consistent: true });
  const flagged = (id: string, problem = 'The explanation says A is right, but B is marked.') => ({
    id,
    consistent: false,
    problem,
  });

  it('accepts one verdict per call, in order, with a problem exactly where a call is flagged', () => {
    expect(schema.safeParse({ calls: [consistent('c1'), flagged('c2'), consistent('final')] }).success).toBe(true);
    expect(schema.safeParse({ calls: ids.map(consistent) }).success).toBe(true);
  });

  it('refuses a missing, repeated, extra, unknown or out-of-order call', () => {
    expect(schema.safeParse({ calls: [consistent('c1'), consistent('c2')] }).success).toBe(false);
    expect(schema.safeParse({ calls: [consistent('c1'), consistent('c1'), consistent('final')] }).success).toBe(false);
    expect(schema.safeParse({ calls: [...ids.map(consistent), consistent('c4')] }).success).toBe(false);
    expect(schema.safeParse({ calls: [consistent('c1'), consistent('c2'), consistent('c9')] }).success).toBe(false);
    expect(schema.safeParse({ calls: [consistent('c2'), consistent('c1'), consistent('final')] }).success).toBe(false);
    expect(schema.safeParse({ calls: [] }).success).toBe(false);
  });

  it('refuses a flag with no problem, a problem on a consistent call, a problem that is too short or too long, and any other field', () => {
    expect(
      schema.safeParse({ calls: [consistent('c1'), { id: 'c2', consistent: false }, consistent('final')] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        calls: [
          consistent('c1'),
          { id: 'c2', consistent: true, problem: 'A problem on a good call.' },
          consistent('final'),
        ],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ calls: [consistent('c1'), flagged('c2', 'short'), consistent('final')] }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ calls: [consistent('c1'), flagged('c2', 'x'.repeat(301)), consistent('final')] }).success,
    ).toBe(false);
    expect(schema.safeParse({ calls: ids.map(consistent), verdict: 'fine' }).success).toBe(false);
    expect(
      schema.safeParse({ calls: [{ ...consistent('c1'), score: 0.9 }, consistent('c2'), consistent('final')] }).success,
    ).toBe(false);
  });

  it('turns an accepted answer into the verdicts a job records, keeping the flagged call and only that call', () => {
    const answer = schema.parse({ calls: [consistent('c1'), flagged('c2'), consistent('final')] });
    const shown = ids.map((id, index) => ({
      id,
      kind: 'call_it' as const,
      stopBefore: `The text before ${id}.`,
      prompt: `Question of ${id}?`,
      options: [`First option of ${id}`, `Second option of ${id}`],
      answer: index % 2,
      explain: `Why ${id} is what it is.`,
      twist: `A twist for ${id}.`,
    }));
    expect(verdictsOf(answer, shown)).toEqual([
      { id: 'c1', consistent: true },
      {
        id: 'c2',
        consistent: false,
        problem: 'The explanation says A is right, but B is marked.',
        // The question, the options, the marked answer and the explanation: not the twist, nor the stop before.
        call: {
          prompt: 'Question of c2?',
          options: ['First option of c2', 'Second option of c2'],
          answer: 1,
          explain: 'Why c2 is what it is.',
        },
      },
      { id: 'final', consistent: true },
    ]);
  });
});

describe('the one repair a flagged answer key earns', () => {
  const calls = callsOfStoredDocument(orrinDocument());

  it('keeps the writer’s role and its checks, and marks the revision in its version and its instructions', () => {
    const writer = writerRoleV2(context);
    const repair = checkRepairRole(writer);
    expect(repair.id).toBe(writer.id);
    expect(repair.version).toBe(`${writer.version}.fix`);
    expect(repair.version.length).toBeLessThanOrEqual(32);
    expect(repair.outputSchema).toBe(writer.outputSchema);
    expect(repair.instructions.startsWith(writer.instructions)).toBe(true);
    expect(repair.instructions).toContain('REVISION AFTER AN ANSWER CHECK');
  });

  it('hands the writer each flagged call by its question, and its own draft, as two items of data', () => {
    const draft = fixtureAuthoredV2();
    const items = checkRepairItems(
      calls,
      [{ id: calls[1]!.id, consistent: false, problem: 'The key and the explanation disagree.' }],
      draft,
    );
    expect(items.map((item) => item.kind)).toEqual(['check_problems', 'previous_draft']);
    expect(items[0]!.text).toBe(`Call "${calls[1]!.prompt}": The key and the explanation disagree.`);
    expect(JSON.parse(items[1]!.text)).toEqual(JSON.parse(JSON.stringify(draft)));
  });
});

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

describe('a draft with no call to check', () => {
  it('is recorded as unchecked without asking the model anything', async () => {
    const harness = {
      proposeProduction: () => Promise.reject(new Error('CI: no request may be sent for a draft with no call')),
      readProductionRunAccounting: () => Promise.reject(new Error('CI: nothing to account')),
      closeProductionRun: () => Promise.reject(new Error('CI: nothing to close')),
    };
    const step = makeAnswerCheckStep({
      authority: { scopeId: 'scroll-supply', generation: 1 },
      withScope: () => Promise.reject(new Error('CI: no scope is needed')),
      harness,
    });
    const outcome = await step.check({
      jobId: 'a'.repeat(8),
      policyVersion: 'scroll-production.v17',
      draft: 1,
      calls: [],
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      kind: 'done',
      record: { draft: 1, kind: 'unchecked', code: 'no_calls' },
      receipt: { role: 'answer_check', kind: 'unchecked', code: 'no_calls' },
    });
  });
});
