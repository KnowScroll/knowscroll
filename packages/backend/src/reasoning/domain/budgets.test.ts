import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  NO_USAGE,
  backgroundShareOf,
  chargedTokens,
  decideReservation,
  reservedTokensFor,
  type BudgetCaps,
  type BudgetUsage,
} from './budgets.js';

const caps: BudgetCaps = {
  global: { requestsPerDay: 10, tokensPerDay: 10_000 },
  role: { requestsPerDay: 5, tokensPerDay: 5_000 },
  scope: { requestsPerDay: 3, tokensPerDay: 3_000 },
};
const none = { requests: 0, tokens: 0 };
const noBackground = { global: none, scope: none };
const usageOf = (usage: Pick<BudgetUsage, 'global' | 'role' | 'scope'> & Partial<BudgetUsage>): BudgetUsage => ({
  background: noBackground,
  ...usage,
});

describe('budget reservations', () => {
  it('admits a reservation that fits every cap', () => {
    expect(decideReservation(caps, usageOf({ global: none, role: none, scope: none }), 1_000)).toEqual({
      kind: 'within',
    });
  });

  it('reports the widest exhausted dimension first, and which limit it hit', () => {
    expect(
      decideReservation(
        caps,
        usageOf({ global: { requests: 10, tokens: 0 }, role: none, scope: { requests: 3, tokens: 0 } }),
        1,
      ),
    ).toEqual({ kind: 'exhausted', dimension: 'global', limit: 'requests' });
    expect(
      decideReservation(caps, usageOf({ global: none, role: { requests: 0, tokens: 4_500 }, scope: none }), 600),
    ).toEqual({ kind: 'exhausted', dimension: 'role', limit: 'tokens' });
    expect(
      decideReservation(caps, usageOf({ global: none, role: none, scope: { requests: 3, tokens: 0 } }), 1),
    ).toEqual({ kind: 'exhausted', dimension: 'scope', limit: 'requests' });
  });

  test.prop([
    fc.integer({ min: 0, max: 20_000 }),
    fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: 20_000 }),
  ])('never admits a reservation that would exceed any cap', (tokens, requests, spent) => {
    const usage = usageOf({
      global: { requests, tokens: spent },
      role: { requests, tokens: spent },
      scope: { requests, tokens: spent },
    });
    const decision = decideReservation(caps, usage, tokens);
    if (decision.kind === 'within')
      for (const dimension of ['global', 'role', 'scope'] as const) {
        expect(usage[dimension].requests + 1).toBeLessThanOrEqual(caps[dimension].requestsPerDay);
        expect(usage[dimension].tokens + tokens).toBeLessThanOrEqual(caps[dimension].tokensPerDay);
      }
  });

  it('refuses a single reservation larger than a cap on its own', () => {
    expect(decideReservation(caps, usageOf({ global: none, role: none, scope: none }), 3_001)).toMatchObject({
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

describe('the background share of the global and the personal caps', () => {
  const background = {
    global: { requestsPerDay: 4, tokensPerDay: 4_000 },
    scope: { requestsPerDay: 2, tokensPerDay: 2_000 },
  };
  const shared: BudgetCaps = { ...caps, background };
  const empty = usageOf({ global: none, role: none, scope: none });

  it('does not limit an interactive reservation, which carries no background share', () => {
    const usage = usageOf({
      global: { requests: 9, tokens: 0 },
      role: none,
      scope: { requests: 2, tokens: 0 },
      background: { global: { requests: 4, tokens: 0 }, scope: { requests: 2, tokens: 0 } },
    });
    expect(decideReservation(caps, usage, 1)).toEqual({ kind: 'within' });
  });

  it('stops a background reservation at its share of the global cap, then of the personal cap', () => {
    const globalFull = usageOf({
      global: { requests: 4, tokens: 0 },
      role: none,
      scope: none,
      background: { global: { requests: 4, tokens: 0 }, scope: none },
    });
    expect(decideReservation(shared, globalFull, 1)).toEqual({
      kind: 'exhausted',
      dimension: 'background_global',
      limit: 'requests',
    });
    const scopeFull = usageOf({
      global: none,
      role: none,
      scope: { requests: 0, tokens: 1_800 },
      background: { global: none, scope: { requests: 0, tokens: 1_800 } },
    });
    expect(decideReservation(shared, scopeFull, 300)).toEqual({
      kind: 'exhausted',
      dimension: 'background_scope',
      limit: 'tokens',
    });
  });

  it('keeps the plain cap code when a hard cap and the share are both full', () => {
    const usage = usageOf({
      global: { requests: 10, tokens: 0 },
      role: none,
      scope: none,
      background: { global: { requests: 4, tokens: 0 }, scope: none },
    });
    expect(decideReservation(shared, usage, 1)).toEqual({ kind: 'exhausted', dimension: 'global', limit: 'requests' });
  });

  it('leaves the rest of each cap to the interactive roles however much background work asks', () => {
    // Background spend is held at its share, so what remains of every cap is never touched by it.
    expect(decideReservation(shared, empty, 1_000)).toEqual({ kind: 'within' });
    const atShare = usageOf({
      global: { requests: 4, tokens: 4_000 },
      role: none,
      scope: { requests: 2, tokens: 2_000 },
      background: { global: { requests: 4, tokens: 4_000 }, scope: { requests: 2, tokens: 2_000 } },
    });
    expect(decideReservation(shared, atShare, 1).kind).toBe('exhausted');
    expect(decideReservation(caps, atShare, 1)).toEqual({ kind: 'within' });
  });

  test.prop([
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 0, max: 1_000_000_000 }),
    fc.integer({ min: 0, max: 100 }),
  ])('takes a rounded-down percentage of each limit', (requestsPerDay, tokensPerDay, percent) => {
    const share = backgroundShareOf({ requestsPerDay, tokensPerDay }, percent);
    expect(share.requestsPerDay).toBeLessThanOrEqual(requestsPerDay);
    expect(share.tokensPerDay).toBeLessThanOrEqual(tokensPerDay);
    expect(share.requestsPerDay).toBe(Math.floor((requestsPerDay * percent) / 100));
  });

  it('keeps the whole cap at 100 percent and gives background roles nothing at 0', () => {
    const cap = { requestsPerDay: 60, tokensPerDay: 600_000 };
    expect(backgroundShareOf(cap, 100)).toEqual(cap);
    expect(backgroundShareOf(cap, 0)).toEqual({ requestsPerDay: 0, tokensPerDay: 0 });
    expect(backgroundShareOf(cap, 50)).toEqual({ requestsPerDay: 30, tokensPerDay: 300_000 });
  });
});
