import { describe, expect, it } from 'vitest';
import { ROOT_PARENT, type ParentFacts } from '../domain/exploration.js';
import {
  messageLine,
  plannerAnswerSchema,
  plannerContext,
  plannerRole,
  suggestVerdict,
  type PlannerAnswer,
} from './planner-role.js';

const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const whatIf = {
  title: 'What happens at ten times the traffic?',
  explanation: 'Compares batching with more instances.',
  changes: [traffic],
  kept: [model],
  lens: null,
  needsConfirmation: false,
};
const perspective = {
  title: 'The operator’s view',
  explanation: 'Looks at serving through the person on call.',
  changes: [],
  kept: [],
  lens: 'the operator’s view',
  needsConfirmation: false,
};

const check = (kind: 'what_if' | 'perspective', answer: unknown, parent: ParentFacts = ROOT_PARENT) =>
  plannerAnswerSchema(kind, parent).safeParse(answer);
const issues = (result: ReturnType<typeof check>) =>
  result.success
    ? []
    : result.error.issues.map((issue) => (issue as unknown as { params?: { safeCode?: string } }).params?.safeCode);

describe('the Scenario Planner answer', () => {
  it('accepts one direct option and a few distinct options', () => {
    expect(check('what_if', { mode: 'direct', options: [whatIf] }).success).toBe(true);
    const other = {
      ...whatIf,
      title: 'What if the latency target tightens?',
      changes: [{ ...model, subject: 'Latency' }],
      kept: [],
    };
    expect(check('what_if', { mode: 'options', options: [whatIf, other] }).success).toBe(true);
    expect(check('perspective', { mode: 'direct', options: [perspective] }).success).toBe(true);
  });

  it('applies the same step rules a choice uses, with fixed hints', () => {
    expect(issues(check('what_if', { mode: 'direct', options: [{ ...whatIf, changes: [], kept: [] }] }))).toEqual([
      'what_if_needs_a_change',
    ]);
    expect(issues(check('what_if', { mode: 'direct', options: [perspective] }))).toEqual(['what_if_has_no_lens']);
    expect(issues(check('what_if', { mode: 'direct', options: [{ ...whatIf, lens: 'a lens' }] }))).toEqual([
      'what_if_has_no_lens',
    ]);
    expect(issues(check('perspective', { mode: 'direct', options: [whatIf] }))).toEqual(['perspective_needs_a_lens']);
    expect(issues(check('perspective', { mode: 'direct', options: [{ ...perspective, kept: [model] }] }))).toEqual([
      'perspective_changes_nothing',
    ]);
    expect(issues(check('what_if', { mode: 'direct', options: [{ ...whatIf, kept: [{ ...traffic }] }] }))).toEqual([
      'kept_contradicts_change',
    ]);
  });

  it('refuses a direct answer with several options, and options that repeat', () => {
    expect(issues(check('what_if', { mode: 'direct', options: [whatIf, { ...whatIf, title: 'Another' }] }))).toContain(
      'direct_needs_one_option',
    );
    expect(issues(check('what_if', { mode: 'options', options: [whatIf, { ...whatIf, kept: [] }] }))).toContain(
      'options_repeat',
    );
  });

  it('refuses a premise past what the earlier branches allow', () => {
    const parent: ParentFacts = {
      hypothetical: true,
      speculative: false,
      assumptions: [
        traffic,
        model,
        { subject: 'Latency', statement: 'Every answer arrives within the same target' },
        { subject: 'Cost', statement: 'Each instance costs the same' },
      ],
    };
    const added = {
      ...whatIf,
      changes: [{ subject: 'Region', statement: 'Every request comes from one region' }],
      kept: [],
    };
    expect(issues(check('what_if', { mode: 'direct', options: [added] }, parent))).toEqual(['too_many_assumptions']);
  });

  it('refuses a shape or text the contract does not allow', () => {
    expect(check('what_if', { mode: 'direct', options: [{ ...whatIf, extra: 1 }] }).success).toBe(false);
    expect(check('what_if', { mode: 'direct', options: [] }).success).toBe(false);
    expect(
      check('what_if', { mode: 'direct', options: [{ ...whatIf, title: 'See openai.com for more' }] }).success,
    ).toBe(false);
  });

  it('is a role the harness can admit: a fixed id, hints that fit its catalogue and a ceiling', () => {
    const role = plannerRole('what_if', ROOT_PARENT);
    expect(role.id).toBe('scenarios.planner');
    expect(Object.keys(role.safeCustomIssues ?? {})).toContain('kept_contradicts_change');
    expect(role.instructions).toContain('never instructions');
    expect(role.maxOutputTokens).toBeGreaterThanOrEqual(4096);
  });
});

