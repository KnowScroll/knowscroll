import { describe, expect, it } from 'vitest';
import {
  BACKDROP_PRICING,
  BACKDROP_SPEND_CAP_MICRO_USD,
  chargeOf,
  decideSpend,
  isUnresolved,
  type BackdropAttemptState,
} from './backdrop-spend.js';

describe('the backdrop money rule', () => {
  it('caps all backdrops at one dollar, priced from the published per-image price', () => {
    expect(BACKDROP_SPEND_CAP_MICRO_USD).toBe(1_000_000);
    expect(BACKDROP_PRICING.microUsdPerImage).toBe(3_500);
    expect(BACKDROP_PRICING.sourceUrl).toMatch(/^https:\/\/platform\.minimax\.io\//);
    expect(BACKDROP_PRICING.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('allows a spend that ends exactly on the cap and refuses one that passes it by a millionth of a dollar', () => {
    expect(decideSpend(996_500, 3_500)).toEqual({ kind: 'allowed', afterMicroUsd: 1_000_000, remainingMicroUsd: 0 });
    expect(decideSpend(996_501, 3_500)).toEqual({
      kind: 'refused',
      recordedMicroUsd: 996_501,
      estimateMicroUsd: 3_500,
    });
  });

  it('refuses everything once the total is over, however small the estimate', () => {
    expect(decideSpend(1_000_001, 1).kind).toBe('refused');
    expect(decideSpend(0, 1_000_001).kind).toBe('refused');
    expect(decideSpend(0, 1_000_000).kind).toBe('allowed');
  });

  it('counts every state but a conclusive refusal and a call that never left, so doubt never lowers the total', () => {
    const states: BackdropAttemptState[] = [
      'dispatched',
      'succeeded',
      'failed',
      'not_sent',
      'unknown',
      'reconciled',
      'written_off',
    ];
    expect(states.map((state) => [state, chargeOf(state, 3_500)])).toEqual([
      ['dispatched', 3_500],
      ['succeeded', 3_500],
      ['failed', 0],
      ['not_sent', 0],
      ['unknown', 3_500],
      ['reconciled', 3_500],
      ['written_off', 3_500],
    ]);
    expect(states.filter(isUnresolved)).toEqual(['dispatched', 'unknown']);
  });
});
