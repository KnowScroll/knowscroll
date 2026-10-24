import { describe, expect, it } from 'vitest';
import { BRANCH_WAIT_LIMIT_MS, branchProgress } from './progress.js';

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
