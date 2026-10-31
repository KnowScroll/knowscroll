import { afterEach, describe, expect, it } from 'vitest';
import { isReadingInteractionAllowed } from '../public.js';
import { produceScrollJob, produceScrollQueue, PRODUCE_SCROLL_CLAIM_SECONDS } from './events.js';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../../infrastructure/config/index.js';
import { makeRunScrollProduction } from './job.js';
import {
  MAX_TAKES_PER_RECIPE,
  parseScrollTopic,
  planRefusalOf,
  productionVersionOf,
  REQUEST_BOUND_PER_TOPIC,
  REQUEST_BOUND_V2_PER_TOPIC,
  requestBoundOf,
  SCROLL_PRODUCTION_V2_VERSION,
  SCROLL_PRODUCTION_VERSION,
  scrollV2PlanOf,
  TOPICS,
} from './topics.js';
import { WRITER_V2_PROMPT_VERSION } from './writer-v2.js';

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

describe('takes are counted per production version, so a writer bump gives new ones (D-197)', () => {
  /** Each v2 writer version and the production version that goes with it. Adding a writer version without a row fails. */
  const PRODUCTION_VERSION_OF_WRITER: Readonly<Record<string, string>> = {
    'scroll-writer.v16': 'scroll-production.v15',
    'scroll-writer.v17': 'scroll-production.v17',
    'scroll-writer.v18': 'scroll-production.v18',
    'scroll-writer.v19': 'scroll-production.v19',
  };

  it('pairs the v2 writer’s instructions with the v2 production version, so a new writer cannot reuse the old writer’s takes', () => {
    expect(PRODUCTION_VERSION_OF_WRITER[WRITER_V2_PROMPT_VERSION]).toBe(SCROLL_PRODUCTION_V2_VERSION);
  });

  it('allows three takes of a recipe per version and bounds a take, so paid production cannot loop', () => {
    expect(MAX_TAKES_PER_RECIPE).toBe(3);
    // Two writer requests (the first draft with one repair, from the validator or the answer check) and
    // the checker once for each of the two drafts, with one repair each, at most.
    expect(REQUEST_BOUND_V2_PER_TOPIC).toBe(2 + 2 * 2);
    expect(REQUEST_BOUND_PER_TOPIC).toBe(2);
  });

  it('reports the bound of the recipe asked about: six for a v2 recipe, two for every other', () => {
    expect(requestBoundOf('seasons')).toBe(REQUEST_BOUND_V2_PER_TOPIC);
    expect(requestBoundOf('tides')).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(`order-${'a'.repeat(32)}`)).toBe(REQUEST_BOUND_PER_TOPIC);
  });
});

describe('how long a production delivery may hold its claim (D-198)', () => {
  it('outlasts the worst case of a take: every request it may send, one after the other, at the largest timeout, plus a margin', () => {
    const worstCaseRequestsSeconds = (REQUEST_BOUND_V2_PER_TOPIC * MINIMAX_REQUEST_TIMEOUT_MAX_MS) / 1000;
    expect(worstCaseRequestsSeconds).toBe(1800);
    expect(PRODUCE_SCROLL_CLAIM_SECONDS).toBeGreaterThan(worstCaseRequestsSeconds);
    expect(PRODUCE_SCROLL_CLAIM_SECONDS).toBe(2100);
    expect(produceScrollQueue.policy.expireInSeconds).toBe(PRODUCE_SCROLL_CLAIM_SECONDS);
  });
});
