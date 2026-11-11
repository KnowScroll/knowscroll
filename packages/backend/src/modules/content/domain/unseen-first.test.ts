import { describe, expect, it } from 'vitest';
import { UNSEEN_FIRST_MAX_UNITS, validateUnseenFirst } from './unseen-first.js';

describe('the met units a read carries to put the unseen first', () => {
  it('accepts a list of ids up to the bound, and an empty one', () => {
    expect(validateUnseenFirst({ metUnitIds: [] })).toEqual([]);
    expect(validateUnseenFirst({ metUnitIds: ['unit-a', 'x'.repeat(160)] })).toHaveLength(2);
    const atBound = Array.from({ length: UNSEEN_FIRST_MAX_UNITS }, (_, n) => `unit-${String(n)}`);
    expect(validateUnseenFirst({ metUnitIds: atBound })).toHaveLength(UNSEEN_FIRST_MAX_UNITS);
  });

  it('refuses more ids than the bound, an empty or over-long id, and anything that is not a list of strings', () => {
    const over = Array.from({ length: UNSEEN_FIRST_MAX_UNITS + 1 }, (_, n) => `unit-${String(n)}`);
    for (const bad of [
      { metUnitIds: over },
      { metUnitIds: [''] },
      { metUnitIds: ['x'.repeat(161)] },
      { metUnitIds: [1] },
      { metUnitIds: 'unit-a' },
      { metUnitIds: null },
      { text: 'true', values: [] },
      {},
      null,
    ])
      expect(() => validateUnseenFirst(bad as never)).toThrow('UNSEEN_FIRST_INVALID');
  });

  it('carries ids as data: a quote or a semicolon is just part of an id, never text the query runs', () => {
    // The ids reach SQL only as one bound array parameter, so no character in them can change the query.
    expect(validateUnseenFirst({ metUnitIds: ["x'; drop table content.assets; --"] })).toEqual([
      "x'; drop table content.assets; --",
    ]);
  });
});
