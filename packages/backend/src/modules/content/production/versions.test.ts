import { afterEach, describe, expect, it } from 'vitest';
import { isReadingInteractionAllowed } from '../public.js';
import {
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
  REQUEST_BOUND_V2_PER_TOPIC,
  requestBoundOf,
  SCROLL_PRODUCTION_V2_VERSION,
  SCROLL_PRODUCTION_VERSION,
  scrollV2PlanOf,
  TOPICS,
} from './topics.js';
import { WRITER_V2_PROMPT_VERSION } from './writer-v2.js';
import { QUESTION_WRITER_PROMPT_VERSION } from './writer.js';

/** Marks a recipe v2 for one test, the way the plan will. */
const marked: (() => void)[] = [];
function markV2(key: 'exoplanet-kinds'): void {
  const recipe = TOPICS[key] as { scrollV2?: unknown };
  recipe.scrollV2 = { variant: 'plain', misconception: { kind: 'none' } };
  marked.push(() => delete recipe.scrollV2);
}
afterEach(() => marked.splice(0).forEach((undo) => undo()));

describe('production versions: a recipe is v1 unless the plan marks it v2', () => {
  it('keeps every recipe of the plan, and every order, at the v1 production version', () => {
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
    const run = makeRunScrollProduction(() => Promise.reject(new Error('CI: a stale job must not produce')));
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

describe('a v2 recipe whose misconception source no person has reviewed', () => {
  it('is refused by the plan, before any job or request, and only while the label is unreviewed', () => {
    expect(planRefusalOf('exoplanet-kinds')).toBeUndefined();
    const recipe = TOPICS['exoplanet-kinds'] as { scrollV2?: unknown };
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

  it('reports the bound of the recipe asked about: six for a v2 recipe, twelve for the answer to a question, two for every other', () => {
    expect(requestBoundOf('seasons')).toBe(REQUEST_BOUND_V2_PER_TOPIC);
    expect(requestBoundOf('exoplanet-kinds')).toBe(REQUEST_BOUND_PER_TOPIC);
    const order = `order-${'a'.repeat(32)}` as const;
    // An order’s key does not say what it answers: the caller that read the order says so.
    expect(requestBoundOf(order)).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(order, 'what_if')).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(order, 'perspective')).toBe(REQUEST_BOUND_PER_TOPIC);
    expect(requestBoundOf(order, 'question')).toBe(REQUEST_BOUND_ASK_ORDER);
  });

  it('counts the support check inside an ask order’s bound: the writer and its one repair, and for each of the two drafts its batches of sentences and one repair of an unusable reply in the check (D-250, D-267)', () => {
    expect(ASK_SUPPORT_BATCH_SENTENCES).toBe(10);
    expect(ASK_SUPPORT_MAX_BATCHES).toBe(4);
    expect(REQUEST_BOUND_ASK_ORDER).toBe(2 + 2 * (ASK_SUPPORT_MAX_BATCHES + 1));
    expect(REQUEST_BOUND_ASK_ORDER).toBe(12);
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
  };

  it('pairs the question writer’s instructions with the support check’s version', () => {
    expect(SUPPORT_CHECK_OF_QUESTION_WRITER[QUESTION_WRITER_PROMPT_VERSION]).toBe(ASK_SUPPORT_CHECK_VERSION);
  });

  it('keeps the library’s production version, because an order has one job a take and its key is its own', () => {
    expect(productionVersionOf(`order-${'a'.repeat(32)}`)).toBe(SCROLL_PRODUCTION_VERSION);
  });
});

describe('how long a production delivery may hold its claim (D-198, D-267)', () => {
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

  it('gives the answer to a question, on a queue of its own, the claim of its twelve requests', () => {
    expect(produceAnswerQueue.name).toBe('content.produce-answer');
    expect(PRODUCE_ANSWER_CLAIM_SECONDS).toBe(claimNeeded(12, deadlineSeconds));
    expect(PRODUCE_ANSWER_CLAIM_SECONDS).toBe(4020);
    expect(produceAnswerQueue.policy.expireInSeconds).toBe(4020);
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
