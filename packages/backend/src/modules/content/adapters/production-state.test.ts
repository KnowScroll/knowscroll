import { afterEach, describe, expect, it } from 'vitest';
import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { ScrollV3Plan } from '../domain/library/plan.js';
import { TOPICS } from '../production/topics.js';
import { isPlannedAsV2OrV3, plannedDocumentVersionOf } from './production-state.js';

const v3: ScrollV3Plan = {
  shape: 'mechanism',
  sections: ['What happens', 'Why it matters'],
  misconception: { kind: 'none' },
};

/**
 * Gives the recipe `exoplanet-kinds` the plan a test asks for and nothing else, then puts its own back. The library plans every
 * recipe as a document v3 Scroll since #790, so a test of a v1 recipe takes that plan away first.
 */
const undo: (() => void)[] = [];
function mark(plan: { scrollV3?: ScrollV3Plan }): void {
  const recipe = TOPICS['exoplanet-kinds'] as { scrollV3?: unknown };
  const { scrollV3 } = recipe;
  delete recipe.scrollV3;
  Object.assign(recipe, plan);
  undo.push(() => {
    delete recipe.scrollV3;
    Object.assign(recipe, scrollV3 === undefined ? {} : { scrollV3 });
  });
}
afterEach(() => undo.splice(0).forEach((restore) => restore()));

describe('which document a recipe must have to count as published', () => {
  it('asks a recipe of the library for a document v3, because the plan marks every recipe so since #790', () => {
    expect(plannedDocumentVersionOf('exoplanet-kinds')).toBe(SCROLL_DOCUMENT_V3_SCHEMA_VERSION);
    expect(isPlannedAsV2OrV3('exoplanet-kinds')).toBe(true);
  });

  it('lets any admitted Scroll satisfy a v1 recipe and an order', () => {
    mark({});
    expect(plannedDocumentVersionOf('exoplanet-kinds')).toBeUndefined();
    expect(plannedDocumentVersionOf(`order-${'a'.repeat(32)}`)).toBeUndefined();
    expect(isPlannedAsV2OrV3('exoplanet-kinds')).toBe(false);
  });

  it('asks a document v3 recipe for a document v3, so a served v2 revision does not stand for it', () => {
    mark({ scrollV3: v3 });
    expect(plannedDocumentVersionOf('exoplanet-kinds')).toBe(SCROLL_DOCUMENT_V3_SCHEMA_VERSION);
    expect(isPlannedAsV2OrV3('exoplanet-kinds')).toBe(true);
  });

  it('asks a stored recipe for a document v3: every proposal is a document v3 recipe (#781)', () => {
    expect(plannedDocumentVersionOf(`gen-${'a'.repeat(8)}`)).toBe(SCROLL_DOCUMENT_V3_SCHEMA_VERSION);
  });
});
