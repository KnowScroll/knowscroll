import { describe, expect, it } from 'vitest';
import { ProductionRecord } from './provenance.js';

const record = (attemptIds: readonly string[]) => ({
  kind: 'model' as const,
  runId: 'run-ci-1',
  attemptIds,
  model: 'ci-model',
  promptVersion: 'scroll-writer-v3.v5',
});

describe('the production record of a model-written revision', () => {
  it('names one attempt, the writer; two, with its repair; or three, with its second repair (D-445)', () => {
    for (const attempts of [['a1'], ['a1', 'a2'], ['a1', 'a2', 'a3']])
      expect(ProductionRecord.safeParse(record(attempts)).success, attempts.join()).toBe(true);
  });

  it('names no attempt less, and no more than three: a proposal is never more than the writer and two repairs', () => {
    expect(ProductionRecord.safeParse(record([])).success).toBe(false);
    expect(ProductionRecord.safeParse(record(['a1', 'a2', 'a3', 'a4'])).success).toBe(false);
  });
});
