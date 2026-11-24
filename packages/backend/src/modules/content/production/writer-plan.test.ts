import { describe, expect, it } from 'vitest';
import { ScrollProvenanceV3 } from '@knowscroll/scroll-model/internal';
import { codeRecipeOf } from '../application/recipe-book.js';
import type { BookRecipe } from '../domain/library/generated.js';
import { evidencePassages } from './evidence.js';
import { fixtureResearchPageV2 } from './orrin.fixture.js';
import { spikePlanV3 } from './spike-v3/plans.js';
import { fixtureReplyV3 } from './spike-v3/writer-v3.fixture.js';
import { librarySubject, type ProductionSubject } from './subject.js';
import { WRITER_V3_PROMPT_VERSION } from './writer-v3-version.js';
import { writerPlanFor, type WriterPlanInput } from './writer-plan.js';

// CI fixtures only: an invented planet on the seasons recipe's identity, never product content.
const passages = evidencePassages([fixtureResearchPageV2]);
const production = { runId: 'run-ci-1', attemptIds: ['attempt-ci-1'], model: 'MiniMax-M3.1-Flash' };
const v3Plan = spikePlanV3('seasons');

/** The seasons recipe as the library plan states it, with the plan marker chosen by the test and no other. */
function subjectWith(marker: 'none' | 'v3'): ProductionSubject {
  const { scrollV3: _v3, ...base } = librarySubject(codeRecipeOf('seasons') as BookRecipe);
  if (marker === 'v3') return { ...base, scrollV3: v3Plan };
  return base;
}

const inputFor = (subject: ProductionSubject, revision = 2): WriterPlanInput => ({
  subject,
  revision,
  runId: 'run-ci-1',
  model: production.model,
  passages,
  pages: [fixtureResearchPageV2],
});

describe('the writer plan of a recipe planned as document v3', () => {
  it('is the arm (a) writer: one reply and the v3 prompt version', () => {
    const plan = writerPlanFor(inputFor(subjectWith('v3')));
    expect([plan.role.id, plan.role.version]).toEqual(['content.scroll-writer', 'scroll-writer-v3a.v2']);
    expect(plan.promptVersion).toBe(WRITER_V3_PROMPT_VERSION);
  });

  it('compiles an accepted reply at the job’s revision, with the prompt version the publication lineage requires', () => {
    const plan = writerPlanFor(inputFor(subjectWith('v3'), 3));
    const compiled = plan.compile(fixtureReplyV3(), production);
    if (compiled.kind !== 'compiled') throw new Error(`CI expected a compile, got ${JSON.stringify(compiled)}`);
    expect(compiled.documentVersion).toBe('scroll-document.v3');
    expect((compiled.document as { revision: number }).revision).toBe(3);
    const stored = ScrollProvenanceV3.parse(compiled.provenance);
    expect(stored.revision).toBe(3);
    expect(stored.production).toEqual({ kind: 'model', ...production, promptVersion: plan.promptVersion });
  });

  it('refuses a subject that is not a library recipe before any request: an order is not written as a v3', () => {
    const order = { ...subjectWith('v3'), key: 'order-0123456789abcdef' } as unknown as ProductionSubject;
    expect(() => writerPlanFor(inputFor(order))).toThrow('SCROLL_V3_REQUIRES_LIBRARY_RECIPE');
  });

  it('accepts a stored recipe key (`gen-…`), which is a library recipe too', () => {
    const stored = { ...subjectWith('v3'), key: 'gen-a-planet' } as unknown as ProductionSubject;
    expect(writerPlanFor(inputFor(stored)).promptVersion).toBe(WRITER_V3_PROMPT_VERSION);
  });
});

describe('the writer plan of a subject that is not a document v3 one (the v1 and v2 writers are gone, #815, #818)', () => {
  it('is refused before any request: nothing else writes a Scroll', () => {
    expect(() => writerPlanFor(inputFor(subjectWith('none')))).toThrow('SCROLL_V3_PLAN_REQUIRED');
  });
});