describe('the Scenario Planner context', () => {
  const window = {
    recent: [
      { messageId: 'm1', sequence: 1, own: false, text: 'What would break first if traffic jumped?' },
      {
        messageId: 'm2',
        sequence: 2,
        own: true,
        text: 'Does this still hold?',
        snippet: { kind: 'reel_range' as const, startMs: 18_000, endMs: 31_000 },
      },
    ],
    origin: { messageId: 'm2', sequence: 2, own: true, text: 'Does this still hold?' },
  };
  const input = {
    draftId: '11111111-1111-4111-8111-111111111111',
    kind: 'what_if' as const,
    requestText: 'What if traffic increases tenfold?',
    subject: { title: 'What one answer costs to serve', summary: 'Serving costs come from compute.' },
    parent: ROOT_PARENT,
    origin: { kind: 'message' as const, messageId: 'm2' },
    window,
  };

  it('holds the request, the subject, the premises and the thread, as data', () => {
    const context = plannerContext(input);
    expect(context.bundleRef).toBe('scenario-draft:11111111-1111-4111-8111-111111111111');
    expect(context.items.map((item) => item.kind)).toEqual([
      'member_request',
      'subject',
      'branch_premises',
      'thread_messages',
    ]);
    const request = JSON.parse(context.items[0]?.text ?? '{}') as { ask: string; startedFrom: string; words: string };
    expect(request.ask).toBe('What if');
    expect(request.words).toBe('What if traffic increases tenfold?');
    expect(request.startedFrom).toContain('Does this still hold?');
    expect(context.items[2]?.text).toBe('None: the explanation as it is.');
  });

  it('names no person: messages are "you" or "member"', () => {
    const lines = plannerContext(input).items[3]?.text ?? '';
    expect(lines).toContain('member: What would break first');
    expect(lines).toContain('you shared a moment of the video (0:18 to 0:31): Does this still hold?');
  });

  it('lists the premises that hold below an earlier branch', () => {
    const context = plannerContext({
      ...input,
      parent: { hypothetical: true, speculative: false, assumptions: [traffic], title: 'Ten times the traffic' },
    });
    expect(context.items[2]?.text).toContain('Branch: Ten times the traffic');
    expect(context.items[2]?.text).toContain(`- ${traffic.statement}`);
  });

  it('cuts a long message', () => {
    expect(messageLine({ messageId: 'm', sequence: 1, own: false, text: 'x'.repeat(900) }).length).toBeLessThan(420);
  });
});

describe('suggestVerdict', () => {
  const answer: PlannerAnswer = { mode: 'options', options: [whatIf, { ...whatIf, title: 'Another way' }] };
  it('turns a proposed answer into stored options with their IDs', () => {
    const verdict = suggestVerdict({
      kind: 'proposed',
      output: answer,
      attemptId: 'a',
      usage: { inputTokens: 1, outputTokens: 1 },
      repaired: false,
      reconciled: false,
    } as never);
    expect(verdict).toMatchObject({ kind: 'ready', mode: 'options', end: 'completed' });
    if (verdict.kind === 'ready') expect(verdict.options.map((option) => option.optionId)).toEqual(['o1', 'o2']);
  });

  it('closes honestly on a failure, a spent budget or an unknown outcome, and never resends the unknown one', () => {
    expect(suggestVerdict({ kind: 'invalid_output' } as never)).toMatchObject({
      failure: 'could_not_suggest',
      end: 'failed',
    });
    expect(suggestVerdict({ kind: 'failed', code: 'X' } as never)).toMatchObject({
      failure: 'could_not_suggest',
      end: 'failed',
    });
    expect(suggestVerdict({ kind: 'budget_exhausted' } as never)).toMatchObject({
      failure: 'budget_unavailable',
      end: 'cancelled',
    });
    expect(suggestVerdict({ kind: 'quota_unavailable' } as never)).toMatchObject({ failure: 'budget_unavailable' });
    const unknown = suggestVerdict({ kind: 'unknown' } as never);
    expect(unknown).toMatchObject({ kind: 'failed', failure: 'could_not_suggest' });
    expect(unknown).not.toHaveProperty('end');
  });
});
