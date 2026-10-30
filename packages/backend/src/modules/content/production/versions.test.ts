import { afterEach, describe, expect, it } from 'vitest';
import { isReadingInteractionAllowed } from '../public.js';
import { produceScrollJob } from './events.js';
import { makeRunScrollProduction } from './job.js';
import {
  parseScrollTopic,
  planRefusalOf,
  productionVersionOf,
  SCROLL_PRODUCTION_V2_VERSION,
  SCROLL_PRODUCTION_VERSION,
  scrollV2PlanOf,
  TOPICS,
} from './topics.js';

/** Marks a recipe v2 for one test, the way the plan will. */
const marked: (() => void)[] = [];
function markV2(key: 'greenhouse'): void {
  const recipe = TOPICS[key] as { scrollV2?: unknown };
  recipe.scrollV2 = { variant: 'plain', misconception: { kind: 'none' } };
  marked.push(() => delete recipe.scrollV2);
}
afterEach(() => marked.splice(0).forEach((undo) => undo()));

describe('production versions: a recipe is v1 unless the plan marks it v2', () => {
  it('keeps every recipe of the plan, and every order, at the v1 production version', () => {
    expect(SCROLL_PRODUCTION_VERSION).toBe('scroll-production.v14');
    expect(parseScrollTopic('greenhouse')).toBe('greenhouse');
    expect(scrollV2PlanOf('greenhouse')).toBeUndefined();
    expect(productionVersionOf('greenhouse')).toBe(SCROLL_PRODUCTION_VERSION);
    expect(productionVersionOf(`order-${'a'.repeat(32)}`)).toBe(SCROLL_PRODUCTION_VERSION);
    expect(produceScrollJob('greenhouse').policyVersion).toBe(SCROLL_PRODUCTION_VERSION);
  });

  it('gives a marked recipe its own version, in the job it sends and the job it accepts', async () => {
    markV2('greenhouse');
    expect(productionVersionOf('greenhouse')).toBe(SCROLL_PRODUCTION_V2_VERSION);
    expect(produceScrollJob('greenhouse', 2)).toMatchObject({ policyVersion: SCROLL_PRODUCTION_V2_VERSION, take: 2 });
    const run = makeRunScrollProduction(() => Promise.reject(new Error('CI: a stale job must not produce')));
    const abort = { signal: new AbortController().signal };
    // A job queued before the plan marked the recipe carries the old version and is dropped.
    expect(await run({ v: 1, recipe: 'greenhouse', policyVersion: SCROLL_PRODUCTION_VERSION, take: 1 }, abort)).toEqual(
      {
        kind: 'skipped',
        reason: 'policy_version',
      },
    );
  });
});

describe('a v2 recipe whose misconception source no person has reviewed', () => {
  it('is refused by the plan, before any job or request, and only while the label is unreviewed', () => {
    expect(planRefusalOf('greenhouse')).toBeUndefined();
    const recipe = TOPICS.greenhouse as { scrollV2?: unknown };
    const myth = (reviewed: boolean) => ({
      variant: 'plain',
      misconception: {
        kind: 'myth',
        claim: 'A CI fixture claim, never product content.',
        source: { label: 'CI fixture label', reviewed },
      },
    });
    recipe.scrollV2 = myth(false);
    marked.push(() => delete recipe.scrollV2);
    expect(planRefusalOf('greenhouse')).toBe('misconception_source_unreviewed');
    recipe.scrollV2 = myth(true);
    expect(planRefusalOf('greenhouse')).toBeUndefined();
    recipe.scrollV2 = { variant: 'plain', misconception: { kind: 'none' } };
    expect(planRefusalOf('greenhouse')).toBeUndefined();
  });
});

describe('what a call reports', () => {
  it('lets a call report that it was locked in or revealed, and nothing else', () => {
    expect(isReadingInteractionAllowed('call_it', 'locked')).toBe(true);
    expect(isReadingInteractionAllowed('final_call', 'revealed')).toBe(true);
    expect(isReadingInteractionAllowed('call_it', 'option-selected')).toBe(false);
    expect(isReadingInteractionAllowed('stop', 'locked')).toBe(false);
    expect(isReadingInteractionAllowed('diagram', 'frame-changed')).toBe(true);
  });
});
