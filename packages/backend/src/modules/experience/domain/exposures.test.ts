import { describe, expect, it } from 'vitest';
import { decideActivation } from './exposures.js';

describe('decideActivation', () => {
  const now = new Date('2026-10-20T10:00:00Z');

  it('activates an exposure that is not active yet, at the time of the command', () => {
    expect(decideActivation({ activatedAt: undefined }, now)).toEqual({ changed: true, activatedAt: now });
  });

  it('never moves an activation: an active exposure keeps its original time', () => {
    const first = new Date('2026-10-20T09:00:00Z');
    expect(decideActivation({ activatedAt: first }, now)).toEqual({ changed: false, activatedAt: first });
  });
});
