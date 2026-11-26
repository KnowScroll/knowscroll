import { buildGlobe, chartWorld } from '@knowscroll/scene-core';
import * as THREE from 'three';
import { paletteOf } from '../planet/planet-palette';
import { buildSpace, type BuiltSpace } from '../space/scene/build-scene';
import { SAMPLE_SPACE, type SpaceDefinition } from '../space/space-definition';
import type { VoyageTarget } from './ladder';
import { chainOf, type ChainPlaces, type ViewSize } from './voyage-chains';
import type { VoyageControl, VoyageFrame, VoyagePlanet } from './voyage-control';
import { createVoyageDriver } from './voyage-driver';
import { labelPoints } from './world-texture';

const size = { width: 390, height: 844 };
const base = SAMPLE_SPACE.systems[0]!;
const second = {
  ...base,
  id: 'second-system',
  position: { x: 14, z: -9 },
  planets: base.planets.map((planet) => ({ ...planet, id: `second-${planet.id}` })),
};
const definition: SpaceDefinition = { ...SAMPLE_SPACE, systems: [base, second] };
const PLANET = 'sample-planet-one';

const sites = [0, 2, 3, 5, 8];
const world = buildGlobe({ seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 12 });
const chart = chartWorld(
  world,
  sites.map((site) => ({ objectId: `region-${site}`, site })),
);
const voyagePlanet: VoyagePlanet = {
  key: 'p1',
  planetId: PLANET,
  world,
  chart,
  palette: paletteOf('lush', 0),
  labels: labelPoints(chart),
  names: new Map(sites.map((site) => [`region-${site}`, `Region ${site}`])),
};

const target = (stop: VoyageTarget['stop'], systemId: string | null, planetId: string | null = null): VoyageTarget => ({
  stop,
  systemId,
  planetId,
  regionId: null,
});

/** A driver over a real scene, stepped frame by frame at 30 a second. */
function rig(initial: VoyageTarget) {
  const built = buildSpace(definition, size.width / size.height, 1);
  const showOnly: (string | null)[] = [];
  const space: BuiltSpace = {
    ...built,
    showOnly: (id) => {
      showOnly.push(id);
      built.showOnly(id);
    },
  };
  const frames: VoyageFrame[] = [];
  const control: VoyageControl = {
    target: initial,
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: { kind: 'universe', center: { x: 7, z: -4.5 }, halfWidth: 16, halfDepth: 12 },
    systemFocus: (id) => {
      const system = definition.systems.find((candidate) => candidate.id === id);
      return system && { kind: 'system', systemId: id, center: system.position, radius: 7.5 };
    },
    lean: { x: 0, y: 0 },
    zoom: null,
    skips: 0,
    afterFrame: (frame) => {
      frames.push(frame);
      return null;
    },
  };
  const places: ChainPlaces = {
    ...control,
    planetAt: (id) => {
      const body = built.script.planet(id);
      return body && { position: body.object.getWorldPosition(new THREE.Vector3()).toArray(), radius: body.radius };
    },
  };
  const compileAsync = jest.fn(() => Promise.resolve());
  const renderer = {
    autoClear: true,
    info: { programs: [] },
    clearDepth() {},
    render() {},
    compileAsync,
  } as unknown as THREE.WebGLRenderer;
  const driver = createVoyageDriver(control);
  driver.attach(space);
  let t = 0;
  let distance = 0;
  const step = () => {
    t += 1 / 30;
    const pose = driver.pose(t, space, size);
    built.setCamera(pose);
    built.camera.updateMatrixWorld();
    driver.render(renderer, size);
    const [p, a] = [pose.position, pose.target];
    distance = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    return distance;
  };
  /** Steps until the flight is over (at most `limit` seconds), returning every frame's distance. */
  const settle = (limit = 12) => {
    const distances: number[] = [];
    for (let i = 0; i < limit * 30; i += 1) {
      distances.push(step());
      if (!frames[frames.length - 1]!.flying) break;
    }
    return distances;
  };
  return {
    built,
    space,
    control,
    driver,
    frames,
    showOnly,
    renderer,
    compileAsync,
    step,
    settle,
    stopDistance: (to: VoyageTarget, view: ViewSize = size) => chainOf(to, places, view).stopDistance,
    last: () => frames[frames.length - 1]!,
    bodyVisible: (id: string) => built.script.planet(id)?.object.visible,
  };
}

beforeEach(() => {
  let clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => (clock += 0.05));
});
afterEach(() => jest.restoreAllMocks());

