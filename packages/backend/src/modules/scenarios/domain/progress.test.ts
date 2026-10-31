import { describe, expect, it } from 'vitest';
import { MINIMAX_REQUEST_TIMEOUT_MAX_MS } from '../../../infrastructure/config/index.js';
import { writeAnswerQueue } from '../events.js';
import { ANSWER_WAIT_LIMIT_MS, answerWaitOver, BRANCH_WAIT_LIMIT_MS, branchProgress } from './progress.js';

const published = { assetRevision: 1, title: 'What a portal would need' };

describe('branchProgress', () => {
  it('binds an admitted Scroll, even past the limit', () => {
    expect(branchProgress({ state: 'published', published }, 1000)).toEqual({
      kind: 'bind',
      assetRevision: 1,
      assetTitle: 'What a portal would need',
    });
    expect(branchProgress({ state: 'published', published }, BRANCH_WAIT_LIMIT_MS * 3).kind).toBe('bind');
  });

  it('sends the job of the take production names while it is under way, rejected or not yet started', () => {
    expect(branchProgress({ state: 'not_started', take: 1 }, 10_000)).toEqual({ kind: 'send', take: 1 });
    expect(branchProgress({ state: 'running', take: 2 }, 10_000)).toEqual({ kind: 'send', take: 2 });
    expect(branchProgress({ state: 'retryable', take: 3 }, 10_000)).toEqual({ kind: 'send', take: 3 });
  });

  it('closes when nothing can produce it any more, or when it took too long', () => {
    expect(branchProgress({ state: 'stopped' }, 1000)).toEqual({ kind: 'fail' });
    expect(branchProgress({ state: 'running', take: 1 }, BRANCH_WAIT_LIMIT_MS)).toEqual({ kind: 'fail' });
    expect(branchProgress({ state: 'running', take: 1 }, BRANCH_WAIT_LIMIT_MS - 1).kind).toBe('send');
  });

  it('waits when production names no take to send', () => {
    expect(branchProgress({ state: 'running' }, 1000)).toEqual({ kind: 'wait' });
  });
});

describe('answerWaitOver', () => {
  it('waits while the short answer is young and gives up at the limit, which is shorter than a branch’s', () => {
    expect(answerWaitOver(0)).toBe(false);
    expect(answerWaitOver(ANSWER_WAIT_LIMIT_MS - 1)).toBe(false);
    expect(answerWaitOver(ANSWER_WAIT_LIMIT_MS)).toBe(true);
    expect(ANSWER_WAIT_LIMIT_MS).toBeLessThan(BRANCH_WAIT_LIMIT_MS);
  });

  it('outlasts the worst paid answer: an attempt and one repair at the largest request deadline, and the job’s own claim', () => {
    expect(ANSWER_WAIT_LIMIT_MS).toBeGreaterThan(2 * MINIMAX_REQUEST_TIMEOUT_MAX_MS);
    expect(ANSWER_WAIT_LIMIT_MS).toBeGreaterThan(writeAnswerQueue.policy.expireInSeconds * 1000);
  });
});
