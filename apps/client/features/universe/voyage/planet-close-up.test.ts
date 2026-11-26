import { buildGlobe, chartWorld } from '@knowscroll/scene-core';
import * as THREE from 'three';
import type * as GlobeModule from './globe';
import type * as ThreeModule from 'three';
import { paletteOf } from '../planet/planet-palette';
import { buildSpace, type BuiltSpace } from '../space/scene/build-scene';
import { SAMPLE_SPACE } from '../space/space-definition';
import type { VoyageTarget } from './ladder';
import { createPlanetCloseUp } from './planet-close-up';
import type { VoyageControl, VoyagePlanet } from './voyage-control';
import { groundPatchOf, labelPoints, type BandWindow, type WorldTexture } from './world-texture';

/** What the close-up asked of the globe, in order: only the texture and the patch matter here. */
const calls: { kind: string; texture?: WorldTexture | null; window?: BandWindow | null }[] = [];
jest.mock('./globe', () => {
  const actual = jest.requireActual<typeof GlobeModule>('./globe');
  return {
    ...actual,
    createGlobe: () => ({
      mesh: new (jest.requireActual<typeof ThreeModule>('three').Mesh)(),
      setTexture: (texture: WorldTexture | null) => calls.push({ kind: 'texture', texture }),
      setPatch: (texture: WorldTexture | null, window: BandWindow | null) =>
        calls.push({ kind: 'patch', texture, window }),
      setColours: () => undefined,
      setLight: () => undefined,
      setScreen: () => undefined,
      dispose: () => undefined,
    }),
  };
});

const size = { width: 390, height: 844 };
const sites = [0, 2, 3, 5, 8];
const world = buildGlobe({ seed: '1234567890abcdef1234567890abcdef', type: 'lush', variant: 0, siteCount: 12 });
const chart = chartWorld(
  world,
  sites.map((site) => ({ objectId: `region-${site}`, site })),
);
const planetOf = (key: string): VoyagePlanet => ({
  key,
  planetId: 'p',
  world,
  chart,
  palette: paletteOf('lush', 0),
  labels: labelPoints(chart),
  names: new Map(),
  landmarks: [],
});
const target = (stop: VoyageTarget['stop'], regionId: string | null = null): VoyageTarget => ({
  stop,
  systemId: 'sys',
  planetId: 'p',
  regionId,
});

function rig(initial: VoyageTarget) {
  const control: VoyageControl = {
    target: initial,
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: { kind: 'universe', center: { x: 0, z: 0 }, halfWidth: 1, halfDepth: 1 },
    systemFocus: () => undefined,
    lean: { x: 0, y: 0 },
    zoom: null,
    skips: 0,
  };
  const built = buildSpace(SAMPLE_SPACE, size.width / size.height, 1);
  const space: BuiltSpace = { ...built };
  const closeUp = createPlanetCloseUp(control);
  closeUp.attach(space);
  const position = new THREE.Vector3(0, 0, 0);
  const frame = (world: VoyagePlanet) =>
    closeUp.show(space, {
      t: 0,
      dt: 1 / 60,
      world,
      planet: { id: 'p', position, radius: 1 },
      sun: undefined,
      cameraPosition: new THREE.Vector3(0, 0, 3.95),
      focal: 1985,
      size,
    });
  /** The calls one frame made. */
  const run = (world: VoyagePlanet) => {
    const before = calls.length;
    frame(world);
    return calls.slice(before);
  };
  return { control, run };
}

