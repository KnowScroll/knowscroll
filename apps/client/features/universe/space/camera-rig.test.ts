import {
  distanceOf,
  fitDistance,
  flyDone,
  flyPose,
  FAR_DISTANCE,
  FLY_SECONDS,
  isFar,
  rigPose,
  withDrift,
  ZOOM_LIMITS,
  type RigFocus,
  type RigSpec,
} from './camera-rig';

const universe: RigFocus = { kind: 'universe', center: { x: 2, z: -3 }, halfWidth: 8, halfDepth: 8 };
const phone = { width: 390, height: 844 };
const still = { x: 0, y: 0, scale: 1 };
const spec = (overrides: Partial<RigSpec> = {}): RigSpec => ({ focus: universe, frame: still, ...phone, ...overrides });

describe('the space camera rig', () => {
  it('frames the whole universe from a distance that grows with what must fit', () => {
    const small = rigPose(spec({ focus: { ...universe, halfWidth: 6, halfDepth: 6 } }));
    const large = rigPose(spec({ focus: { ...universe, halfWidth: 18, halfDepth: 18 } }));
    expect(distanceOf(large)).toBeGreaterThan(distanceOf(small));
    expect(small.target[0]).toBeCloseTo(2, 5);
  });

  it('is nearer on a wide screen than a narrow one for the same system', () => {
    expect(fitDistance(8, 8, 1.6, 'system')).toBeLessThan(fitDistance(8, 8, 0.46, 'system'));
  });

  it('reads as Far only when the camera has drawn back past the threshold', () => {
    expect(isFar(rigPose(spec({ focus: { ...universe, halfWidth: 6, halfDepth: 6 } })))).toBe(false);
    expect(isFar(rigPose(spec({ focus: { ...universe, halfWidth: 30, halfDepth: 30 } })))).toBe(true);
    const zoomedOut = rigPose(spec({ frame: { x: 0, y: 0, scale: ZOOM_LIMITS.universe.min } }));
    expect(isFar(zoomedOut)).toBe(distanceOf(zoomedOut) > FAR_DISTANCE);
    expect(distanceOf(zoomedOut)).toBeGreaterThan(distanceOf(rigPose(spec())));
  });

  it('fits a deep universe from nearer than a wide one on a tall screen', () => {
    const deep = rigPose(spec({ focus: { ...universe, halfWidth: 6, halfDepth: 16 } }));
    const wide = rigPose(spec({ focus: { ...universe, halfWidth: 16, halfDepth: 6 } }));
    expect(distanceOf(deep)).toBeLessThan(distanceOf(wide));
  });

  it('zooms by moving closer and stops at its limits', () => {
    const base = distanceOf(rigPose(spec()));
    expect(distanceOf(rigPose(spec({ frame: { x: 0, y: 0, scale: 2 } })))).toBeCloseTo(base / 2, 5);
    const beyond = rigPose(spec({ frame: { x: 0, y: 0, scale: 16 } }));
    const limit = rigPose(spec({ frame: { x: 0, y: 0, scale: ZOOM_LIMITS.universe.max } }));
    expect(beyond).toEqual(limit);
  });

  it('pans the target with the frame, within reach of the framed area', () => {
    const right = rigPose(spec({ frame: { x: 60, y: 0, scale: 1 } }));
    expect(right.target[0]).toBeGreaterThan(2);
    const far = rigPose(spec({ frame: { x: 1_000_000, y: 0, scale: 1 } }));
    expect(far.target[0]).toBeLessThanOrEqual(2 + 8);
  });

  it('is a pure function of its inputs and of time', () => {
    expect(rigPose(spec())).toEqual(rigPose(spec()));
    expect(withDrift(rigPose(spec()), 7.5)).toEqual(withDrift(rigPose(spec()), 7.5));
    expect(withDrift(rigPose(spec()), 7.5)).not.toEqual(withDrift(rigPose(spec()), 9));
  });

  it('flies from one pose to another and arrives exactly', () => {
    const from = rigPose(spec());
    const to = rigPose(spec({ focus: { kind: 'system', systemId: 's', center: { x: 9, z: 4 }, radius: 6 } }));
    expect(flyPose(from, to, 0, FLY_SECONDS.down).position).toEqual(from.position);
    expect(flyPose(from, to, FLY_SECONDS.down, FLY_SECONDS.down).position).toEqual(to.position);
    expect(flyPose(from, to, FLY_SECONDS.down / 2, FLY_SECONDS.down).fov).toBeGreaterThan(from.fov);
    expect(flyDone(FLY_SECONDS.down - 0.1, FLY_SECONDS.down)).toBe(false);
    expect(flyDone(FLY_SECONDS.down, FLY_SECONDS.down)).toBe(true);
  });
});
