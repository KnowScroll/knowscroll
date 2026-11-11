import { describe, expect, it } from 'vitest';
import { mayTryAgain } from './library-support-check.js';
import { LIBRARY_SUPPORT_REQUEST_BOUND } from './library-support.js';

describe('when a check that ended on a provider failure is tried again (D-415)', () => {
  it('is tried again in the second and third rounds, and not after the third', () => {
    expect(mayTryAgain({ round: 1, requests: 3, batches: 6, failedBatch: 2 })).toBe(true);
    expect(mayTryAgain({ round: 2, requests: 4, batches: 6, failedBatch: 2 })).toBe(true);
    expect(mayTryAgain({ round: 3, requests: 4, batches: 6, failedBatch: 2 })).toBe(false);
  });

  it('keeps every request the revision could still need within its bound of eleven in all, over every round', () => {
    expect(LIBRARY_SUPPORT_REQUEST_BOUND).toBe(11);
    // Six batches failing at the last one after six requests: one more request and a possible repair fit.
    expect(mayTryAgain({ round: 1, requests: 6, batches: 6, failedBatch: 5 })).toBe(true);
    expect(mayTryAgain({ round: 1, requests: 9, batches: 6, failedBatch: 5 })).toBe(true);
    // 9 paid, one batch left and the repair to keep back is 11 in all; one more paid request would be 12.
    expect(mayTryAgain({ round: 1, requests: 10, batches: 6, failedBatch: 5 })).toBe(false);
    // Ten batches failing at the last one after ten requests: 10 + 1 + 1 passes the bound, so a provider failure there is final.
    expect(mayTryAgain({ round: 1, requests: 10, batches: 10, failedBatch: 9 })).toBe(false);
    expect(mayTryAgain({ round: 1, requests: 9, batches: 10, failedBatch: 9 })).toBe(true);
  });

  it('counts the batches still to be asked from the one that failed, plus the request already paid, so a revision of ten batches is tried once only', () => {
    // A failure at batch k has paid k + 1 requests and leaves the batches from k on: the total is the batches plus one, and one more is kept back.
    expect(mayTryAgain({ round: 1, requests: 1, batches: 6, failedBatch: 0 })).toBe(true);
    expect(mayTryAgain({ round: 1, requests: 1, batches: 9, failedBatch: 0 })).toBe(true);
    expect(mayTryAgain({ round: 1, requests: 1, batches: 10, failedBatch: 0 })).toBe(false);
    expect(mayTryAgain({ round: 1, requests: 6, batches: 10, failedBatch: 5 })).toBe(false);
  });
});
