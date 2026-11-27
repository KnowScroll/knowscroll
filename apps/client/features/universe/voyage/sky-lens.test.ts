import { lensRadii, strongestLenses, type LensBody } from './sky-lens';

const sun = (id: string, x: number, radiusPx = 10): LensBody => ({ id, kind: 'system', x, y: 300, radiusPx });
const world = (id: string, x: number, radiusPx = 12): LensBody => ({ id, kind: 'planet', x, y: 300, radiusPx });

describe('which bodies bend the stars behind them', () => {
  it('bends round every star a little, from the whole universe and at a star', () => {
    for (const stop of ['universe', 'star'] as const) {
      const radii = lensRadii(stop, [sun('a', 100), sun('b', 200, 40)], null);
      expect(radii.get('a')).toBeGreaterThan(0);
      expect(radii.get('b')).toBeGreaterThan(radii.get('a')!);
    }
  });

  it('bends nothing at a planet or on its ground, where the world fills the view', () => {
    const bodies = [sun('a', 100), world('p', 200)];
    const pull = { x: 200, y: 300, strength: 1 };
    expect(lensRadii('planet', bodies, pull).size).toBe(0);
    expect(lensRadii('ground', bodies, pull).size).toBe(0);
  });

  it('bends round a planet only while it pulls the ship, and round the body pulling more the harder it pulls', () => {
    const bodies = [sun('a', 100), world('p', 260)];
    expect(lensRadii('star', bodies, null).has('p')).toBe(false);
    const gentle = lensRadii('star', bodies, { x: 262, y: 301, strength: 0.2 });
    const strong = lensRadii('star', bodies, { x: 262, y: 301, strength: 1 });
    expect(gentle.get('p')).toBeGreaterThan(0);
    expect(strong.get('p')).toBeGreaterThan(gentle.get('p')!);
    expect(strong.get('a')).toBe(lensRadii('star', bodies, null).get('a'));
  });

  it('gives the pull to the body under it, not to one far from it', () => {
    const radii = lensRadii('universe', [sun('a', 100), sun('b', 300)], { x: 101, y: 300, strength: 1 });
    expect(radii.get('a')).toBeGreaterThan(radii.get('b')!);
    const none = lensRadii('universe', [sun('a', 100), sun('b', 300)], { x: 200, y: 300, strength: 1 });
    expect(none.get('a')).toBe(none.get('b'));
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