describe('the voyage driver camera', () => {
  it('cuts straight to the stop of the first target, with no flight', () => {
    const r = rig(target('star', base.id));
    expect(r.step()).toBeCloseTo(r.stopDistance(target('star', base.id)));
    expect(r.last().flying).toBe(false);
  });

  it('flies to a new target, reporting the flight, and rests at the stop of that target', () => {
    const r = rig(target('universe', null));
    r.step();
    r.control.target = target('star', base.id);
    r.step();
    expect(r.last().flying).toBe(true);
    const distances = r.settle();
    expect(distances.length).toBeGreaterThan(10);
    expect(r.last().flying).toBe(false);
    expect(r.step()).toBeCloseTo(r.stopDistance(target('star', base.id)));
  });

  it('ends the flight under way when the person skips it: the next frame is at rest at the stop', () => {
    const r = rig(target('universe', null));
    r.step();
    r.control.target = target('star', base.id);
    r.step();
    r.step();
    expect(r.last().flying).toBe(true);
    r.control.skips += 1;
    expect(r.step()).toBeCloseTo(r.stopDistance(target('star', base.id)));
    expect(r.last().flying).toBe(false);
  });

  it('cuts at once to a new target under reduced motion', () => {
    const r = rig(target('universe', null));
    r.step();
    r.control.reducedMotion = true;
    r.control.target = target('star', base.id);
    expect(r.step()).toBeCloseTo(r.stopDistance(target('star', base.id)));
    expect(r.last().flying).toBe(false);
  });

  it('climbs on a flight between two stars, higher than either end', () => {
    const r = rig(target('star', base.id));
    r.step();
    r.control.target = target('star', second.id);
    const distances = [r.step(), ...r.settle()];
    expect(Math.max(...distances)).toBeGreaterThan(r.stopDistance(target('star', base.id)));
    expect(Math.max(...distances)).toBeGreaterThan(r.stopDistance(target('star', second.id)));
  });
});

describe('the room a planet’s globe is given', () => {
  const planetStop = target('planet', base.id, PLANET);
  const room = { top: 60, bottom: 260 };

  it('lands on the stop as the room has made it, even when the room arrives after the flight has left', () => {
    const r = rig(target('star', base.id));
    r.step();
    r.control.target = planetStop;
    r.step();
    expect(r.last().flying).toBe(true);
    // The caption is measured once the view has changed: the room comes a few frames into the flight.
    r.step();
    r.control.room = room;
    const distances = r.settle();
    const fitted = r.stopDistance(planetStop, { ...size, room });
    expect(fitted).not.toBeCloseTo(r.stopDistance(planetStop));
    const lastInFlight = distances[distances.length - 1]!;
    // No jump from the last frame of the flight to the first at rest.
    expect(r.step()).toBeCloseTo(fitted);
    expect(lastInFlight).toBeCloseTo(fitted, 0);
  });

  it('holds the planet nearer the middle of the room than the usual place, and farther away when the room is small', () => {
    const r = rig(planetStop);
    r.control.planet = voyagePlanet;
    const usual = r.step();
    r.control.room = room;
    const fitted = r.step();
    expect(fitted).toBeGreaterThan(usual);
    expect(fitted).toBeCloseTo(r.stopDistance(planetStop, { ...size, room }));
  });
});

