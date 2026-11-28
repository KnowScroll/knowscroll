import { pullOf } from './ship-gravity';
import { GROUND_SIZE, SHADOW_OPACITY } from './ship-ground';
import {
  arrival,
  drawn,
  initialShip,
  landShip,
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
    expect(state.free).toBe(true);
    expect(distance(state, finger)).toBeLessThan(2);
    expect(state.size).toBeCloseTo(34, 0);
    expect(state.flame).toBeGreaterThanOrEqual(0.16);
  });

  it('glides home and stays parked when nothing holds it', () => {
    const away = { ...initialShip(HOME), x: 300, y: 250 };
    const state = run(away, BASE, 3);
    expect(distance(state, HOME)).toBeLessThan(0.5);
    expect(state.free).toBe(false);
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

  it('turns the short way round when its heading and the way it goes lie either side of the half turn', () => {
    const speed = 100;
    const across = 1.71;
    const flying = {
      ...initialShip(HOME),
      free: true,
      x: 195,
      y: 300,
      heading: -3,
      vx: speed * Math.cos(across),
      vy: speed * Math.sin(across),
    };
    const next = stepShip(flying, BASE, FRAME);
    expect(Math.abs(next.heading - flying.heading)).toBeLessThan(0.05);
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

describe('the pull of a body', () => {
  const sun: ShipTarget = { id: 'sun', x: 200, y: 380, pull: pullOf('system', 12) };
  const PLAIN: ShipTarget = { id: 'sun', x: 200, y: 380 };
  /**
   * A finger drawn up the screen past the sun at `offset` pt to its left in `seconds`, then held, stepped at `fps`
   * frames a second. The finger reports 30 times a second whatever the frame rate, as a touch screen's events do, so
   * every rate sees the same finger.
   */
  const pass = (target: ShipTarget, offset: number, fps: number, seconds = 1.6, hold = 0) => {
    const path: { x: number; y: number; candidate: string | null }[] = [];
    let state = initialShip({ ...HOME, x: 200 - offset, y: 600 });
    const fingerAt = (t: number) => {
      const sampled = Math.min(seconds, Math.floor(t * 30 + 1e-9) / 30);
      return { x: 200 - offset, y: 600 - (440 * sampled) / seconds };
    };
    const frames = Math.round((seconds + hold) * fps);
    for (let frame = 1; frame <= frames; frame++) {
      const input = {
        ...BASE,
        bounds: { left: 0, right: 400, top: 0, bottom: 800 },
        drag: fingerAt(frame / fps),
        targets: [target],
      };
      state = stepShip(state, input, 1 / fps);
      path.push({ x: state.x, y: state.y, candidate: state.candidate });
    }
    return { state, path };
  };
  const nearestApproach = (path: readonly { x: number; y: number }[]) =>
    Math.min(...path.map((point) => distance(point, sun)));

  it('curves a ship dragged past it toward it, 90 pt out, where the prototype’s pull did not reach', () => {
    const pulled = pass(sun, 90, 60);
    const plain = pass(PLAIN, 90, 60);
    expect(nearestApproach(pulled.path)).toBeLessThan(nearestApproach(plain.path) - 10);
    expect(pulled.path.some((point) => point.candidate === 'sun')).toBe(true);
    expect(plain.path.every((point) => point.candidate === null)).toBe(true);
  });

  it('lets the finger win: once past the sun the ship comes back to the finger', () => {
    const { state } = pass(sun, 90, 60, 1.6, 1.5);
    expect(state.candidate).toBeNull();
    expect(distance(state, { x: 110, y: 160 })).toBeLessThan(2);
  });

  it('moves the same at 30, 60 and 120 frames a second: held near the sun, and falling into it', () => {
    /** The ship at `seconds`, stepped at `fps`: taken from home to a finger held 120 pt from the sun, let go at 1.5 s. */
    const at = (fps: number, seconds: number) => {
      let state = initialShip(HOME);
      const input = { ...BASE, targets: [sun] };
      for (let frame = 1; frame <= Math.round(seconds * fps); frame++) {
        // The finger lifts at 1.5 s exactly, a frame boundary at every rate.
        const holding = frame <= Math.round(1.5 * fps);
        if (frame === Math.round(1.5 * fps) + 1) state = releaseShip(state, [sun]).state;
        state = stepShip(state, { ...input, drag: holding ? { x: 80, y: 380 } : null }, 1 / fps);
      }
      return state;
    };
    expect(at(60, 1.4).candidate).toBe('sun');
    expect(at(60, 1.6).falling).toBe('sun');
    for (const seconds of [0.3, 0.8, 1.4, 1.7, 1.9]) {
      expect(distance(at(30, seconds), at(120, seconds))).toBeLessThan(1);
      expect(distance(at(60, seconds), at(120, seconds))).toBeLessThan(1);
    }
  });

  it('draws a ship let go near it in, and says when it has reached it', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 70, y: 400 }, targets: [sun] }, 1.5);
    expect(held.candidate).toBe('sun');
    const gap = distance(held, sun);
    expect(gap).toBeGreaterThan(sun.pull!.capture);
    expect(gap).toBeLessThan(sun.pull!.fall);
    const { state, goTo } = releaseShip(held, [sun]);
    expect(goTo).toBeNull();
    expect(state.falling).toBe('sun');
    let falling = state;
    let frames = 0;
    while (arrival(falling, [sun], BASE.bounds) === null && frames < 120) {
      falling = stepShip(falling, { ...BASE, targets: [sun] }, FRAME);
      frames += 1;
    }
    expect(arrival(falling, [sun], BASE.bounds)).toBe('sun');
    // Seen to fall: it takes a good part of a second, not one frame.
    expect(frames).toBeGreaterThan(12);
    const landed = landShip(falling);
    expect(landed).toMatchObject({ free: false, falling: null, candidate: null });
  });

  it('reaches a body past the edge of its room at that edge, and does not fall for ever', () => {
    // A star above the top of the ship's room (it may not rise above y 150).
    const high: ShipTarget = { id: 'high', x: 200, y: 60, pull: pullOf('system', 12) };
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 200, y: 160 }, targets: [high] }, 1.5);
    const { state } = releaseShip(held, [high]);
    expect(state.falling).toBe('high');
    let falling = state;
    let frames = 0;
    while (arrival(falling, [high], BASE.bounds) === null && frames < 240) {
      falling = stepShip(falling, { ...BASE, targets: [high] }, FRAME);
      frames += 1;
    }
    expect(arrival(falling, [high], BASE.bounds)).toBe('high');
    expect(falling.y).toBeGreaterThanOrEqual(BASE.bounds.top);
  });

  it('stops falling when a flight or a pinch takes the view, and stays free where it is', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 70, y: 400 }, targets: [sun] }, 1.5);
    const { state } = releaseShip(held, [sun]);
    expect(state.falling).toBe('sun');
    const after = stepShip(state, { ...BASE, targets: [sun], away: true }, FRAME);
    expect(after.falling).toBeNull();
    expect(after.free).toBe(true);
    expect(arrival(after, [sun], BASE.bounds)).toBeNull();
  });

  it('lights the place it would go to by its pull, or in full where letting go would go there', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 70, y: 400 }, targets: [sun] }, 1.5);
    expect(drawn(held, sun).pullStrength).toBeCloseTo(held.pullStrength);
    expect(drawn(held, sun, 1).pullStrength).toBe(1);
    expect(drawn(held).pullStrength).toBe(0);
  });

  it('goes at once with reduced motion, where it would otherwise be drawn in', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 70, y: 400 }, targets: [sun] }, 1.5);
    expect(releaseShip(held, [sun], true).goTo).toBe('sun');
  });

  it('stays free where it was if the body it falls into leaves the screen', () => {
    const held = run(initialShip(HOME), { ...BASE, drag: { x: 70, y: 400 }, targets: [sun] }, 1.5);
    const { state } = releaseShip(held, [sun]);
    const after = run(state, { ...BASE, targets: [] }, 0.5);
    expect(after.falling).toBeNull();
    expect(after.free).toBe(true);
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
  it('leans with a free ship, capped, and carries the ship back so it does not slide', () => {
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

describe('the ship on the ground', () => {
  const LAND = { ...HOME, size: GROUND_SIZE };
  const GROUND: ShipInput = { ...BASE, home: LAND, ground: true };
  const landed = () => run(initialShip(LAND), GROUND, 0.1);
  /** A ship held at (120, 300) for `seconds`, stepped at `fps`. */
  const held = (input: ShipInput, seconds: number, fps: number, from = landed()) => {
    let state = from;
    for (let frame = 0; frame < Math.round(seconds * fps); frame++)
      state = stepShip(state, { ...input, drag: { x: 120, y: 300 } }, 1 / fps);
    return state;
  };
  const settle = (input: ShipInput, seconds: number, fps: number, from: ShipState) => {
    let state = from;
    for (let frame = 0; frame < Math.round(seconds * fps); frame++) state = stepShip(state, input, 1 / fps);
    return state;
  };

  it('is landed at rest: upright, flame off, a shadow under it, not lifted', () => {
    const state = run(landed(), GROUND, 1);
    expect(state.lift).toBe(0);
    expect(state.flame).toBe(0);
    expect(state.heading).toBe(0);
    expect(state.size).toBe(GROUND_SIZE);
    const ship = drawn(state);
    expect(ship.shadow).toBeDefined();
    expect(ship.y).toBe(state.y);
    expect(ship.flame).toBe(0);
    expect(ship.shadow!.opacity).toBeCloseTo(SHADOW_OPACITY, 6);
  });

  it('lifts off while it is held: the flame comes on, it rises, and the shadow shrinks, fades and drifts', () => {
    const rest = drawn(landed());
    const state = held(GROUND, 0.5, 60);
    expect(state.lift).toBe(1);
    expect(state.flame).toBeGreaterThanOrEqual(0.16);
    const ship = drawn(state);
    expect(ship.y).toBeLessThan(state.y - GROUND_SIZE * 0.3);
    expect(ship.shadow!.width).toBeLessThan(rest.shadow!.width);
    expect(ship.shadow!.opacity).toBeLessThan(rest.shadow!.opacity);
    // The shadow lies on the ground under the ship, never on the lifted ship.
    expect(ship.shadow!.y).toBeGreaterThan(state.y);
    expect(state.size).toBeGreaterThan(GROUND_SIZE);
  });

  it('settles over about 0.3 s when let go, the shadow coming back, and stays where it was dropped', () => {
    const up = held(GROUND, 0.5, 60);
    const settled = settle(GROUND, 0.35, 60, { ...up, candidate: null });
    expect(settled.lift).toBe(0);
    expect(settled.flame).toBe(0);
    expect(settled.free).toBe(true);
    // Let go in empty land the ship coasts to a stop where it was let go (the view leans); it does not slide back home.
    expect(distance(settled, LAND)).toBeGreaterThan(100);
    expect(drawn(settled).shadow!.opacity).toBeCloseTo(SHADOW_OPACITY, 2);
    // Part way, it is still coming down.
    const part = settle(GROUND, 0.15, 60, up);
    expect(part.lift).toBeGreaterThan(0);
    expect(part.lift).toBeLessThan(1);
    expect(part.flame).toBeGreaterThan(0);
    expect(part.flame).toBeLessThan(up.flame);
  });

  it('lifts and settles in the same time at 30 and at 60 frames a second', () => {
    for (const seconds of [0.1, 0.2]) {
      expect(held(GROUND, seconds, 30).lift).toBeCloseTo(held(GROUND, seconds, 60).lift, 6);
    }
    const up = held(GROUND, 0.5, 60);
    for (const seconds of [0.1, 0.2, 0.3]) {
      expect(settle(GROUND, seconds, 30, up).lift).toBeCloseTo(settle(GROUND, seconds, 60, up).lift, 6);
    }
  });

  it('is drawn lifted while held and landed once let go, with no tween, under reduced motion', () => {
    const calm = { ...GROUND, reducedMotion: true };
    const up = stepShip(landed(), { ...calm, drag: { x: 120, y: 300 } }, 1 / 60);
    expect(up.lift).toBe(1);
    expect(drawn(up).y).toBeLessThan(up.y);
    const down = stepShip(up, calm, 1 / 60);
    expect(down.lift).toBe(0);
    expect(drawn(down).y).toBe(down.y);
    expect(down.flame).toBe(0);
  });

  it('stays upright where it glides, and tips toward where it goes only while it is off the ground', () => {
    const sliding = run({ ...landed(), x: 300, y: 250 }, GROUND, 0.2);
    expect(sliding.lift).toBe(0);
    expect(sliding.heading).toBe(0);
    expect(sliding.flame).toBe(0);
    const flying = held(GROUND, 0.5, 60);
    expect(Math.abs(flying.heading)).toBeGreaterThan(0.2);
  });

  it('is upright again by the time it has settled, though it was let go still coasting', () => {
    let up = landed();
    for (let frame = 0; frame < 15; frame++) up = stepShip(up, { ...GROUND, drag: { x: 350, y: 560 } }, 1 / 60);
    // Flying across to the right, nose tipped that way.
    expect(up.heading).toBeGreaterThan(0.5);
    const down = settle(GROUND, 0.3, 60, up);
    expect(down.lift).toBe(0);
    expect(Math.hypot(down.vx, down.vy)).toBeGreaterThan(22);
    // Within a few degrees of upright, from over a radian.
    expect(Math.abs(down.heading)).toBeLessThan(0.15);
  });

  it('lifts while it is drawn into a place, and settles when it arrives', () => {
    const target: ShipTarget = { id: 'p', x: 120, y: 300, pull: pullOf('planet', 40) };
    const falling = stepShip(
      { ...landed(), x: 150, y: 330, falling: 'p', free: true },
      { ...GROUND, targets: [target] },
      1 / 60,
    );
    expect(falling.lift).toBeGreaterThan(0);
    const arrived = settle(GROUND, 0.4, 60, landShip(falling));
    expect(arrived.lift).toBe(0);
  });

  it('leaves the ship exactly as it was at every other stop: no lift, no shadow, today’s flame', () => {
    const state = held({ ...BASE }, 0.5, 60, initialShip(HOME));
    expect(state.ground).toBe(false);
    expect(state.lift).toBe(0);
    expect(state.flame).toBeGreaterThanOrEqual(0.16);
    expect(state.size).toBeCloseTo(34, 0);
    const ship = drawn(state);
    expect(ship.shadow).toBeUndefined();
    expect(ship.y).toBe(state.y);
    // A ship let go in the sky keeps today's held flame.
    expect(run({ ...state, candidate: null }, BASE, 0.5).flame).toBeGreaterThanOrEqual(0.16);
  });

  it('hides with its shadow while the view flies', () => {
    const gone = run(landed(), { ...GROUND, away: true }, 1);
    expect(drawn(gone).alpha).toBeLessThan(0.02);
    expect(drawn(gone).shadow!.opacity).toBeLessThan(0.01);
  });
});
