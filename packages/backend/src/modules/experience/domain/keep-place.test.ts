import { describe, expect, it } from 'vitest';
import { nextKeepRevision, positionForTarget } from './keep-place.js';
describe('Keep revision and immutable target rules (synthetic unit fixtures)', () => {
  it('increments safely and refuses exhaustion or an invalid counter', () => {
    expect(nextKeepRevision(0)).toBe(1);
    expect(nextKeepRevision(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Infinity, NaN])
      expect(nextKeepRevision(value)).toBeUndefined();
  });
  it('uses actual duration with fractions and only actual top-level anchors, without server geometry', () => {
    expect(positionForTarget({ kind: 'reel', positionMs: 12.75 }, { kind: 'reel', durationMs: 25001 })).toEqual({
      kind: 'reel',
      positionMs: 12.75,
    });
    expect(positionForTarget({ kind: 'reel', positionMs: 900000 }, { kind: 'reel', durationMs: 25001 })).toEqual({
      kind: 'reel',
      positionMs: 25001,
    });
    expect(
      positionForTarget(
        { kind: 'scroll', blockId: 'parent', offsetWithinBlock: 12345.75 },
        { kind: 'scroll', topLevelBlockIds: ['parent'] },
      ),
    ).toEqual({ kind: 'scroll', blockId: 'parent', offsetWithinBlock: 12345.75 });
    expect(
      positionForTarget(
        { kind: 'scroll', blockId: 'child', offsetWithinBlock: 1 },
        { kind: 'scroll', topLevelBlockIds: ['parent'] },
      ),
    ).toBeUndefined();
    expect(
      positionForTarget({ kind: 'reel', positionMs: 1 }, { kind: 'scroll', topLevelBlockIds: ['parent'] }),
    ).toBeUndefined();
  });
});
