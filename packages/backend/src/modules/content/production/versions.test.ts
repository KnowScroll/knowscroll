import { afterEach, describe, expect, it } from 'vitest';
import { isReadingInteractionAllowed } from '../public.js';
import {
  claimSecondsFor,
  produceAnswerQueue,
  produceScrollJob,
  produceScrollQueue,
  PRODUCE_ANSWER_CLAIM_SECONDS,
  PRODUCE_SCROLL_CLAIM_SECONDS,
} from './events.js';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../../infrastructure/config/index.js';
import { makeRunScrollProduction } from './job.js';
import { ASK_SUPPORT_BATCH_SENTENCES, ASK_SUPPORT_MAX_BATCHES } from '../domain/ask-support.js';
import { ASK_SUPPORT_CHECK_VERSION } from './ask-support.js';
import {
  MAX_TAKES_PER_RECIPE,
  parseScrollTopic,
  planRefusalOf,
  productionVersionOf,
  REQUEST_BOUND_ASK_ORDER,
  REQUEST_BOUND_PER_TOPIC,
  PRODUCTION_VERSIONS,
  REQUEST_BOUND_V2_PER_TOPIC,
  REQUEST_BOUND_V3_PER_TOPIC,
  requestBoundOf,
  SCROLL_PRODUCTION_V2_VERSION,
  SCROLL_PRODUCTION_V3_VERSION,
  SCROLL_PRODUCTION_VERSION,
  scrollV2PlanOf,
  scrollV3PlanOf,
  TOPICS,
} from './topics.js';
import { WRITER_V2_PROMPT_VERSION } from './writer-v2.js';
import { WRITER_V3_PROMPT_VERSION } from './writer-v3-version.js';
import { QUESTION_WRITER_PROMPT_VERSION } from './writer.js';

/**
 * Gives a recipe the plan a test asks for and nothing else, then puts its own back. The library plans every recipe as a document
 * v3 Scroll since #790, so a test of a v1 or a v2 recipe takes that plan away first.
 */
const marked: (() => void)[] = [];
type Plans = { scrollV2?: unknown; scrollV3?: unknown };
function setPlans(key: 'exoplanet-kinds', plans: Plans): void {
  const recipe = TOPICS[key] as Plans;
  const { scrollV2, scrollV3 } = recipe;
  delete recipe.scrollV2;
  delete recipe.scrollV3;
  Object.assign(recipe, plans);
  marked.push(() => {
    delete recipe.scrollV2;
    delete recipe.scrollV3;
    Object.assign(recipe, {
      ...(scrollV2 === undefined ? {} : { scrollV2 }),
      ...(scrollV3 === undefined ? {} : { scrollV3 }),
    });
  });
}
/** Makes a recipe a v1 recipe for one test. */
function markV1(key: 'exoplanet-kinds'): void {
  setPlans(key, {});
}
/** Marks a recipe v2 for one test. */
function markV2(key: 'exoplanet-kinds'): void {
  setPlans(key, { scrollV2: { variant: 'plain', misconception: { kind: 'none' } } });
}
/** Marks a recipe as a document v3 one for one test. */
function markV3(key: 'exoplanet-kinds'): void {
  setPlans(key, {
    scrollV3: { shape: 'mechanism', sections: ['What happens', 'Why it matters'], misconception: { kind: 'none' } },
  });
}
afterEach(() => marked.splice(0).forEach((undo) => undo()));

