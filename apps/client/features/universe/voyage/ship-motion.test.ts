import {
  drawn,
  initialShip,
  parkingSpot,
  pickShip,
  recentreShip,
  releaseShip,
  stepShip,
  type ShipInput,
  type ShipState,
  type ShipTarget,
} from './ship-motion';

const HOME = { x: 195, y: 570, size: 32, heading: 0 };
const BASE: ShipInput = {
  home: HOME,
  drag: null,
  targets: [],
  away: false,
  bounds: { left: 26, right: 364, top: 150, bottom: 640 },
  reducedMotion: false,
  viewCentre: { x: 195, y: 473 },
  leanLimit: 117,
};
const FRAME = 1 / 60;

const run = (start: ShipState, input: ShipInput, seconds: number): ShipState => {
  let state = start;
  for (let frame = 0; frame < Math.round(seconds / FRAME); frame++) state = stepShip(state, input, FRAME);
  return state;
};
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('the ship under a finger', () => {
  it('follows a finger and settles near it', () => {
    const finger = { x: 120, y: 300 };
    const state = run(initialShip(HOME), { ...BASE, drag: finger }, 3);
    expect(state.loose).toBe(true);
    expect(distance(state, finger)).toBeLessThan(2);
    expect(state.size).toBeCloseTo(34, 0);
    expect(state.flame).toBeGreaterThanOrEqual(0.16);
  });

  it('glides home and stays parked when nothing holds it', () => {
    const away = { ...initialShip(HOME), x: 300, y: 250, free: false };
    const state = run(away, BASE, 3);
    expect(distance(state, HOME)).toBeLessThan(0.5);
    expect(state.loose).toBe(false);
  });

  it('never leaves its bounds, even with a finger far outside them', () => {
    let state = initialShip(HOME);
    for (const finger of [
      { x: -500, y: -500 },
      { x: 2000, y: 2000 },
      { x: -50, y: 900 },
    ]) {
      for (let frame = 0; frame < 120; frame++) {
        state = stepShip(state, { ...BASE, drag: finger }, FRAME);
        expect(state.x).toBeGreaterThanOrEqual(BASE.bounds.left);
        expect(state.x).toBeLessThanOrEqual(BASE.bounds.right);
        expect(state.y).toBeGreaterThanOrEqual(BASE.bounds.top);
        expect(state.y).toBeLessThanOrEqual(BASE.bounds.bottom);
      }
    }
  });

  it('turns its nose toward where it travels and flames faster the faster it goes', () => {
    const slow = run(initialShip(HOME), { ...BASE, drag: { x: 195, y: 560 } }, 0.5);
    const rushing = stepShip(run(initialShip(HOME), { ...BASE, drag: { x: 195, y: 300 } }, 0.2), BASE, FRAME);
    expect(Math.abs(rushing.heading)).toBeLessThan(0.6);
    expect(rushing.flame).toBeGreaterThan(slow.flame);
    const goingRight = run(initialShip(HOME), { ...BASE, drag: { x: 340, y: 570 } }, 0.3);
    expect(goingRight.heading).toBeGreaterThan(0.5);
  });

  it('clamps a long step to a tenth of a second and ignores a step of no time', () => {
    const start = initialShip(HOME);
    const input = { ...BASE, drag: { x: 100, y: 300 } };
    expect(stepShip(start, input, 5)).toEqual(stepShip(start, input, 0.1));
    expect(stepShip(start, input, 0)).toBe(start);
  });
});

describe('catching a target', () => {
  const targets: readonly ShipTarget[] = [
    { id: 'near', x: 200, y: 300 },
    { id: 'far', x: 60, y: 300 },
  ];

  it('bends toward a target within 64 pt and reports it as the candidate', () => {
    const finger = { x: 240, y: 300 };
    const caught = run(initialShip(HOME), { ...BASE, drag: finger, targets }, 3);
    const alone = run(initialShip(HOME), { ...BASE, drag: finger, targets: [] }, 3);
    expect(caught.candidate).toBe('near');
    expect(alone.candidate).toBeNull();
    expect(caught.x).toBeLessThan(alone.x - 3);
    expect(distance(caught, targets[0]!)).toBeLessThan(distance(alone, targets[0]!));
  });

  it('does not bend toward a target beyond 64 pt', () => {
    const state = run(initialShip(HOME), { ...BASE, drag: { x: 300, y: 300 }, targets }, 2);
    expect(state.candidate).toBeNull();
    expect(distance(state, { x: 300, y: 300 })).toBeLessThan(2);
  });

  it('releases onto a candidate within 70 pt and reports where to fly', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 230, y: 300 }, targets }, 2);
    const { state, goTo } = releaseShip(held, targets);
    expect(goTo).toBe('near');
    expect(state.candidate).toBeNull();
  });

  it('stays free in empty sky and when the candidate is beyond 70 pt', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 300, y: 450 }, targets }, 2);
    expect(releaseShip(held, targets).goTo).toBeNull();
    const nearButMoved = {
      ...run(initialShip(HOME), { ...BASE, drag: { x: 230, y: 300 }, targets }, 2),
      x: 330,
      y: 330,
    };
    const released = releaseShip(nearButMoved, targets);
    expect(released.goTo).toBeNull();
    expect(released.state.free).toBe(true);
  });

  it('drifts to a stop where it was let go, until recentred', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 300, y: 300 } }, 2);
    const { state } = releaseShip(held, []);
    const later = run(state, BASE, 3);
    expect(later.free).toBe(true);
    expect(Math.hypot(later.vx, later.vy)).toBeLessThan(1);
    expect(distance(later, { x: 300, y: 300 })).toBeLessThan(40);
    const home = run(recentreShip(later), BASE, 4);
    expect(distance(home, HOME)).toBeLessThan(1);
  });
});

