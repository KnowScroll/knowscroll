import type { RoomStation } from '@knowscroll/contracts';
import type { SceneDescriptor } from '@knowscroll/scene-core';
import { buildSpace } from '../space/scene/build-scene';
import { layOutUniverse } from '../space/space-model';
import { projectAnchors } from '../space/space-anchors';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { stationSize } from './station-look';
import { indexUniverse } from '../universe-layout';
import type { VoyageTarget } from './ladder';
import type { VoyageControl } from './voyage-control';
import { createVoyageDriver } from './voyage-driver';

const size = { width: 390, height: 844 };

function descriptor(n: number, kind: SceneDescriptor['kind'], parentId: string, x: number, y: number): SceneDescriptor {
  const base = sceneFixture(5).descriptors[0]!;
  return {
    ...base,
    objectId: fixtureId(n),
    parentId,
    kind,
    label: `CI ${kind} ${n}`,
    anchor: { x, y, layer: 0 },
    seed: n.toString(16).padStart(32, '0'),
  };
}

/** A system with `planets` planets, standing at (x, y) of the lattice. */
const systemWith = (id: number, planets: number, x: number, y: number): SceneDescriptor[] => [
  descriptor(id, 'system', fixtureId(1), x, y),
  descriptor(id + 1, 'star', fixtureId(id), x, y),
  ...Array.from({ length: planets }, (_, at) =>
    descriptor(id + 2 + at, 'planet', fixtureId(id), x + 150 * (at + 1), y + 150 * ((at % 2) * 2 - 1)),
  ),
];

const station = (n: number, systemId: string): RoomStation =>
  ({
    room: { roomId: fixtureId(n), name: `Room ${n}` },
    standing: 'member',
    placement: { systemId },
  }) as unknown as RoomStation;

/** A universe of three systems, the first with `planets` planets, each with a room's station beside it. */
function universe(planets: number) {
  const descriptors = [
    ...systemWith(100, planets, -400, -150),
    ...systemWith(200, 2, 300, 200),
    ...systemWith(300, 4, 100, -450),
  ];
  return layOutUniverse({
    index: indexUniverse(descriptors, []),
    looks: new Map(),
    stations: [station(900, fixtureId(100)), station(901, fixtureId(200)), station(902, fixtureId(300))],
    dustCueIds: [],
    lately: false,
    lastPlaceId: undefined,
  });
}

/** The scene of `universe(planets)`, with the trial's camera driver over it unless `voyage` is false, posed at `stop`. */
function scene(planets: number, stop: VoyageTarget['stop'], voyage = true) {
  const space = universe(planets);
  const built = buildSpace(space.definition, size.width / size.height, 1);
  const target: VoyageTarget =
    stop === 'universe'
      ? { stop: 'universe', systemId: null, planetId: null, regionId: null }
      : { stop: 'star', systemId: fixtureId(100), planetId: null, regionId: null };
  const control: VoyageControl = {
    target,
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: space.universeFocus,
    systemFocus: space.systemFocus,
    lean: { x: 0, y: 0 },
    zoom: null,
    skips: 0,
  };
  const driver = createVoyageDriver(control);
  if (voyage) driver.attach(built);
  for (let frame = 1; frame <= 3; frame += 1) {
    built.setCamera(driver.pose(frame / 30, built, size));
    built.camera.updateMatrixWorld();
    built.poseAt(frame / 30);
  }
  const stations = () => built.anchors.filter((anchor) => anchor.kind === 'station');
  const meshesDrawn = () => stations().map(({ object }) => object.children.every((child) => child.visible));
  const meshesHidden = () => stations().map(({ object }) => object.children.every((child) => !child.visible));
  return { space, built, stations, meshesDrawn, meshesHidden, anchors: () => projectAnchors(built, size, undefined) };
}

describe('the scene’s own stations', () => {
  it('are drawn by the old map: nothing calls showStations there', () => {
    const { stations, meshesDrawn } = scene(2, 'star', false);
    expect(stations()).toHaveLength(3);
    expect(meshesDrawn()).toEqual([true, true, true]);
  });

  it('are hidden once the trial’s driver is attached, while each station keeps its anchor, name and visibility', () => {
    const { stations, meshesHidden, anchors } = scene(2, 'star');
    expect(meshesHidden()).toEqual([true, true, true]);
    // A star's stop shows its own system alone, as ever: only its own station's group is in the scene.
    expect(stations().map(({ object }) => object.visible)).toEqual([true, false, false]);
    // The station of the star is reported on screen, so its button and its name stay.
    const own = anchors().find((anchor) => anchor.kind === 'station' && anchor.name === 'Room 900')!;
    expect(own.visible).toBe(true);
  });

  it('stay hidden in a system the scene builds again later', () => {
    const { built, space, meshesHidden } = scene(2, 'universe');
    built.update({
      ...space.definition,
      systems: space.definition.systems.map((system) => ({ ...system, name: `${system.name}!` })),
    });
    expect(meshesHidden()).toEqual([true, true, true]);
  });

  it('are drawn again when asked', () => {
    const { built, meshesDrawn } = scene(2, 'universe');
    built.showStations(true);
    expect(meshesDrawn()).toEqual([true, true, true]);
  });
});

describe('how big a station is drawn on a phone', () => {
  const widthAt = (planets: number, stop: VoyageTarget['stop']) => {
    const { anchors } = scene(planets, stop);
    return stationSize(anchors().find((anchor) => anchor.kind === 'station' && anchor.name === 'Room 900')!.radiusPx);
  };

  it('is about the prototype’s 62 points at a star, for a small system and a large one', () => {
    for (const planets of [1, 2, 4, 7]) {
      expect(widthAt(planets, 'star')).toBeGreaterThan(48);
      expect(widthAt(planets, 'star')).toBeLessThan(85);
    }
  });

  it('is smaller from the whole universe, and not under the prototype’s floor', () => {
    for (const planets of [1, 4, 7]) {
      expect(widthAt(planets, 'universe')).toBeLessThan(widthAt(planets, 'star'));
      expect(widthAt(planets, 'universe')).toBeGreaterThanOrEqual(18);
    }
  });
});
