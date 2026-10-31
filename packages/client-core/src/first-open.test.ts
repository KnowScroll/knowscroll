import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api-client';
import { claimFirstOpen } from './first-open';

const owner = (claim: () => Promise<{ claimed: boolean }>, active = true) => ({
  active,
  api: { account: { claimFirstOpen: claim } } as unknown as Pick<ApiClient, 'account'>,
});

describe('claiming the first open', () => {
  it('plays when the account had not seen it, and skips when it had', async () => {
    expect(await claimFirstOpen(owner(() => Promise.resolve({ claimed: true })))).toBe('play');
    expect(await claimFirstOpen(owner(() => Promise.resolve({ claimed: false })))).toBe('skip');
  });

  it('skips when there is no answer, so it is never shown twice', async () => {
    expect(await claimFirstOpen(owner(() => Promise.reject(new Error('offline'))))).toBe('skip');
  });

  it('asks nothing once the account scope has ended, and drops an answer that arrives after it', async () => {
    const ask = vi.fn(() => Promise.resolve({ claimed: true }));
    expect(await claimFirstOpen(owner(ask, false))).toBe('skip');
    expect(ask).not.toHaveBeenCalled();
    const scope = { active: true, api: { account: { claimFirstOpen: () => Promise.resolve({ claimed: true }) } } };
    const pending = claimFirstOpen(scope as never);
    scope.active = false;
    expect(await pending).toBe('skip');
  });
});
