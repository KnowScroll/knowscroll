import { describe, expect, it } from 'vitest';
import { canTransitionCutroomAttempt, decideCutroomDelivery } from './cutroom-attempt.js';

describe('Cutroom shares external-attempt safety (pure CI fixture)', () => {
  it('does not turn later delivery, unknown or write-off into a resend', () => {
    expect(decideCutroomDelivery('reserved')).toBe('dispatch');
    expect(decideCutroomDelivery('dispatched')).toBe('mark_unknown');
    for (const state of ['unknown', 'written_off', 'reconciled', 'failed', 'succeeded', 'not_sent'] as const) {
      expect(decideCutroomDelivery(state)).toBe('settled');
      expect(canTransitionCutroomAttempt(state, 'reserved')).toBe(false);
      expect(canTransitionCutroomAttempt(state, 'dispatched')).toBe(false);
    }
    expect(canTransitionCutroomAttempt('dispatched', 'unknown')).toBe(true);
    expect(canTransitionCutroomAttempt('unknown', 'reconciled')).toBe(true);
    expect(canTransitionCutroomAttempt('unknown', 'written_off')).toBe(true);
    expect(canTransitionCutroomAttempt('unknown', 'not_sent')).toBe(false);
  });
});