describe('production versions: a recipe is v1 unless the plan marks it v2', () => {
  it('keeps a recipe the plan does not mark, and every order, at the v1 production version', () => {
    markV1('exoplanet-kinds');
    expect(SCROLL_PRODUCTION_VERSION).toBe('scroll-production.v14');
    expect(parseScrollTopic('exoplanet-kinds')).toBe('exoplanet-kinds');
    expect(scrollV2PlanOf('exoplanet-kinds')).toBeUndefined();
    expect(productionVersionOf('exoplanet-kinds')).toBe(SCROLL_PRODUCTION_VERSION);
    expect(productionVersionOf(`order-${'a'.repeat(32)}`)).toBe(SCROLL_PRODUCTION_VERSION);
    expect(produceScrollJob('exoplanet-kinds').policyVersion).toBe(SCROLL_PRODUCTION_VERSION);
  });

  it('gives a marked recipe its own version, in the job it sends and the job it accepts', async () => {
    markV2('exoplanet-kinds');
    expect(productionVersionOf('exoplanet-kinds')).toBe(SCROLL_PRODUCTION_V2_VERSION);
    expect(produceScrollJob('exoplanet-kinds', 2)).toMatchObject({
      policyVersion: SCROLL_PRODUCTION_V2_VERSION,
      take: 2,
    });
    const run = makeRunScrollProduction(() => Promise.reject(new Error('CI: a stale job must not produce')), {
      madeToOrderEnabled: true,
    });
    const abort = { signal: new AbortController().signal };
    // A job queued before the plan marked the recipe carries the old version and is dropped.
    expect(
      await run({ v: 1, recipe: 'exoplanet-kinds', policyVersion: SCROLL_PRODUCTION_VERSION, take: 1 }, abort),
    ).toEqual({
      kind: 'skipped',
      reason: 'policy_version',
    });
  });
});

describe('production versions: a recipe the plan marks document v3', () => {
  it('has no v3 plan for a v1 recipe or an order, and a key-only v3 plan for a stored recipe', () => {
    markV1('exoplanet-kinds');
    expect(scrollV3PlanOf('exoplanet-kinds')).toBeUndefined();
    expect(scrollV3PlanOf(`order-${'a'.repeat(32)}`)).toBeUndefined();
    // A stored recipe is a document v3 recipe (#781): its key alone decides, and says v3 with no v2 plan.
    expect(scrollV3PlanOf(`gen-${'a'.repeat(32)}`)).toMatchObject({ misconception: { kind: 'none' } });
    expect(scrollV2PlanOf(`gen-${'a'.repeat(32)}`)).toBeUndefined();
    expect(productionVersionOf(`gen-${'a'.repeat(32)}`)).toBe(SCROLL_PRODUCTION_V3_VERSION);
    expect(requestBoundOf(`gen-${'a'.repeat(32)}`)).toBe(REQUEST_BOUND_V3_PER_TOPIC);
  });

  it('gives a marked recipe the v3 version, in the job it sends and the job it accepts', async () => {
    markV3('exoplanet-kinds');
    expect(scrollV3PlanOf('exoplanet-kinds')?.shape).toBe('mechanism');
    expect(productionVersionOf('exoplanet-kinds')).toBe(SCROLL_PRODUCTION_V3_VERSION);
    expect(produceScrollJob('exoplanet-kinds', 2)).toMatchObject({
      policyVersion: SCROLL_PRODUCTION_V3_VERSION,
      take: 2,
    });
    const run = makeRunScrollProduction(() => Promise.reject(new Error('CI: a stale job must not produce')), {
      madeToOrderEnabled: true,
    });
    const abort = { signal: new AbortController().signal };
    expect(
      await run({ v: 1, recipe: 'exoplanet-kinds', policyVersion: SCROLL_PRODUCTION_V2_VERSION, take: 1 }, abort),
    ).toEqual({ kind: 'skipped', reason: 'policy_version' });
  });

  it('pairs the v3 writer’s instructions with the v3 production version, so a new writer cannot reuse the old writer’s takes', () => {
    const productionVersionOfWriter: Readonly<Record<string, string>> = {
      'scroll-writer-v3.v1': 'scroll-production-v3.v1',
    };
    expect(productionVersionOfWriter[WRITER_V3_PROMPT_VERSION]).toBe(SCROLL_PRODUCTION_V3_VERSION);
  });

  it('is a version a job row may carry, and bounds a take like v2, inside the claim a production delivery holds', () => {
    expect(PRODUCTION_VERSIONS).toContain(SCROLL_PRODUCTION_V3_VERSION);
    expect(new Set(PRODUCTION_VERSIONS).size).toBe(3);
    expect(REQUEST_BOUND_V3_PER_TOPIC).toBe(REQUEST_BOUND_V2_PER_TOPIC);
    expect(claimSecondsFor(REQUEST_BOUND_V3_PER_TOPIC)).toBeLessThanOrEqual(PRODUCE_SCROLL_CLAIM_SECONDS);
    markV3('exoplanet-kinds');
    expect(requestBoundOf('exoplanet-kinds')).toBe(REQUEST_BOUND_V3_PER_TOPIC);
  });

  it('refuses a v3 plan whose misconception source no person has reviewed, as for v2', () => {
    markV3('exoplanet-kinds');
    const recipe = TOPICS['exoplanet-kinds'] as { scrollV3?: { misconception: unknown } };
    if (recipe.scrollV3 === undefined) throw new Error('CI: the recipe was just marked');
    recipe.scrollV3.misconception = {
      kind: 'myth',
      claim: 'A CI fixture claim, never product content.',
      source: { label: 'CI fixture label', reviewed: false },
    };
    expect(planRefusalOf('exoplanet-kinds')).toBe('misconception_source_unreviewed');
  });
});

