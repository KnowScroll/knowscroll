import { describe, expect, it } from 'vitest';
import type { ScrollV3Plan } from '../domain/library/plan.js';
import type { ProductionSubject } from './subject.js';
import { writerPlanFor, type WriterPlanInput } from './writer-plan.js';

const v3: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};

describe('the writer plan of a recipe planned as document v3', () => {
  it('is refused before any request until the v3 writer exists, so the v1 writer never writes it', () => {
    const subject = { key: 'seasons', scrollV3: v3 } as unknown as ProductionSubject;
    const input = { subject, revision: 1, runId: 'run-ci', model: 'MiniMax-M3.1-Flash', passages: [], pages: [] };
    expect(() => writerPlanFor(input as WriterPlanInput)).toThrow('SCROLL_V3_WRITER_NOT_IMPLEMENTED');
  });
});
