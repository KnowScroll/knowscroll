import { describe, expect, it } from 'vitest';
import { applyChanges, wordsKey, type Assumption } from './assumptions.js';
import { meaningOf, planStep, ROOT_PARENT, type ParentFacts } from './exploration.js';

const traffic: Assumption = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model: Assumption = { subject: 'Model', statement: 'The same model serves every request' };
const latency: Assumption = { subject: 'Latency target', statement: 'Every answer arrives within the same target' };

describe('assumptions', () => {
  it('compares subjects by meaning of the words, not case or spacing', () => {
    expect(wordsKey('  Latency   Target ')).toBe(wordsKey('latency target'));
    expect(wordsKey('ﬁle size')).toBe(wordsKey('file size'));
  });

  it('replaces an assumption of a subject already held and adds a new subject, keeping order', () => {
    const held = [traffic, model];
    const next = applyChanges(held, [{ subject: 'traffic', statement: 'Traffic is a hundred times higher' }, latency]);
    expect(next.map((item) => item.subject)).toEqual(['traffic', 'Model', 'Latency target']);
    expect(next[0]?.statement).toBe('Traffic is a hundred times higher');
    expect(held).toHaveLength(2);
  });
});

describe('planStep (blueprint §14: A_child = ApplyChange(A_parent, RequestedChange))', () => {
  it('makes a what-if hypothetical with the change applied to nothing at the root', () => {
    const outcome = planStep(ROOT_PARENT, { kind: 'what_if', changes: [traffic], kept: [model] });
    expect(outcome).toMatchObject({ ok: true, step: { kind: 'what_if', hypothetical: true, kept: [model] } });
    if (outcome.ok) expect(outcome.step.assumptions).toEqual([traffic]);
  });

  it('keeps the parent assumptions exactly in a perspective, and names the lens', () => {
    const parent: ParentFacts = { hypothetical: true, assumptions: [traffic, model] };
    const outcome = planStep(parent, { kind: 'perspective', changes: [], kept: [], lens: 'the operator’s view' });
    expect(outcome).toMatchObject({ ok: true, step: { kind: 'perspective', lens: 'the operator’s view' } });
    if (outcome.ok) {
      expect(outcome.step.assumptions).toEqual(parent.assumptions);
      expect(outcome.step.changes).toEqual([]);
    }
  });

  it('carries hypothetical status through every descendant, even a step that only changes the lens', () => {
    const below: ParentFacts = { hypothetical: true, assumptions: [traffic] };
    const lens = planStep(below, { kind: 'perspective', changes: [], kept: [], lens: 'the cost view' });
    expect(lens).toMatchObject({ ok: true, step: { hypothetical: true } });
    const deeper = planStep(below, { kind: 'what_if', changes: [latency], kept: [] });
    expect(deeper).toMatchObject({ ok: true, step: { hypothetical: true } });
  });

  it('does not make a perspective on the real subject hypothetical', () => {
    expect(planStep(ROOT_PARENT, { kind: 'perspective', changes: [], kept: [], lens: 'the cost view' })).toMatchObject({
      ok: true,
      step: { hypothetical: false, assumptions: [] },
    });
  });

  it('refuses what the rules forbid, with a code', () => {
    const refusal = (request: Parameters<typeof planStep>[1], parent: ParentFacts = ROOT_PARENT) => {
      const outcome = planStep(parent, request);
      return outcome.ok ? 'ok' : outcome.refusal;
    };
    expect(refusal({ kind: 'what_if', changes: [], kept: [] })).toBe('what_if_needs_a_change');
    expect(refusal({ kind: 'what_if', changes: [traffic], kept: [], lens: 'a lens' })).toBe('what_if_has_no_lens');
    expect(refusal({ kind: 'perspective', changes: [], kept: [] })).toBe('perspective_needs_a_lens');
    expect(refusal({ kind: 'perspective', changes: [traffic], kept: [], lens: 'a lens' })).toBe(
      'perspective_changes_nothing',
    );
    expect(refusal({ kind: 'perspective', changes: [], kept: [model], lens: 'a lens' })).toBe(
      'perspective_changes_nothing',
    );
    expect(refusal({ kind: 'what_if', changes: [traffic, model, latency], kept: [] })).toBe('too_many_changes');
    expect(refusal({ kind: 'what_if', changes: [traffic], kept: [model, model, latency, traffic] })).toBe(
      'too_many_kept',
    );
    expect(refusal({ kind: 'what_if', changes: [traffic, { ...traffic, subject: 'TRAFFIC' }], kept: [] })).toBe(
      'repeated_change',
    );
    expect(refusal({ kind: 'what_if', changes: [traffic], kept: [model, { ...model, subject: ' model' }] })).toBe(
      'repeated_kept',
    );
    expect(
      refusal({ kind: 'what_if', changes: [traffic], kept: [{ ...traffic, statement: 'Traffic stays low' }] }),
    ).toBe('kept_contradicts_change');
  });

  it('refuses a step that would pass the four premises a Scroll can state', () => {
    const full: ParentFacts = {
      hypothetical: true,
      assumptions: [traffic, model, latency, { subject: 'Cost', statement: 'Each instance costs the same' }],
    };
    const added = planStep(full, {
      kind: 'what_if',
      changes: [{ subject: 'Region', statement: 'Every request comes from one region' }],
      kept: [],
    });
    expect(added).toEqual({ ok: false, refusal: 'too_many_assumptions' });
    // Changing a subject that is already assumed replaces it and stays within the cap.
    expect(
      planStep(full, { kind: 'what_if', changes: [{ ...traffic, statement: 'Traffic halves' }], kept: [] }).ok,
    ).toBe(true);
  });
});

describe('meaningOf', () => {
  const key = (parent: string | null, request: Parameters<typeof planStep>[1]) => {
    const outcome = planStep(ROOT_PARENT, request);
    if (!outcome.ok) throw new Error('CI step refused');
    return meaningOf(parent, outcome.step);
  };

  it('is the same for the same change however it is spaced, and whatever is declared kept', () => {
    const a = key(null, { kind: 'what_if', changes: [traffic], kept: [model] });
    const b = key(null, {
      kind: 'what_if',
      changes: [{ subject: ' traffic', statement: 'TRAFFIC is ten times higher than in the original' }],
      kept: [],
    });
    expect(a).toBe(b);
  });

  it('differs by parent, kind, change and lens', () => {
    const base = key(null, { kind: 'what_if', changes: [traffic], kept: [] });
    expect(key('node-1', { kind: 'what_if', changes: [traffic], kept: [] })).not.toBe(base);
    expect(key(null, { kind: 'what_if', changes: [model], kept: [] })).not.toBe(base);
    expect(key(null, { kind: 'perspective', changes: [], kept: [], lens: 'cost' })).not.toBe(base);
    expect(key(null, { kind: 'perspective', changes: [], kept: [], lens: 'latency' })).not.toBe(
      key(null, { kind: 'perspective', changes: [], kept: [], lens: 'cost' }),
    );
  });

  it('does not depend on the order of the changes', () => {
    expect(key(null, { kind: 'what_if', changes: [traffic, model], kept: [] })).toBe(
      key(null, { kind: 'what_if', changes: [model, traffic], kept: [] }),
    );
  });
});