describe('a v2 recipe whose misconception source no person has reviewed', () => {
  it('is refused by the plan, before any job or request, and only while the label is unreviewed', () => {
    expect(planRefusalOf('exoplanet-kinds')).toBeUndefined();
    const recipe = TOPICS['exoplanet-kinds'] as { scrollV2?: unknown };
    markV2('exoplanet-kinds');
    const myth = (reviewed: boolean) => ({
      variant: 'plain',
      misconception: {
        kind: 'myth',
        claim: 'A CI fixture claim, never product content.',
        source: { label: 'CI fixture label', reviewed },
      },
    });
    recipe.scrollV2 = myth(false);
    expect(planRefusalOf('exoplanet-kinds')).toBe('misconception_source_unreviewed');
    recipe.scrollV2 = myth(true);
    expect(planRefusalOf('exoplanet-kinds')).toBeUndefined();
    recipe.scrollV2 = { variant: 'plain', misconception: { kind: 'none' } };
    expect(planRefusalOf('exoplanet-kinds')).toBeUndefined();
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
    'scroll-writer.v20': 'scroll-production.v20',
    'scroll-writer.v21': 'scroll-production.v21',
    'scroll-writer.v22': 'scroll-production.v22',
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

  it('reports the bound of the recipe asked about: six for a v2 recipe, fourteen for the answer to a question, two for every other', () => {
    expect(requestBoundOf('seasons')).toBe(REQUEST_BOUND_V2_PER_TOPIC);
    markV1('exoplanet-kinds');
    expect(requestBoundOf('exoplanet-kinds')).toBe(REQUEST_BOUND_PER_TOPIC);
    const order = `order-${'a'.repeat(32)}` as const;
    // An order’s key does not say what it answers: the caller that read the order says so.
    expect(requestBoundOf(order)).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(order, 'what_if')).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(order, 'perspective')).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(order, 'question')).toBe(REQUEST_BOUND_ASK_ORDER);
  });

  it('counts the support check inside an ask order’s bound: the writer and its repair, the revision a support check earns and its repair for a copied passage, and for each of the two drafts its batches of sentences and one repair of an unusable reply in the check (D-250, D-267, D-297)', () => {
    expect(ASK_SUPPORT_BATCH_SENTENCES).toBe(10);
    expect(ASK_SUPPORT_MAX_BATCHES).toBe(4);
    expect(REQUEST_BOUND_ASK_ORDER).toBe(2 + 1 + 1 + 2 * (ASK_SUPPORT_MAX_BATCHES + 1));
    expect(REQUEST_BOUND_ASK_ORDER).toBe(14);
    // The longest answer a take checks is four batches of ten sentences; the real answers of the 1 Nov check had 21.
    expect(Math.ceil(21 / ASK_SUPPORT_BATCH_SENTENCES)).toBeLessThanOrEqual(ASK_SUPPORT_MAX_BATCHES);
  });
});

