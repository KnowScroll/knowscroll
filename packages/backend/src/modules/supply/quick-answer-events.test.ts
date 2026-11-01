import { describe, expect, it } from 'vitest';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../infrastructure/config/index.js';
import { MAX_PAID_ATTEMPTS } from './domain/quick-answer.js';
import { QUICK_ANSWER_WAIT_LIMIT_MS } from './application/quick-answers.js';
import { ANSWER_QUICK_ANSWER_CLAIM_SECONDS, answerQuickAnswerQueue } from './quick-answer-events.js';

/**
 * The reasoning README's rule for a job that calls `propose` (packages/backend/src/reasoning/README.md, "Queue settings"):
 * `expireInSeconds >= attempts * (10 + request deadline + 10) + 30`, at the largest deadline the provider adapter allows.
 * It is written out again here, so the queue cannot drift from it by editing the constant it is derived from.
 */
const claimNeeded = (attempts: number, deadlineSeconds: number): number => attempts * (10 + deadlineSeconds + 10) + 30;

describe('the answering job’s claim', () => {
  it('outlasts every paid attempt of one delivery at the largest request deadline', () => {
    expect(MINIMAX_REQUEST_TIMEOUT_MAX_MS).toBe(300_000);
    expect(answerQuickAnswerQueue.policy.expireInSeconds).toBeGreaterThanOrEqual(
      claimNeeded(MAX_PAID_ATTEMPTS, MINIMAX_REQUEST_TIMEOUT_MAX_MS / 1000),
    );
    expect(answerQuickAnswerQueue.policy.expireInSeconds).toBe(ANSWER_QUICK_ANSWER_CLAIM_SECONDS);
  });

  it('can fail: one attempt more than the claim was sized for would not fit', () => {
    expect(claimNeeded(MAX_PAID_ATTEMPTS + 1, 300)).toBeGreaterThan(answerQuickAnswerQueue.policy.expireInSeconds);
  });

  it('is far longer than the wait the person is given, which is the limit they see', () => {
    expect(answerQuickAnswerQueue.policy.expireInSeconds * 1000).toBeGreaterThan(QUICK_ANSWER_WAIT_LIMIT_MS);
  });
});
