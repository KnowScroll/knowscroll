import type { SpaceAnchor } from '../space/space-surface';
import { GROUND_SIZE, shipBoxOf } from './ship-ground';
import { placeNames } from './voyage-stage';

const region = (id: string, x: number, y: number): SpaceAnchor => ({
  id,
  kind: 'region',
  name: id,
  systemId: 's',
  x,
  y,
  radiusPx: 0,
  visible: true,
});
const size = { width: 390, height: 844 };
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('the names on the ground', () => {
  it('hangs the "you are here" pill under the ship, riding the region’s point', () => {
    const names = placeNames([region('r', 195, 380)], size, 'r', 'r', null, true, []);
    const pill = names.get('r')!;
    expect(pill.y).toBeGreaterThanOrEqual(380);
    expect(pill.y).toBeLessThan(380 + 20);
  });

  it('hangs it under the ship where the ship stands, not under the region’s own point', () => {
    const names = placeNames([region('r', 60, 200)], size, 'r', 'r', { x: 250, y: 420 }, true, []);
    const pill = names.get('r')!;
    expect(pill.x + pill.width / 2).toBeCloseTo(250, 0);
    expect(pill.y).toBeGreaterThanOrEqual(420);
  });

  it('never sets the pill on the ship: with no room under it, near the chips, it is left out', () => {
    // The ship's feet are at y 640, the foot of the ship's room on a phone: below them is the band of the chips.
    for (const foot of [
      { x: 195, y: 610 },
      { x: 195, y: 626 },
      { x: 195, y: 640 },
    ]) {
      const names = placeNames([region('r', 195, foot.y)], size, 'r', 'r', foot, true, []);
      const pill = names.get('r');
      if (pill !== undefined) expect(overlaps(pill, shipBoxOf(foot, GROUND_SIZE))).toBe(false);
    }
  });

  it('writes a region’s name on the ground in a taller, wider box than elsewhere', () => {
    const ground = placeNames([region('r', 195, 300)], size, 'x', null, null, true, []).get('r')!;
    const orbit = placeNames([region('r', 195, 300)], size, 'x', null, null, false, []).get('r')!;
    expect(ground.height).toBeGreaterThan(orbit.height);
    expect(ground.width).toBeGreaterThan(orbit.width);
  });
});
