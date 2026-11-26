import { buildSpace } from '../space/scene/build-scene';
import { projectAnchors } from '../space/space-anchors';
import { layOutUniverse } from '../space/space-model';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { indexUniverse } from '../universe-layout';
import type { VoyageControl } from './voyage-control';
import { createVoyageDriver } from './voyage-driver';
import { stationSize } from './station-look';

const size = { width: 390, height: 844 };

/**
 * How wide the room's station is drawn on a phone in the world the browser specs open (CI system 0 and a room beside
 * it), so the size rule is checked against a real layout and not only against its own numbers.
 */
function widthAt(stop: 'universe' | 'star'): number {
  const space = layOutUniverse({
    index: indexUniverse(sceneFixture(5, 0, 3, 2).descriptors, []),
    looks: new Map(),
    stations: [
      { room: { roomId: fixtureId(900), name: 'Room' }, standing: 'none', placement: { systemId: fixtureId(10) } },
    ] as never,
    dustCueIds: [],
    lately: false,
    lastPlaceId: undefined,
  });
  const built = buildSpace(space.definition, size.width / size.height, 1);
  const control: VoyageControl = {
    target: { stop, systemId: stop === 'star' ? fixtureId(10) : null, planetId: null, regionId: null },
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
  driver.attach(built);
  for (let frame = 1; frame <= 3; frame += 1) {
    built.setCamera(driver.pose(frame / 30, built, size));
    built.camera.updateMatrixWorld();
    built.poseAt(frame / 30);
  }
  return stationSize(projectAnchors(built, size, undefined).find((anchor) => anchor.kind === 'station')!.radiusPx);
}

describe('a station in the world the browser specs open', () => {
  it('is about the prototype’s 62 points across at its star', () => {
    expect(widthAt('star')).toBeGreaterThan(55);
    expect(widthAt('star')).toBeLessThan(70);
  });

  it('is no larger from the whole universe (a single system fills it, so only a little smaller here)', () => {
    expect(widthAt('universe')).toBeLessThanOrEqual(widthAt('star'));
    expect(widthAt('universe')).toBeGreaterThanOrEqual(18);
  });
});