describe('the answer to a question is written and checked as a pair (D-250)', () => {
  /**
   * Each question-writer version and the support check version it was released with. A new writer or a new checker
   * without a row fails, so neither changes alone: the checker judges what the writer is told to write, and the writer is
   * told it will be checked.
   */
  const SUPPORT_CHECK_OF_QUESTION_WRITER: Readonly<Record<string, string>> = {
    'question-writer.v1': 'none',
    'question-writer.v2': 'ask-support-check.v1',
    'question-writer.v3': 'ask-support-check.v2',
    'question-writer.v4': 'ask-support-check.v3',
    'question-writer.v5': 'ask-support-check.v4',
    'question-writer.v6': 'ask-support-check.v4',
    'question-writer.v7': 'ask-support-check.v5',
    'question-writer.v8': 'ask-support-check.v5',
    // D-371: the writer is told not to write the limits callout, which code writes and the checker never reads; the checker is unchanged.
    'question-writer.v9': 'ask-support-check.v5',
  };

  it('pairs the question writer’s instructions with the support check’s version', () => {
    expect(SUPPORT_CHECK_OF_QUESTION_WRITER[QUESTION_WRITER_PROMPT_VERSION]).toBe(ASK_SUPPORT_CHECK_VERSION);
  });

  it('keeps the library’s production version, because an order has one job a take and its key is its own', () => {
    expect(productionVersionOf(`order-${'a'.repeat(32)}`)).toBe(SCROLL_PRODUCTION_VERSION);
  });
});

describe('how long a production delivery may hold its claim (D-198, D-267, D-297)', () => {
  /**
   * The reasoning README's rule for a job that calls `propose`: each request waits 10 s for the quota preflight, up to
   * its deadline and 10 s for the two scope locks. Written out again, so the queues cannot drift from it by editing the
   * constants they are derived from; 180 s is the margin for the research and the database steps of a take.
   */
  const claimNeeded = (requests: number, deadlineSeconds: number): number =>
    requests * (10 + deadlineSeconds + 10) + 180;
  const deadlineSeconds = MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000;

  it('gives a library recipe the claim of its six requests, at the largest timeout', () => {
    expect(deadlineSeconds).toBe(300);
    expect(PRODUCE_SCROLL_CLAIM_SECONDS).toBe(claimNeeded(6, deadlineSeconds));
    expect(PRODUCE_SCROLL_CLAIM_SECONDS).toBe(2100);
    expect(produceScrollQueue.policy.expireInSeconds).toBe(2100);
  });

  it('gives the answer to a question, on a queue of its own, the claim of its fourteen requests', () => {
    expect(produceAnswerQueue.name).toBe('content.produce-answer');
    expect(PRODUCE_ANSWER_CLAIM_SECONDS).toBe(claimNeeded(14, deadlineSeconds));
    expect(PRODUCE_ANSWER_CLAIM_SECONDS).toBe(4660);
    expect(produceAnswerQueue.policy.expireInSeconds).toBe(4660);
  });

  it('keeps the two queues alike in everything but the claim, so the same consumer serves both', () => {
    const { expireInSeconds: scrollClaim, ...scrollPolicy } = produceScrollQueue.policy;
    const { expireInSeconds: answerClaim, ...answerPolicy } = produceAnswerQueue.policy;
    expect(answerPolicy).toEqual(scrollPolicy);
    expect(answerClaim).toBeGreaterThan(scrollClaim);
    expect(produceAnswerQueue.payload).toBe(produceScrollQueue.payload);
    expect(produceAnswerQueue.exclusive).toBe(produceScrollQueue.exclusive);
  });
});
