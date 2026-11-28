import { buildSpace } from '../space/scene/build-scene';
import { SAMPLE_SPACE, type SpaceDefinition } from '../space/space-definition';
import { createStandApart } from './stand-apart-scene';

const size = { width: 390, height: 844 };
const pose = { position: [0, 16, 12], target: [0, 0, 0], fov: 38 } as const;
const system = SAMPLE_SPACE.systems[0]!;
/** A station built just past the sun, on the line from it to the camera. */
const scene: SpaceDefinition = {
  ...SAMPLE_SPACE,
  stations: [{ id: 'station-1', name: 'Station', systemId: system.id, position: { x: 0, y: 0.6, z: 2.4 } }],
};

/** How far the station stands from its sun in the scene once placed by a pass with this rule. */
function distanceFromSun(clears: 'sun' | 'group'): number {
  const space = buildSpace(scene, size.width / size.height, 1);
  space.poseAt(0);
  createStandApart(clears).apply(space, pose, size);
  const station = space.anchors.find((anchor) => anchor.kind === 'station')!;
  return station.object.position.distanceTo(space.script.sun(system.id)!);
}

describe('the scene part of standing apart', () => {
  it('puts the station farther out when it clears the whole group than when it clears only the sun', () => {
    const sunOnly = distanceFromSun('sun');
    expect(sunOnly).toBeGreaterThan(2.4);
    expect(distanceFromSun('group')).toBeGreaterThan(sunOnly);
  });

  it('leaves a station that is in open space where the scene built it', () => {
    const space = buildSpace(
      { ...scene, stations: [{ ...scene.stations![0]!, position: { x: 30, y: 0.6, z: 0 } }] },
      size.width / size.height,
      1,
    );
    space.poseAt(0);
    createStandApart('sun').apply(space, pose, size);
    expect(space.anchors.find((anchor) => anchor.kind === 'station')!.object.position.toArray()).toEqual([30, 0.6, 0]);
  });
});
