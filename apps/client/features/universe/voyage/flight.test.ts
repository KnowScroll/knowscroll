import type { Vec3 } from '../space/camera-rig';
import { depthOf, LADDER, stopOf } from './ladder';
import { flightAt, focusAlong, gravity, planFlight, release, type Chain } from './flight';

const planet: Vec3 = [10, 0, 0];
const star: Vec3 = [0, 0, 0];
const middle: Vec3 = [0, 0, 50];
/** A planet's chain: the planet stop at 8.5, its star at 20, the whole universe at 120. */
const planetChain: Chain = [
  { distance: 8.5, point: planet },
  { distance: 20, point: star },
  { distance: 120, point: middle },
];
const expectNear = (actual: Vec3, expected: Vec3) =>
  actual.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis]!));
const starChain: Chain = planetChain.slice(1);

describe('the ladder', () => {
  it('runs from the whole universe down to the ground, and a level above a star would sit between the first two', () => {
    expect(LADDER).toEqual(['universe', 'star', 'planet', 'ground']);
    expect(depthOf('universe')).toBeLessThan(depthOf('star'));
    expect(depthOf('planet')).toBeLessThan(depthOf('ground'));
  });

  it('reads the stop from the stored camera as it always was', () => {
    expect(stopOf({ kind: 'universe' })).toBe('universe');
    const descriptor = { objectId: 'p' } as never;
    expect(stopOf({ kind: 'system', system: descriptor })).toBe('star');
    expect(stopOf({ kind: 'planet', planet: descriptor, landed: false })).toBe('planet');
    expect(stopOf({ kind: 'planet', planet: descriptor, landed: true })).toBe('ground');
  });
});

describe('a chain', () => {
  it('moves the focus in a straight line between two stops as the distance does', () => {
    expect(focusAlong(planetChain, 1)).toEqual(planet);
    expect(focusAlong(planetChain, 8.5)).toEqual(planet);
    const between = focusAlong(planetChain, (8.5 + 20) / 2);
    expect(between[0]).toBeCloseTo(5);
    expect(focusAlong(planetChain, 500)).toEqual(middle);
  });
});

describe('the curves', () => {
  it('falls in gently, then faster, past the end a little, and is caught at 1', () => {
    expect(gravity(0)).toBe(0);
    expect(gravity(0.43)).toBeLessThan(0.3);
    expect(gravity(0.86)).toBeCloseTo(0.93);
    expect(Math.max(...[0.9, 0.93, 0.96].map(gravity))).toBeGreaterThan(1);
    expect(gravity(1)).toBeCloseTo(1, 10);
  });

  it('leaves held a moment, then away', () => {
    expect(release(0)).toBeCloseTo(0, 10);
    expect(release(0.1)).toBeLessThan(0);
    expect(release(1)).toBe(1);
  });
});

describe('a flight', () => {
  it('falls from a star to its planet along the planet’s chain, and arrives exactly', () => {
    const plan = planFlight({
      fromDistance: 20,
      toDistance: 8.5,
      peakDistance: null,
      launchFocus: star,
      fromChain: starChain,
      toChain: planetChain,
      touchesGround: false,
    });
    expect(plan.curve).toBe('gravity');
    expect(plan.hump).toBe(0);
    expect(plan.seconds).toBeGreaterThan(0.9);
    expect(plan.seconds).toBeLessThanOrEqual(3.4);
    const start = flightAt(plan, 0, starChain, planetChain);
    expect(start.distance).toBeCloseTo(20);
    expectNear(start.focus, star);
    const end = flightAt(plan, plan.seconds, starChain, planetChain);
    expect(end.done).toBe(true);
    expect(end.distance).toBeCloseTo(8.5);
    expectNear(end.focus, planet);
  });

  it('climbs to the shared star between two planets, crosses, and comes down on the other', () => {
    const other: Vec3 = [-8, 0, 0];
    const otherChain: Chain = [{ distance: 8.5, point: other }, ...starChain];
    const plan = planFlight({
      fromDistance: 8.5,
      toDistance: 8.5,
      peakDistance: 20,
      launchFocus: planet,
      fromChain: planetChain,
      toChain: otherChain,
      touchesGround: false,
    });
    expect(plan.hump).toBeCloseTo(Math.log(20) - Math.log(8.5));
    const top = flightAt(plan, plan.seconds / 2, planetChain, otherChain);
    expect(top.distance).toBeCloseTo(20);
    expect(top.focus[0]).toBeCloseTo(0);
    const end = flightAt(plan, plan.seconds, planetChain, otherChain);
    expectNear(end.focus, other);
  });

  it('starts where the camera was looking and lets go of that by half way', () => {
    const plan = planFlight({
      fromDistance: 20,
      toDistance: 8.5,
      peakDistance: null,
      launchFocus: [3, 0, 0],
      fromChain: starChain,
      toChain: planetChain,
      touchesGround: false,
    });
    expect(flightAt(plan, 0, starChain, planetChain).focus[0]).toBeCloseTo(3);
    const half = flightAt(plan, plan.seconds / 2, starChain, planetChain);
    expect(half.focus).toEqual(focusAlong(planetChain, half.distance));
  });

  it('is a little longer to or from the ground, and quicker after a pinch', () => {
    const base = {
      fromDistance: 8.5,
      toDistance: 2.4,
      peakDistance: null,
      launchFocus: planet,
      fromChain: planetChain,
      toChain: planetChain,
    };
    const plain = planFlight({ ...base, touchesGround: false }).seconds;
    expect(planFlight({ ...base, touchesGround: true }).seconds).toBeCloseTo(plain * 1.15);
    expect(planFlight({ ...base, touchesGround: false, fast: true }).seconds).toBeCloseTo(plain * 0.6);
  });
});
