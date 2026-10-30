import { CROWDED_TARGET, separateTargets, type TargetBox } from './separate-targets';

const box = (id: string, x: number, y: number, size = 48): TargetBox => ({ id, x, y, size });
const overlaps = (a: TargetBox, b: TargetBox): boolean =>
  Math.abs(a.x - b.x) < (a.size + b.size) / 2 - 1e-9 && Math.abs(a.y - b.y) < (a.size + b.size) / 2 - 1e-9;

describe('separating crowded tap targets', () => {
  it('leaves targets that do not touch exactly as they were', () => {
    const boxes = [box('a', 0, 0), box('b', 100, 0), box('c', 0, 60)];
    expect(separateTargets(boxes)).toEqual(boxes);
  });

  it('shrinks two overlapping targets until they touch, and no further than the smallest allowed', () => {
    const [first, second] = separateTargets([box('a', 0, 0), box('b', 30, 5)]);
    expect(first!.size).toBeCloseTo(30, 5);
    expect(second!.size).toBeCloseTo(30, 5);
    expect(overlaps(first!, second!)).toBe(false);
  });

  it('moves the hit areas apart when the centres are closer than the smallest size', () => {
    const [first, second] = separateTargets([box('a', 0, 0), box('b', 10, 3)]);
    expect(first!.size).toBe(CROWDED_TARGET);
    expect(second!.size).toBe(CROWDED_TARGET);
    expect(overlaps(first!, second!)).toBe(false);
  });

  it('keeps every target clear of every other in a crowd, in the same order, and is pure', () => {
    const crowd = [box('a', 0, 0), box('b', 12, 8), box('c', 20, 0), box('d', 5, 22), box('e', 400, 400)];
    const result = separateTargets(crowd);
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const one of result) for (const other of result) if (one !== other) expect(overlaps(one, other)).toBe(false);
    expect(separateTargets(crowd)).toEqual(result);
    expect(crowd[0]).toEqual(box('a', 0, 0));
  });
});
