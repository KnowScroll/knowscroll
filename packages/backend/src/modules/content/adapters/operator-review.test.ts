import { describe, expect, it } from 'vitest';
import { deciderOfAccount } from './operator-review.js';

describe('the decider a decision on the review screen records', () => {
  const accountId = '0199a000-0000-7000-8000-000000000002';

  it('names the account by a short fingerprint, fits the column and is never an account id or an address', () => {
    const decider = deciderOfAccount(accountId);
    expect(decider).toMatch(/^app:[0-9a-f]{16}$/u);
    expect(decider.length).toBeLessThanOrEqual(64);
    expect(decider).not.toContain(accountId);
  });

  it('is the same for the same account whatever the letter case, and differs between accounts', () => {
    expect(deciderOfAccount(accountId.toUpperCase())).toBe(deciderOfAccount(accountId));
    expect(deciderOfAccount('0199a000-0000-7000-8000-000000000003')).not.toBe(deciderOfAccount(accountId));
  });

  it('is not a command-line decision, so the support check replay never counts it as the operator’s blind answer', () => {
    expect(deciderOfAccount(accountId).startsWith('cli:')).toBe(false);
  });
});
