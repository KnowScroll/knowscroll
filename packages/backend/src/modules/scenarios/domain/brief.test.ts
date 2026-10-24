import { describe, expect, it } from 'vitest';
import { framingOf, kickerOf, writerBrief } from './brief.js';
import { planStep, ROOT_PARENT, type Step } from './exploration.js';

const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const stepOf = (request: Parameters<typeof planStep>[1], parent = ROOT_PARENT): Step => {
  const outcome = planStep(parent, request);
  if (!outcome.ok) throw new Error('CI step refused');
  return outcome.step;
};

describe('framingOf', () => {
  it('states a what-if as hypothetical assumptions and what is kept', () => {
    expect(framingOf(stepOf({ kind: 'what_if', changes: [traffic], kept: [model] }))).toEqual({
      kind: 'hypothetical',
      assumptions: [traffic.statement],
      kept: [model.statement],
    });
  });

  it('lists what an earlier branch assumed once, and not again as kept', () => {
    const parent = { hypothetical: true, assumptions: [model] };
    const framing = framingOf(stepOf({ kind: 'what_if', changes: [traffic], kept: [model] }, parent));
    expect(framing).toEqual({
      kind: 'hypothetical',
      assumptions: [model.statement, traffic.statement],
      kept: [],
    });
  });

  it('names the lens of a perspective on the real subject', () => {
    expect(framingOf(stepOf({ kind: 'perspective', changes: [], kept: [], lens: 'the operator’s view' }))).toEqual({
      kind: 'perspective',
      lens: 'the operator’s view',
    });
  });

  it('keeps a perspective below a what-if hypothetical, with the whole premise', () => {
    const parent = { hypothetical: true, assumptions: [traffic, model] };
    const framing = framingOf(stepOf({ kind: 'perspective', changes: [], kept: [], lens: 'cost' }, parent));
    expect(framing).toEqual({ kind: 'hypothetical', assumptions: [traffic.statement, model.statement], kept: [] });
  });
});

describe('writerBrief', () => {
  const facts = {
    title: 'What happens at ten times the traffic?',
    explanation: 'Compares batching with more instances.',
    subjectTitle: 'What one answer costs to serve',
    subjectSummary: 'Serving costs come from compute, memory and waiting.',
  };

  it('tells the writer the subject, the direction, the premise and what stays the same', () => {
    const brief = writerBrief({ ...facts, step: stepOf({ kind: 'what_if', changes: [traffic], kept: [model] }) });
    expect(brief).toContain('KIND: What if');
    expect(brief).toContain('SUBJECT: What one answer costs to serve. Serving costs come from compute');
    expect(brief).toContain('DIRECTION: What happens at ten times the traffic?. Compares batching');
    expect(brief).toContain(
      `PREMISE (what this idea changes; it is not true of the real world):\n- ${traffic.statement}`,
    );
    expect(brief).toContain(`KEPT THE SAME:\n- ${model.statement}`);
    expect(brief).not.toContain('PREMISES INHERITED');
  });

  it('lists the premises inherited from earlier branches apart from this step’s own', () => {
    const parent = { hypothetical: true, assumptions: [traffic] };
    const brief = writerBrief({
      ...facts,
      parentTitle: 'Ten times the traffic',
      step: stepOf({ kind: 'what_if', changes: [model], kept: [] }, parent),
    });
    expect(brief).toContain('CONTINUES THE BRANCH: Ten times the traffic');
    expect(brief).toContain(`PREMISES INHERITED FROM EARLIER BRANCHES (also hypothetical):\n- ${traffic.statement}`);
    expect(brief.indexOf('PREMISE (what this idea changes')).toBeLessThan(brief.indexOf('PREMISES INHERITED'));
  });

  it('gives a perspective its lens and no premise of its own', () => {
    const brief = writerBrief({
      ...facts,
      step: stepOf({ kind: 'perspective', changes: [], kept: [], lens: 'the operator’s view' }),
    });
    expect(brief).toContain('KIND: Another perspective');
    expect(brief).toContain('LENS: the operator’s view');
    expect(brief).not.toContain('PREMISE');
  });
});

describe('kickerOf', () => {
  it('says the kind in the reader’s words', () => {
    expect(kickerOf(stepOf({ kind: 'what_if', changes: [traffic], kept: [] }))).toBe('What if');
    expect(kickerOf(stepOf({ kind: 'perspective', changes: [], kept: [], lens: 'cost' }))).toBe('Another perspective');
  });
});
