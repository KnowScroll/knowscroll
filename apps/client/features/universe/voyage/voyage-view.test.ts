import * as THREE from 'three';
import { FIELD_OF_VIEW } from '../space/camera-rig';
import type { Chain } from './flight';
import { STOPS } from './ladder';
import { heldOffset, orbitDirection, placeCamera, planetDirection, viewDirection, type Placement } from './voyage-view';

const HEIGHT = 800;
const planet = new THREE.Vector3(4, 0, 0);
const sun = new THREE.Vector3(0, 0, 0);
/** A planet's chain: the planet stop at 3, its star at 12, the universe at 60 (only the distances matter here). */
const chain: Chain = [
  { distance: 3, point: [4, 0, 0] },
  { distance: 12, point: [0, 0, 0] },
  { distance: 60, point: [0, 0, 0] },
];
const view = (distance: number) =>
  viewDirection({ stop: 'planet', turnX: 0, planet, sun, planetChain: chain, distance }, new THREE.Vector3());

describe('the direction of the view', () => {
  it('looks down from 30 degrees round a star, and turns with the finger', () => {
    const straight = orbitDirection(0, new THREE.Vector3());
    expect(THREE.MathUtils.radToDeg(Math.asin(straight.y))).toBeCloseTo(30);
    expect(straight.length()).toBeCloseTo(1);
    const turned = orbitDirection(100, new THREE.Vector3());
    expect(turned.y).toBeCloseTo(straight.y);
    expect(turned.x).toBeGreaterThan(0.1);
  });

  it('is the plain orbit direction at a star, with or without a planet to look at', () => {
    const plain = orbitDirection(50, new THREE.Vector3());
    const atStar = viewDirection(
      { stop: 'star', turnX: 50, planet: undefined, sun: undefined, planetChain: null, distance: 12 },
      new THREE.Vector3(),
    );
    expect(atStar.distanceTo(plain)).toBeCloseTo(0);
    expect(view(12).distanceTo(orbitDirection(0, new THREE.Vector3()))).toBeCloseTo(0);
  });

  it('keeps the turn at the outer stop as it does at the universe, so the camera does not pop when the stop is entered', () => {
    const turned = orbitDirection(50, new THREE.Vector3());
    for (const stop of ['universe', 'outer'] as const)
      expect(
        viewDirection(
          { stop, turnX: 50, planet: undefined, sun: undefined, planetChain: null, distance: 12 },
          new THREE.Vector3(),
        ).distanceTo(turned),
      ).toBeCloseTo(0);
  });

  it('turns fully to the planet day side at the planets own distance, and part way between', () => {
    const day = planetDirection(planet, sun, new THREE.Vector3());
    expect(view(3).distanceTo(day)).toBeCloseTo(0);
    const middle = view(6);
    const orbit = orbitDirection(0, new THREE.Vector3());
    expect(middle.distanceTo(orbit)).toBeGreaterThan(0.01);
    expect(middle.distanceTo(day)).toBeGreaterThan(0.01);
  });

  it('ignores the finger turn near a planet', () => {
    const turned = viewDirection(
      { stop: 'planet', turnX: 500, planet, sun, planetChain: chain, distance: 3 },
      new THREE.Vector3(),
    );
    expect(turned.distanceTo(view(3))).toBeCloseTo(0);
  });
});

describe('where the subject is held', () => {
  it('at rest is the stop height below the middle', () => {
    for (const stop of ['universe', 'star', 'planet', 'ground'] as const)
      expect(heldOffset(null, stop, 1, HEIGHT)).toBeCloseTo((0.5 - STOPS[stop].heldAt) * HEIGHT);
  });

  it('in flight moves from the stop left to the stop ahead without a jump at either end', () => {
    expect(heldOffset('universe', 'planet', 0, HEIGHT)).toBeCloseTo(heldOffset(null, 'universe', 1, HEIGHT));
    expect(heldOffset('universe', 'planet', 1, HEIGHT)).toBeCloseTo(heldOffset(null, 'planet', 1, HEIGHT));
    const halfway = heldOffset('universe', 'planet', 0.5, HEIGHT);
    const [a, b] = [heldOffset(null, 'universe', 1, HEIGHT), heldOffset(null, 'planet', 1, HEIGHT)];
    expect(halfway).toBeGreaterThan(Math.min(a, b));
    expect(halfway).toBeLessThan(Math.max(a, b));
  });
});

describe('placing the camera', () => {
  const direction = new THREE.Vector3(0.3, 0.5, 0.8).normalize();
  const place = (distance: number, lean = { x: 0, y: 0 }): Placement => ({
    focus: [1, 2, 3],
    direction,
    distance,
    lean,
    held: 0,
    fov: FIELD_OF_VIEW,
    focal: 500,
  });

  it('stands the camera the distance away from its aim along the direction', () => {
    const position = new THREE.Vector3();
    const pose = placeCamera(place(7), position);
    const aim = new THREE.Vector3(...pose.target);
    pose.target.forEach((value, axis) => expect(value).toBeCloseTo([1, 2, 3][axis]!));
    expect(position.distanceTo(aim)).toBeCloseTo(7);
    expect(position.clone().sub(aim).normalize().distanceTo(direction)).toBeCloseTo(0);
    expect(pose.position).toEqual(position.toArray());
    expect(pose.fov).toBe(FIELD_OF_VIEW);
  });

  it('moves the aim sideways, across the direction, in proportion to the distance', () => {
    const shift = (distance: number) => {
      const pose = placeCamera(place(distance, { x: 50, y: 0 }), new THREE.Vector3());
      return new THREE.Vector3(...pose.target).sub(new THREE.Vector3(1, 2, 3));
    };
    const near = shift(4);
    const far = shift(8);
    expect(near.length()).toBeCloseTo((50 * 4) / 500);
    expect(far.length()).toBeCloseTo(2 * near.length());
    expect(near.dot(direction)).toBeCloseTo(0);
  });
});
