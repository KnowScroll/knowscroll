import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { NO_USAGE, chargedTokens, decideReservation, reservedTokensFor, type BudgetCaps } from './budgets.js';

const caps: BudgetCaps = {
  global: { requestsPerDay: 10, tokensPerDay: 10_000 },
  role: { requestsPerDay: 5, tokensPerDay: 5_000 },
  scope: { requestsPerDay: 3, tokensPerDay: 3_000 },
};
const none = { requests: 0, tokens: 0 };

describe('budget reservations', () => {
  it('admits a reservation that fits every cap', () => {
    expect(decideReservation(caps, { global: none, role: none, scope: none }, 1_000)).toEqual({ kind: 'within' });
  });

  it('reports the widest exhausted dimension first, and which limit it hit', () => {
    expect(
      decideReservation(
        caps,
        { global: { requests: 10, tokens: 0 }, role: none, scope: { requests: 3, tokens: 0 } },
        1,
      ),
    ).toEqual({ kind: 'exhausted', dimension: 'global', limit: 'requests' });
    expect(decideReservation(caps, { global: none, role: { requests: 0, tokens: 4_500 }, scope: none }, 600)).toEqual({
      kind: 'exhausted',
      dimension: 'role',
      limit: 'tokens',
    });
    expect(decideReservation(caps, { global: none, role: none, scope: { requests: 3, tokens: 0 } }, 1)).toEqual({
      kind: 'exhausted',
      dimension: 'scope',
      limit: 'requests',
    });
  });

  test.prop([
    fc.integer({ min: 0, max: 20_000 }),
    fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: 20_000 }),
  ])('never admits a reservation that would exceed any cap', (tokens, requests, spent) => {
    const usage = {
      global: { requests, tokens: spent },
      role: { requests, tokens: spent },
      scope: { requests, tokens: spent },
    };
    const decision = decideReservation(caps, usage, tokens);
    if (decision.kind === 'within')
      for (const dimension of ['global', 'role', 'scope'] as const) {
        expect(usage[dimension].requests + 1).toBeLessThanOrEqual(caps[dimension].requestsPerDay);
        expect(usage[dimension].tokens + tokens).toBeLessThanOrEqual(caps[dimension].tokensPerDay);
      }
  });

  it('refuses a single reservation larger than a cap on its own', () => {
    expect(decideReservation(caps, { global: none, role: none, scope: none }, 3_001)).toMatchObject({
      kind: 'exhausted',
      dimension: 'scope',
    });
  });

  it('reserves request bytes plus the output ceiling', () => {
    expect(reservedTokensFor(978, 512)).toBe(1_490);
  });

  it('charges nothing when never sent, reported usage when known, and the full reservation otherwise', () => {
    expect(chargedTokens(false, 1_490, NO_USAGE)).toBe(0);
    expect(
      chargedTokens(true, 1_490, { inputTokens: 214, outputTokens: 13, reasoningTokens: null, cachedTokens: 128 }),
    ).toBe(355);
    expect(chargedTokens(true, 1_490, NO_USAGE)).toBe(1_490);
    expect(chargedTokens(true, 1_490, { ...NO_USAGE, inputTokens: 200 })).toBe(1_490);
  });
});
