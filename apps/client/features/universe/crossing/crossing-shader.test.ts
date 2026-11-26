import { CROSSING_FRAGMENT, crossingPixelRatio } from './crossing-shader';

describe('the crossing shader', () => {
  it('draws at most 1.25 device pixels per layout pixel, and never fewer than 1', () => {
    expect(crossingPixelRatio(3)).toBe(1.25);
    expect(crossingPixelRatio(1.5)).toBe(1.25);
    expect(crossingPixelRatio(1)).toBe(1);
    expect(crossingPixelRatio(0.5)).toBe(1);
    expect(crossingPixelRatio(Number.NaN)).toBe(1);
  });

  it('declares the uniforms the renderer sets', () => {
    for (const name of [
      'uRes',
      'uC',
      'uT',
      'uR',
      'uOpen',
      'uK',
      'uTwist',
      'uSpeed',
      'uFar',
      'uDark',
      'uGlow',
      'uSeed',
      'uA',
      'uM',
      'uB',
    ])
      expect(CROSSING_FRAGMENT).toMatch(new RegExp(`\\b${name}\\b`));
  });
});
