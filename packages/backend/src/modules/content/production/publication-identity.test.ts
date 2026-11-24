import { describe, expect, it } from 'vitest';
import { libraryIdentity, writerFormatOf } from './publication-identity.js';

describe('writerFormatOf', () => {
  it('picks the format a recipe names, else a diagram for interactive recipes and a comparison otherwise', () => {
    expect(writerFormatOf({ interactive: true })).toBe('diagram');
    expect(writerFormatOf({ interactive: false })).toBe('comparison');
    expect(writerFormatOf({ interactive: true, interactiveKind: 'simulation' })).toBe('simulation');
  });
});

describe('libraryIdentity', () => {
  it('is factual, with the recipe’s own asset and explanation', () => {
    expect(libraryIdentity({ assetId: 'asset-1', explanationUnitId: 'unit-1' })).toEqual({
      assetId: 'asset-1',
      explanationUnitId: 'unit-1',
      kicker: 'A closer look',
      framing: { kind: 'factual' },
    });
  });
});
