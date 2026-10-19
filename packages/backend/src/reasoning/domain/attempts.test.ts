import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { canTransition, decideOnDelivery, type AttemptState } from './attempts.js';

const states: readonly AttemptState[] = [
  'reserved',
  'not_sent',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
  'reconciled',
  'written_off',
];

describe('the external attempt state machine', () => {
  test.prop([fc.constantFrom(...states)])(
    'a redelivery may dispatch only an attempt that was never dispatched',
    (state) => {
      expect(decideOnDelivery(state) === 'dispatch').toBe(state === 'reserved');
    },
  );

  it('never returns to a sendable state from dispatched or unknown', () => {
    for (const from of ['dispatched', 'unknown'] as const) {
      expect(canTransition(from, 'reserved')).toBe(false);
      expect(canTransition(from, 'dispatched')).toBe(false);
    }
  });

  it('leaves unknown only by reconciliation or write-off', () => {
    expect(states.filter((to) => canTransition('unknown', to))).toEqual(['reconciled', 'written_off']);
  });
});
