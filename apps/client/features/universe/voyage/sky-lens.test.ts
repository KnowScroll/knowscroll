import { lensRadii, strongestLenses, type LensBody } from './sky-lens';

const sun = (id: string, x: number, radiusPx = 10): LensBody => ({ id, kind: 'system', x, y: 300, radiusPx });
const world = (id: string, x: number, radiusPx = 12): LensBody => ({ id, kind: 'planet', x, y: 300, radiusPx });

describe('which bodies bend the stars behind them', () => {
  it('bends round every sun and every planet on screen, all the time, from the whole universe to a planet', () => {
    for (const stop of ['universe', 'star', 'planet'] as const) {
      const radii = lensRadii(stop, [sun('a', 100), world('p', 200)]);
      expect(radii.get('a')).toBeGreaterThan(0);
      expect(radii.get('p')).toBeGreaterThan(0);
    }
  });

  it('bends more round a sun than round a planet of the same size, and more round a bigger body', () => {
    const radii = lensRadii('star', [sun('s', 100, 20), world('p', 200, 20), world('big', 300, 40)]);
    expect(radii.get('s')).toBeGreaterThan(radii.get('p')!);
    expect(radii.get('big')).toBeGreaterThan(radii.get('p')!);
  });

  it('still bends round a far sun that is only a dot on screen', () => {
    expect(lensRadii('universe', [sun('far', 100, 0.5)]).get('far')).toBeGreaterThanOrEqual(10);
  });

  it('bends nothing on the ground, where the land fills the view', () => {
    expect(lensRadii('ground', [sun('a', 100), world('p', 200)]).size).toBe(0);
  });
});

describe('the lenses drawn', () => {
  it('keeps the largest few, each at its body', () => {
    const bodies = [sun('a', 10), sun('b', 20), sun('c', 30), sun('d', 40), sun('e', 50)];
    const radii = new Map([
      ['a', 5],
      ['b', 50],
      ['c', 0.5],
      ['d', 20],
      ['e', 30],
    ]);
    expect(strongestLenses(bodies, radii, 3)).toEqual([
      { x: 20, y: 300, radius: 50 },
      { x: 50, y: 300, radius: 30 },
      { x: 40, y: 300, radius: 20 },
    ]);
  });
});
