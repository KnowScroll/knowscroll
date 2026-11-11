import * as THREE from 'three';
import type { RigFocus } from './camera-rig';
import { ANCHOR_CAP, fromMiddle, onScreen } from './detail-set';
import { buildSpace } from './scene/build-scene';
import type { PaintCache } from './scene/context';
import { scaleDefinition } from './scene/scale-fixture';
import { FAR_RADIUS_PX, projectAnchors, type AnchorScratch } from './space-anchors';
import type { SpaceAnchor } from './space-surface';

const size = { width: 390, height: 844 };
const painted: PaintCache = new Map();
const universe: RigFocus = { kind: 'universe', center: { x: 0, z: 0 }, halfWidth: 50, halfDepth: 50 };
const overview = { position: [0, 90, 120], target: [0, 0, 0], fov: 38 } as const;

/** What the renderer answered before the level of detail: every anchor, projected from its object. */
function everyAnchor(space: ReturnType<typeof buildSpace>): SpaceAnchor[] {
  space.camera.updateMatrixWorld();
  const point = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const right = new THREE.Vector3().setFromMatrixColumn(space.camera.matrixWorld, 0);
  return space.anchors.map(({ id, kind, name, caption, mapCaption, systemId, object, radius }) => {
    object.getWorldPosition(point);
    edge.copy(point).addScaledVector(right, radius);
    point.project(space.camera);
    edge.project(space.camera);
    const x = (point.x * 0.5 + 0.5) * size.width;
    const y = (-point.y * 0.5 + 0.5) * size.height;
    return {
      id,
      kind,
      name,
      ...(caption === undefined ? {} : { caption }),
      ...(mapCaption === undefined ? {} : { mapCaption }),
      systemId,
      x,
      y,
      radiusPx: Math.abs((edge.x * 0.5 + 0.5) * size.width - x),
      visible: point.z < 1 && object.visible,
    };
  });
}

describe('the anchors a frame hands the screen', () => {
  it('are every anchor of a map drawn whole, exactly as they always were', () => {
    const space = buildSpace(scaleDefinition(6, 2), size.width / size.height, 1, painted);
    space.setCamera({ position: [30, 25, 40], target: [0, 0, 0], fov: 38 });
    space.poseAt(1.5);
    expect(projectAnchors(space, size, universe)).toEqual(everyAnchor(space));
    // Even a system seen alone gives all of them: the overlay does its own filtering for a map drawn whole.
    const alone: RigFocus = { kind: 'system', systemId: 'sys-00001', center: { x: 0, z: 0 }, radius: 4 };
    expect(projectAnchors(space, size, alone)).toEqual(everyAnchor(space));
    space.dispose();
  });

  describe('of a map at scale', () => {
    const space = buildSpace(scaleDefinition(5000, 0), size.width / size.height, 1, painted);
    afterAll(() => space.dispose());
    space.setCamera({ position: [...overview.position], target: [...overview.target], fov: overview.fov });
    space.poseAt(0);

    it('are no more than the cap, all of them on the screen or just beyond it', () => {
      const anchors = projectAnchors(space, size, universe);
      expect(anchors.length).toBeLessThanOrEqual(ANCHOR_CAP);
      expect(anchors.length).toBeGreaterThan(20);
      for (const anchor of anchors) {
        expect(onScreen({ x: (anchor.x / size.width) * 2 - 1, y: 1 - (anchor.y / size.height) * 2 })).toBe(true);
        expect(anchor.kind).toBe('system');
      }
    });

    it('name systems drawn as points as well as the ones drawn in full, nearest the middle of the screen first', () => {
      const anchors = projectAnchors(space, size, universe);
      const asPoints = anchors.filter((anchor) => !space.detail.has(anchor.id));
      expect(asPoints.length).toBeGreaterThan(0);
      for (const anchor of asPoints) expect(anchor.radiusPx).toBe(FAR_RADIUS_PX);
      // None of the systems left out is nearer the middle of the screen than the farthest one kept.
      const kept = new Set(anchors.map((anchor) => anchor.id));
      const middle = (anchor: SpaceAnchor) =>
        fromMiddle({ x: (anchor.x / size.width) * 2 - 1, y: 1 - (anchor.y / size.height) * 2 });
      const farthestKept = Math.max(...asPoints.map(middle));
      const point = new THREE.Vector3();
      const { ids, x, z } = space.places;
      let nearerLeftOut = 0;
      for (let at = 0; at < ids.length; at++) {
        if (kept.has(ids[at]!) || space.detail.has(ids[at]!)) continue;
        point.set(x[at]!, 0, z[at]).project(space.camera);
        if (point.z < 1 && onScreen(point) && fromMiddle(point) < farthestKept - 1e-4) nearerLeftOut += 1;
      }
      expect(nearerLeftOut).toBe(0);
    });

    it('keep the scene’s own order, so keyboard focus does not jump as the camera moves', () => {
      const first = projectAnchors(space, size, universe).map((anchor) => anchor.id);
      space.setCamera({ position: [3, 90, 123], target: [3, 0, 3], fov: 38 });
      const second = projectAnchors(space, size, universe).map((anchor) => anchor.id);
      const common = first.filter((id) => second.includes(id));
      expect(common.length).toBeGreaterThan(10);
      const places = space.places.ids;
      const points = second.filter((id) => !space.detail.has(id));
      expect(points.map((id) => places.indexOf(id))).toEqual(
        [...points.map((id) => places.indexOf(id))].sort((a, b) => a - b),
      );
      space.setCamera({ position: [...overview.position], target: [...overview.target], fov: overview.fov });
    });

    it('leave out the planets of a whole map, and all but the system in view when one is', () => {
      const detailed = [...space.detail][0]!;
      const alone: RigFocus = { kind: 'system', systemId: detailed, center: { x: 0, z: 0 }, radius: 4 };
      const inSystem = projectAnchors(space, size, alone);
      expect(inSystem.every((anchor) => anchor.systemId === detailed || anchor.kind === 'dust')).toBe(true);
      // No far systems are projected while a system is in view.
      expect(inSystem.length).toBeLessThanOrEqual(2);
    });

    it('drop what is behind the camera and beyond the margin', () => {
      space.setCamera({ position: [4000, 5, 4000], target: [4000, 5, 3999], fov: 38 });
      expect(projectAnchors(space, size, universe)).toEqual([]);
      space.setCamera({ position: [...overview.position], target: [...overview.target], fov: overview.fov });
    });

    it('allocate nothing per system: the buffers are the ones used the frame before', () => {
      const scratch: AnchorScratch = {};
      projectAnchors(space, size, universe, scratch);
      const buffers = [scratch.from, scratch.x, scratch.y, scratch.pool];
      projectAnchors(space, size, universe, scratch);
      expect([scratch.from, scratch.x, scratch.y, scratch.pool]).toEqual(buffers);
      expect(scratch.from).toBeInstanceOf(Float32Array);
      expect(scratch.from!.length).toBe(5000);
    });

    it('take a few milliseconds a frame for five thousand systems', () => {
      const scratch: AnchorScratch = {};
      projectAnchors(space, size, universe, scratch);
      const started = performance.now();
      for (let frame = 0; frame < 30; frame++) projectAnchors(space, size, universe, scratch);
      const perFrame = (performance.now() - started) / 30;
      expect(perFrame).toBeLessThan(20);
    });
  });
});