beforeEach(() => {
  calls.length = 0;
  // A clock that never moves: a painter's 4 ms never run out, so each finishes in one frame and a test counts frames.
  jest.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => jest.restoreAllMocks());

describe('when the close-up paints the ground patch', () => {
  it('paints the quick texture, then the patch for the first region, then the sharper texture: one painter a frame', () => {
    const r = rig(target('ground'));
    const planet = planetOf('w1');
    const frames = [r.run(planet), r.run(planet), r.run(planet), r.run(planet)];
    // The first frame starts the planet over (clears texture and patch) and paints the quick texture.
    expect(frames[0]!.map((call) => call.kind)).toEqual(['texture', 'texture']);
    expect(frames[0]![0]!.texture).toBeNull();
    expect(frames[0]![1]!.texture).toMatchObject({ width: 1024, height: 512 });
    // Then the patch, before the 2048 texture.
    expect(frames[1]!.map((call) => call.kind)).toEqual(['patch']);
    const first = planet.labels[0]!;
    expect(frames[1]![0]!.window).toEqual(groundPatchOf(first, size).window);
    expect(frames[1]![0]!.texture).toMatchObject({
      width: groundPatchOf(first, size).width,
      height: groundPatchOf(first, size).height,
    });
    expect(frames[2]!.map((call) => call.kind)).toEqual(['texture']);
    expect(frames[2]![0]!.texture).toMatchObject({ width: 2048, height: 1024 });
    // And then there is nothing left to paint.
    expect(frames[3]).toEqual([]);
  });

  it('paints the patch from the planet stop on, so a fall finds it ready', () => {
    const r = rig(target('planet'));
    const planet = planetOf('w1');
    r.run(planet);
    expect(r.run(planet).map((call) => call.kind)).toEqual(['patch']);
  });

  it('does not paint a patch for a star or the universe', () => {
    for (const stop of ['star', 'universe'] as const) {
      calls.length = 0;
      const r = rig(target(stop));
      const planet = planetOf('w1');
      for (let frame = 0; frame < 4; frame++) r.run(planet);
      expect(
        calls.filter((call) => call.kind === 'patch' && call.texture !== null && call.texture !== undefined),
      ).toEqual([]);
      expect(calls.filter((call) => call.kind === 'texture' && call.texture)).toHaveLength(2);
    }
  });

  it('paints it again for the region the ground faces when that changes, and leaves the old one on until it is ready', () => {
    const r = rig(target('ground'));
    const planet = planetOf('w1');
    for (let frame = 0; frame < 4; frame++) r.run(planet);
    r.control.target = target('ground', 'region-5');
    const next = r.run(planet);
    expect(next.map((call) => call.kind)).toEqual(['patch']);
    const label = planet.labels.find((point) => point.objectId === 'region-5')!;
    expect(next[0]!.window).toEqual(groundPatchOf(label, size).window);
    expect(next[0]!.window).not.toEqual(groundPatchOf(planet.labels[0]!, size).window);
    // Nothing cleared it on the way: the one patch call is the new one.
    expect(next[0]!.texture).not.toBeNull();
    expect(r.run(planet)).toEqual([]);
  });

  it('drops the patch with the planet: a new world clears the texture and patch at once, and paints its own', () => {
    const r = rig(target('ground'));
    for (let frame = 0; frame < 4; frame++) r.run(planetOf('w1'));
    const changed = r.run(planetOf('w2'));
    expect(changed.slice(0, 2).map((call) => [call.kind, call.texture ?? null])).toEqual([
      ['patch', null],
      ['texture', null],
    ]);
    expect(changed[2]).toMatchObject({ kind: 'texture' });
    expect(changed[2]!.texture).toMatchObject({ width: 1024 });
    expect(r.run(planetOf('w2')).map((call) => call.kind)).toEqual(['patch']);
  });

  it('paints no patch under reduced motion, where a frame would hold for the whole of it: the ground keeps the sharper texture', () => {
    const r = rig(target('ground'));
    r.control.reducedMotion = true;
    const planet = planetOf('w1');
    const kinds = [r.run(planet), r.run(planet), r.run(planet)].flat().map((call) => call.kind);
    expect(kinds).not.toContain('patch');
    expect(kinds.filter((kind) => kind === 'texture').length).toBeGreaterThanOrEqual(3);
  });

  it('keeps each frame to one painter step within the budget when it is not reducing motion', () => {
    const r = rig(target('ground'));
    jest.restoreAllMocks();
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => (clock += 1));
    const planet = planetOf('w1');
    const stepped: number[] = [];
    for (let frame = 0; frame < 6; frame++) {
      const before = clock;
      r.run(planet);
      stepped.push(clock - before);
    }
    // The painter checks the clock a few times a task and stops at its 4 ms: no frame takes a second painter's turn.
    for (const used of stepped) expect(used).toBeLessThan(40);
    jest.restoreAllMocks();
  });
});