describe('hiding during a flight', () => {
  it('hides when the view is away and reappears when it is back', () => {
    const hidden = run(initialShip(HOME), { ...BASE, away: true }, 1);
    expect(hidden.vis).toBeLessThan(0.01);
    expect(drawn(hidden).alpha).toBeLessThan(0.01);
    const back = run(hidden, BASE, 2);
    expect(back.vis).toBeGreaterThan(0.99);
    expect(drawn(back).alpha).toBeGreaterThan(0.99);
  });

  it('lifts 46 pt and grows by half as it leaves, with the flame full', () => {
    const hidden = { ...initialShip(HOME), vis: 0 };
    const ship = drawn(hidden);
    expect(ship.y).toBeCloseTo(HOME.y - 46, 5);
    expect(ship.size).toBeCloseTo(HOME.size * 1.45, 5);
    const next = stepShip(hidden, { ...BASE, away: true }, FRAME);
    expect(next.flame).toBeCloseTo(0.9, 1);
  });

  it('can be picked up only when it is mostly there and the finger is within 26 pt', () => {
    const parked = initialShip(HOME);
    expect(pickShip(parked, 195, 570)).toBe(true);
    expect(pickShip(parked, 195 + 25, 570)).toBe(true);
    expect(pickShip(parked, 195 + 27, 570)).toBe(false);
    expect(pickShip({ ...parked, vis: 0.5 }, 195, 570)).toBe(false);
  });
});

describe('the leaning view', () => {
  it('leans with a loose ship, capped, and carries the ship back so it does not slide', () => {
    const limited = { ...BASE, leanLimit: 40 };
    const finger = { x: 40, y: 160 };
    const state = run(initialShip(HOME), { ...limited, drag: finger }, 3);
    expect(Math.hypot(state.lean.x, state.lean.y)).toBeLessThanOrEqual(40 + 1e-9);
    expect(Math.hypot(state.lean.x, state.lean.y)).toBeGreaterThan(39);
    expect(distance(state, finger)).toBeLessThan(2);
    expect(state.lean.x).toBeLessThan(0);
  });

  it('decays once the ship is recentred, and snaps to nothing', () => {
    const leaning = run(initialShip(HOME), { ...BASE, drag: { x: 60, y: 200 } }, 2);
    expect(Math.hypot(leaning.lean.x, leaning.lean.y)).toBeGreaterThan(20);
    const settled = run(recentreShip(leaning), BASE, 2);
    expect(settled.lean).toEqual({ x: 0, y: 0 });
    const early = stepShip(recentreShip(leaning), BASE, FRAME);
    expect(Math.hypot(early.lean.x, early.lean.y)).toBeLessThan(Math.hypot(leaning.lean.x, leaning.lean.y));
  });
});

describe('parking', () => {
  const anchor = { x: 195, y: 570 };

  it('parks at the anchor when nothing is in the way', () => {
    expect(parkingSpot({ anchor, avoid: [{ x: 50, y: 100, r: 20 }] })).toEqual(anchor);
  });

  it('steps aside past something tappable, in the order 64, -64, 112, -112', () => {
    const under = { x: 195, y: 570, r: 22 };
    expect(parkingSpot({ anchor, avoid: [under] })).toEqual({ x: 259, y: 570 });
    expect(parkingSpot({ anchor, avoid: [under, { x: 259, y: 570, r: 22 }] })).toEqual({ x: 131, y: 570 });
    expect(parkingSpot({ anchor, avoid: [under, { x: 259, y: 570, r: 22 }, { x: 131, y: 570, r: 22 }] })).toEqual({
      x: 307,
      y: 570,
    });
  });

  it('keeps clear by the thing’s radius plus 18 when that is more than 40', () => {
    expect(parkingSpot({ anchor, avoid: [{ x: 195 + 60, y: 570, r: 60 }] })).toEqual({ x: 131, y: 570 });
  });
});

describe('reduced motion', () => {
  it('snaps to the finger and home, with no springs, lean or fade', () => {
    const reduced = { ...BASE, reducedMotion: true };
    const finger = { x: 120, y: 300 };
    const held = stepShip(initialShip(HOME), { ...reduced, drag: finger }, FRAME);
    expect(distance(held, finger)).toBeLessThan(1e-9);
    expect(held.lean).toEqual({ x: 0, y: 0 });
    const gone = stepShip(held, { ...reduced, away: true }, FRAME);
    expect(gone.vis).toBe(0);
    const homeAgain = stepShip({ ...gone, free: false }, reduced, FRAME);
    expect(distance(homeAgain, HOME)).toBe(0);
    expect(homeAgain.vis).toBe(1);
  });
});

describe('determinism', () => {
  it('gives the same ship for the same inputs', () => {
    const script = (): ShipState => {
      let state = initialShip(HOME);
      for (let frame = 0; frame < 90; frame++) {
        state = stepShip(state, { ...BASE, drag: { x: 100 + frame, y: 300 }, away: frame > 60 }, FRAME);
      }
      return state;
    };
    expect(script()).toEqual(script());
  });
});
