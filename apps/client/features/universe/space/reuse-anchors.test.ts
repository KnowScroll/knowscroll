import { reuseUnchangedAnchors } from './reuse-anchors';
import type { SpaceAnchor } from './space-surface';

const anchor = (id: string, x: number, y: number, visible = true): SpaceAnchor => ({
  id,
  kind: 'planet',
  name: id,
  x,
  y,
  visible,
});

describe('reusing anchors between frames', () => {
  it('returns the same list when nothing moved a visible amount', () => {
    const before = [anchor('a', 10, 10), anchor('b', 50, 60)];
    const after = [anchor('a', 10.2, 9.9), anchor('b', 50, 60)];
    expect(reuseUnchangedAnchors(before, after)).toBe(before);
  });

  it('keeps the objects that held still and replaces the one that moved', () => {
    const before = [anchor('a', 10, 10), anchor('b', 50, 60)];
    const after = [anchor('a', 10, 10), anchor('b', 53, 60)];
    const merged = reuseUnchangedAnchors(before, after);
    expect(merged).not.toBe(before);
    expect(merged[0]).toBe(before[0]);
    expect(merged[1]).toBe(after[1]);
  });

  it('notices a label that appears or goes behind the camera', () => {
    const before = [anchor('a', 10, 10)];
    expect(reuseUnchangedAnchors(before, [anchor('a', 10, 10, false)])[0]!.visible).toBe(false);
    expect(reuseUnchangedAnchors(before, [anchor('a', 10, 10), anchor('b', 1, 1)])).toHaveLength(2);
  });
});
