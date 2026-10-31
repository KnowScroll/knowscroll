import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api-client';
import { claimFirstOpen, firstOpenSeen } from './first-open';

const owner = (claim: () => Promise<{ claimed: boolean }>, active = true) => {
  const kept = new Map<string, string>();
  return {
    active,
    api: { account: { claimFirstOpen: claim } } as unknown as Pick<ApiClient, 'account'>,
    storage: {
      get: (key: string) => kept.get(key),
      set: (key: string, value: string) => void kept.set(key, value),
    },
  };
};

describe('claiming the first open', () => {
  it('plays when the account had not seen it, and says seen when it had', async () => {
    expect(await claimFirstOpen(owner(() => Promise.resolve({ claimed: true })))).toBe('play');
    expect(await claimFirstOpen(owner(() => Promise.resolve({ claimed: false })))).toBe('seen');
  });

  it('remembers either answer on the device, so a returning account is never asked again', async () => {
    const ask = vi.fn(() => Promise.resolve({ claimed: false }));
    const returning = owner(ask);
    expect(firstOpenSeen(returning)).toBe(false);
    expect(await claimFirstOpen(returning)).toBe('seen');
    expect(firstOpenSeen(returning)).toBe(true);
    expect(await claimFirstOpen(returning)).toBe('seen');
    expect(ask).toHaveBeenCalledTimes(1);
    const first = owner(() => Promise.resolve({ claimed: true }));
    await claimFirstOpen(first);
    expect(firstOpenSeen(first)).toBe(true);
  });

  it('is unknown, and remembers nothing, when there is no answer, so it is never shown twice but may still be shown', async () => {
    const offline = owner(() => Promise.reject(new Error('offline')));
    expect(await claimFirstOpen(offline)).toBe('unknown');
    expect(firstOpenSeen(offline)).toBe(false);
  });

  it('asks nothing once the account scope has ended, and drops an answer that arrives after it', async () => {
    const ask = vi.fn(() => Promise.resolve({ claimed: true }));
    expect(await claimFirstOpen(owner(ask, false))).toBe('unknown');
    expect(ask).not.toHaveBeenCalled();
    const scope = owner(() => Promise.resolve({ claimed: true }));
    const pending = claimFirstOpen(scope);
    (scope as { active: boolean }).active = false;
    expect(await pending).toBe('unknown');
    expect(firstOpenSeen(scope)).toBe(false);
  });
});
