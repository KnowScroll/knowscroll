import { buildSceneGeometry } from '@knowscroll/scene-core';
import { boundedFrame, fitFrame, projectPoint, returnLocator } from './universe-camera';
import { fixtureId, sceneFixture } from './universe.fixture';
describe('Universe camera, authored CI geometry only', () => {
  it('uses finite bounded camera coordinates and exact canonical return metadata', () => {
    expect(boundedFrame({ x: Infinity, y: -20000, scale: NaN })).toEqual({ x: 0, y: -10000, scale: 1 });
    const frame = { x: 12.25, y: -83, scale: 0.75 };
    expect(returnLocator(fixtureId(10000), fixtureId(12), frame).frame).toEqual(frame);
    expect(projectPoint({ x: frame.x, y: frame.y }, frame)).toEqual({ x: 500, y: 300 });
  });
  it('fits authoritative anchors independently of sibling order, seed and activity', () => {
    const { descriptors } = sceneFixture();
    expect(fitFrame(descriptors)).toEqual(fitFrame([...descriptors].reverse()));
    const original = descriptors[0]!;
    const full = buildSceneGeometry(original, { detail: 'full', reducedMotion: false });
    const low = buildSceneGeometry(original, { detail: 'low', reducedMotion: true });
    expect(low.anchor).toEqual(full.anchor);
    expect(low.target).toEqual(full.target);
    expect(low.silhouette).toEqual(full.silhouette.filter((_, i) => i % 4 === 0));
    expect(low.motion).toBe('still');
  });
});
