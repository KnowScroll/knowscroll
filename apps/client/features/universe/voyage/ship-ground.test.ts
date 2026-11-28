import {
  FOOT_SHARE,
  footOf,
  LIFT_GROWTH,
  LIFT_RISE_SHARE,
  LIFT_SECONDS,
  liftedOf,
  liftStep,
  SETTLE_SECONDS,
  SHADOW_OPACITY,
  shadowOf,
  shipBoxOf,
} from './ship-ground';

/** The lift after `seconds` of holding (or not holding) a ship, frame by frame at `fps`. */
function lift(from: number, lifting: boolean, seconds: number, fps: number): number {
  let value = from;
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) value = liftStep(value, lifting, 1 / fps, false);
  return value;
}

describe('the ship lifting off and settling', () => {
  it('lifts in a fifth of a second and settles in 0.3 s, whatever the frame rate', () => {
    for (const fps of [30, 60, 120]) {
      expect(lift(0, true, LIFT_SECONDS, fps)).toBeCloseTo(1, 6);
      expect(lift(1, false, SETTLE_SECONDS, fps)).toBeCloseTo(0, 6);
      // A third of the way through the settle it is a third of the way down, at every rate.
      expect(lift(1, false, SETTLE_SECONDS / 3, fps)).toBeCloseTo(2 / 3, 6);
    }
    expect(SETTLE_SECONDS).toBeCloseTo(0.3, 6);
  });

  it('agrees at 30 and at 60 frames a second at every moment they both reach', () => {
    for (const seconds of [0.1, 0.2, 0.3]) {
      expect(lift(1, false, seconds, 30)).toBeCloseTo(lift(1, false, seconds, 60), 6);
      expect(lifted(lift(0, true, seconds, 30))).toBeCloseTo(lifted(lift(0, true, seconds, 60)), 6);
    }
  });

  it('never goes past its goal, and a stalled frame cannot throw it over', () => {
    expect(liftStep(0.9, true, 1, false)).toBe(1);
    expect(liftStep(0.1, false, 1, false)).toBe(0);
  });

  it('jumps with reduced motion: lifted while held, landed the moment it is let go', () => {
    expect(liftStep(0, true, 1 / 60, true)).toBe(1);
    expect(liftStep(1, false, 1 / 60, true)).toBe(0);
  });

  it('eases: it leaves the ground and arrives gently, and is lifted in proportion', () => {
    expect(liftedOf(0)).toBe(0);
    expect(liftedOf(1)).toBe(1);
    expect(liftedOf(0.1)).toBeLessThan(0.1);
    expect(liftedOf(0.9)).toBeGreaterThan(0.9);
    expect(liftedOf(-1)).toBe(0);
    expect(liftedOf(2)).toBe(1);
  });
});

const lifted = liftedOf;

describe('the ship’s shadow', () => {
  const ship = { x: 195, y: 500, size: 42 };

  it('lies under the ship’s fins when it is landed: a soft ellipse, wider than tall', () => {
    const shadow = shadowOf(ship, 0, 1);
    expect(shadow.x).toBe(195);
    expect(shadow.y).toBeGreaterThan(footOf(ship).y);
    expect(shadow.y - footOf(ship).y).toBeLessThan(ship.size * 0.1);
    expect(shadow.width).toBeGreaterThan(ship.size * 0.6);
    expect(shadow.height).toBeLessThan(shadow.width / 3);
    expect(shadow.opacity).toBeCloseTo(SHADOW_OPACITY, 6);
    expect(footOf(ship).y).toBeCloseTo(500 + 42 * FOOT_SHARE, 6);
  });

  it('shrinks, fades and drifts away from the light as the ship rises, and stays on the ground', () => {
    const landed = shadowOf(ship, 0, 1);
    const half = shadowOf(ship, 0.5, 1);
    const up = shadowOf(ship, 1, 1);
    expect(half.width).toBeLessThan(landed.width);
    expect(up.width).toBeLessThan(half.width);
    expect(up.height).toBeLessThan(landed.height);
    expect(up.opacity).toBeLessThan(half.opacity);
    expect(half.opacity).toBeLessThan(landed.opacity);
    expect(up.opacity).toBeGreaterThan(0);
    // Away from a light above and to the left: right and down.
    expect(up.x).toBeGreaterThan(landed.x);
    expect(up.y).toBeGreaterThan(landed.y);
    // It follows the ground point under the ship, not the ship's rise: it moves a fraction of the rise only.
    expect(up.y - landed.y).toBeLessThan(ship.size * LIFT_RISE_SHARE);
    expect(LIFT_GROWTH).toBeGreaterThan(0);
  });

  it('goes with the ship when it is hidden for a flight', () => {
    expect(shadowOf(ship, 0, 0).opacity).toBe(0);
    expect(shadowOf(ship, 0, 0.5).opacity).toBeCloseTo(SHADOW_OPACITY / 2, 6);
  });
});

describe('the box a landed ship covers', () => {
  it('stands on the ground point, as wide as its fins and as tall as its art, so a name can keep off it', () => {
    const box = shipBoxOf({ x: 200, y: 600 }, 42);
    expect(box.x + box.width / 2).toBeCloseTo(200, 6);
    expect(box.y + box.height).toBeCloseTo(600, 6);
    expect(box.width).toBeCloseTo(42 * 0.64, 6);
    expect(box.height).toBeGreaterThan(30);
    expect(box.height).toBeLessThan(42);
  });
});
