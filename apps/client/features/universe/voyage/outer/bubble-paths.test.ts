import { bubbleDots } from '../../crossing/crossing-bubble';
import { bubblePaths } from './bubble-paths';

const squares = (d: string): number => (d.match(/M/g) ?? []).length;

describe('the bubble as paths', () => {
  it('draws the same web as the crossing: one square for each dot, in three colour groups', () => {
    const paths = bubblePaths('ravi', 36);
    const dots = bubbleDots('ravi');
    expect(paths.paths).toHaveLength(3);
    expect(squares(paths.paths[0]) + squares(paths.paths[1]) + squares(paths.paths[2])).toBe(dots.length);
    for (const colour of [0, 1, 2] as const)
      expect(squares(paths.paths[colour])).toBe(dots.filter((dot) => dot.colour === colour).length);
  });

  it('is the same for the same seed and different for another', () => {
    expect(bubblePaths('ravi', 36).paths).toEqual(bubblePaths('ravi', 36).paths);
    expect(bubblePaths('ravi', 36).paths[0]).not.toBe(bubblePaths('mei', 36).paths[0]);
  });

  it('keeps a dot at least 0.9 px wide on a small bubble and scales the web with the radius', () => {
    expect(bubblePaths('ravi', 30).dot).toBeGreaterThanOrEqual(0.9);
    const small = bubblePaths('ravi', 30).paths[1];
    const large = bubblePaths('ravi', 90).paths[1];
    const reach = (d: string): number =>
      Math.max(...[...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Math.abs(Number(m[1]))));
    expect(reach(large)).toBeGreaterThan(reach(small) * 2.5);
    expect(reach(large)).toBeLessThanOrEqual(90);
  });

  it('keeps one dot in `every`, for a small bubble', () => {
    const all = bubblePaths('ravi', 24).paths.reduce((sum, d) => sum + squares(d), 0);
    const some = bubblePaths('ravi', 24, 2).paths.reduce((sum, d) => sum + squares(d), 0);
    expect(some).toBeLessThan(all * 0.6);
    expect(some).toBeGreaterThan(all * 0.4);
  });

  it('is light: a screenful of bubbles is a few tens of kilobytes of path and three elements each', () => {
    const size = bubblePaths('ravi', 32).paths.reduce((sum, d) => sum + d.length, 0);
    expect(size).toBeLessThan(20_000);
  });
});