describe('a pinch', () => {
  it('moves the camera with the fingers, toward the place under them, and eases back when let go short of a stop', () => {
    const r = rig(target('universe', null));
    r.step();
    const atRest = r.step();
    const restAim = r.driver.pose(0, r.space, size).target;
    r.control.zoom = { scale: 0.6, toward: second.id };
    const pinched = r.step();
    expect(pinched).toBeCloseTo(atRest * 0.6);
    // Pinched past the step (1 / 1.4), the camera aims at the second star, not at the middle of the universe.
    const starAim = chainOf(target('star', second.id), { ...r.control, planetAt: () => undefined }, size).chain[0]!
      .point;
    const aim = r.driver.pose(0, r.space, size).target;
    expect(Math.hypot(aim[0] - starAim[0], aim[2] - starAim[2])).toBeLessThan(
      Math.hypot(restAim[0] - starAim[0], restAim[2] - starAim[2]) / 4,
    );
    r.control.zoom = null;
    const first = r.step();
    r.step();
    const third = r.step();
    expect(first).toBeGreaterThan(pinched);
    expect(third).toBeGreaterThan(first);
    for (let i = 0; i < 90; i += 1) r.step();
    expect(r.step()).toBeCloseTo(atRest, 1);
    expect(r.last().flying).toBe(false);
  });

  it('hands the flight it asks for the distance it left the camera at, and that flight is quicker', () => {
    // The screen lets go of the pinch in the same moment it changes place, as the controller does.
    const pinchedRig = rig(target('universe', null));
    pinchedRig.step();
    pinchedRig.control.zoom = { scale: 0.6, toward: second.id };
    const pinched = pinchedRig.step();
    pinchedRig.control.target = target('star', second.id);
    pinchedRig.control.zoom = null;
    const first = pinchedRig.step();
    expect(Math.abs(first - pinched) / pinched).toBeLessThan(0.1);
    const quick = pinchedRig.settle().length;

    // The same flight from about the same place, asked for a moment after the pinch let go: an ordinary one.
    const plainRig = rig(target('universe', null));
    plainRig.step();
    plainRig.control.zoom = { scale: 0.6, toward: second.id };
    plainRig.step();
    plainRig.control.zoom = null;
    plainRig.step();
    plainRig.step();
    plainRig.control.target = target('star', second.id);
    const ordinary = plainRig.settle().length;
    expect(quick).toBeLessThan(ordinary * 0.8);
  });

  it('keeps a star alone however far the fingers pinch out from it, so a shaking finger never flickers the sky', () => {
    const r = rig(target('star', base.id));
    r.step();
    for (const scale of [1.25, 1.35, 1.28, 1.36, 2, 2.9, 1.1]) {
      r.control.zoom = { scale, toward: null };
      r.step();
    }
    r.control.zoom = null;
    for (let i = 0; i < 30; i += 1) r.step();
    expect(new Set(r.showOnly)).toEqual(new Set([base.id]));
  });

  it('hurries a flight under way while two fingers hold the camera, then eases to where they are with no jump', () => {
    const plain = rig(target('universe', null));
    plain.step();
    plain.control.target = target('star', base.id);
    const ordinary = plain.settle().length;

    const r = rig(target('universe', null));
    r.step();
    r.control.target = target('star', base.id);
    r.step();
    r.step();
    // Two fingers come down mid-flight and close: they ask for the camera 1.3 times farther out than the stop.
    r.control.zoom = { scale: 1.3, toward: null };
    const flown = r.settle();
    expect(flown.length + 2).toBeLessThan(ordinary * 0.6);
    const stop = r.stopDistance(target('star', base.id));
    expect(flown[flown.length - 1]).toBeCloseTo(stop, 1);
    // Landed: the camera goes out to the fingers over a few frames, never in one.
    let previous = flown[flown.length - 1]!;
    for (let i = 0; i < 20; i += 1) {
      const now = r.step();
      expect(Math.abs(now - previous) / previous).toBeLessThan(0.1);
      previous = now;
    }
    expect(previous).toBeCloseTo(stop * 1.3, 0);
  });

  it('never takes the camera inside a planet', () => {
    const r = rig(target('ground', base.id, PLANET));
    r.control.zoom = { scale: 0.05, toward: null };
    r.step();
    const body = r.built.script.planet(PLANET)!;
    const centre = body.object.getWorldPosition(new THREE.Vector3());
    const pose = r.driver.pose(r.frames.length / 30 + 1 / 30, r.space, size);
    expect(new THREE.Vector3(...pose.position).distanceTo(centre)).toBeGreaterThan(body.radius);
  });
});

describe('the globe of a planet', () => {
  it('takes over near the planet, then gives the painted planet back when the camera leaves', () => {
    const r = rig(target('star', base.id));
    r.step();
    expect(r.driver.anchors(r.space, size)).toEqual([]);
    r.control.target = target('planet', base.id, PLANET);
    r.control.planet = voyagePlanet;
    r.control.siblings = ['sample-planet-one', 'sample-planet-two'];
    r.settle();
    r.step();
    const anchors = r.driver.anchors(r.space, size);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.every((anchor) => anchor.kind === 'region')).toBe(true);
    expect(r.bodyVisible(PLANET)).toBe(false);
    expect(r.last().globe).not.toBeNull();

    r.control.target = target('universe', null);
    r.control.planet = null;
    r.settle();
    r.step();
    expect(r.bodyVisible(PLANET)).toBe(true);
    expect(r.driver.anchors(r.space, size)).toEqual([]);
  });
});

describe('what the scene shows', () => {
  it('shows only the star at a star and every system at the universe', () => {
    const r = rig(target('star', base.id));
    r.step();
    expect(r.showOnly[r.showOnly.length - 1]).toBe(base.id);
    r.control.target = target('universe', null);
    r.settle();
    r.step();
    expect(r.showOnly[r.showOnly.length - 1]).toBeNull();
  });

  it('compiles the globe once for each scene it is attached to', () => {
    const r = rig(target('universe', null));
    r.step();
    expect(r.compileAsync).toHaveBeenCalledTimes(1);
    r.step();
    r.step();
    expect(r.compileAsync).toHaveBeenCalledTimes(1);
    const other = buildSpace(definition, size.width / size.height, 1);
    r.driver.attach(other);
    r.driver.render(r.renderer, size);
    expect(r.compileAsync).toHaveBeenCalledTimes(2);
  });
});
