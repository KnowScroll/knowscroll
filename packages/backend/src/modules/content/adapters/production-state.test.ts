import { afterEach, describe, expect, it } from 'vitest';
import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION, SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { ScrollV2Plan, ScrollV3Plan } from '../domain/library/plan.js';
import { TOPICS } from '../production/topics.js';
import { isPlannedAsV2OrV3, plannedDocumentVersionOf } from './production-state.js';

const v2: ScrollV2Plan = { variant: 'plain', misconception: { kind: 'none' } };
const v3: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};

/** Marks the v1 recipe `exoplanet-kinds` with a plan for one test, the way the plan will. */
const undo: (() => void)[] = [];
function mark(plan: { scrollV2?: ScrollV2Plan; scrollV3?: ScrollV3Plan }): void {
  const recipe = TOPICS['exoplanet-kinds'] as { scrollV2?: unknown; scrollV3?: unknown };
  Object.assign(recipe, plan);
  undo.push(() => {
    delete recipe.scrollV2;
    delete recipe.scrollV3;
  });
}
afterEach(() => undo.splice(0).forEach((restore) => restore()));

describe('which document a recipe must have to count as published', () => {
  it('lets any admitted Scroll satisfy a v1 recipe and an order', () => {
    expect(plannedDocumentVersionOf('exoplanet-kinds')).toBeUndefined();
    expect(plannedDocumentVersionOf(`order-${'a'.repeat(32)}`)).toBeUndefined();
    expect(isPlannedAsV2OrV3('exoplanet-kinds')).toBe(false);
  });

  it('asks a v2 recipe for a v2 document, as before', () => {
    mark({ scrollV2: v2 });
    expect(plannedDocumentVersionOf('exoplanet-kinds')).toBe(SCROLL_DOCUMENT_V2_SCHEMA_VERSION);
    expect(isPlannedAsV2OrV3('exoplanet-kinds')).toBe(true);
  });

  it('asks a document v3 recipe for a document v3, so a served v2 revision does not stand for it', () => {
    mark({ scrollV3: v3 });
    expect(plannedDocumentVersionOf('exoplanet-kinds')).toBe(SCROLL_DOCUMENT_V3_SCHEMA_VERSION);
    expect(isPlannedAsV2OrV3('exoplanet-kinds')).toBe(true);
  });

  it('asks a stored recipe for a v2 document: no stored recipe is planned as v3 yet', () => {
    expect(plannedDocumentVersionOf(`gen-${'a'.repeat(8)}`)).toBe(SCROLL_DOCUMENT_V2_SCHEMA_VERSION);
  });
});
