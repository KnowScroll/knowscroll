import * as THREE from 'three';
import { DETAIL_MAX } from './detail-set';
import type { RigFocus } from './camera-rig';
import { scaleDefinition } from './scene/scale-fixture';
import type { PaintCache } from './scene/context';
import type { SpaceDefinition } from './space-definition';
import { createSpaceRenderer } from './space-renderer';

// The real renderer, scene and camera rig; only the GPU is a stand-in that remembers the scene it was asked to draw.
const mockDrawn: { scene: THREE.Scene | undefined; renders: number } = { scene: undefined, renders: 0 };
jest.mock('three', () => {
  const actual = jest.requireActual<Record<string, unknown>>('three');
  class FakeWebGLRenderer {
    outputColorSpace = '';
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render(scene: THREE.Scene) {
      mockDrawn.scene = scene;
      mockDrawn.renders += 1;
    }
    getContext() {
      return {};
    }
    dispose() {}
    forceContextLoss() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const surface = { canvas: {}, width: 390, height: 844, pixelRatio: 1 };
const painted: PaintCache = new Map();
const universeAt = (x: number, z: number): RigFocus => ({
  kind: 'universe',
  center: { x, z },
  halfWidth: 30,
  halfDepth: 30,
});
const still = { x: 0, y: 0, scale: 1 };

function meshesDrawn(): number {
  let count = 0;
  mockDrawn.scene?.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) count += 1;
  });
  return count;
}
const farFieldVisible = (): boolean | undefined =>
  mockDrawn.scene?.children.find((child) => child.name === 'far-field')?.visible;

/** A map of 300 suns without planets: the level of detail is about which systems are built, not how long a planet takes to paint. */
const big = scaleDefinition(300, 0);

describe('the renderer of a map at scale', () => {
  beforeEach(() => {
    mockDrawn.scene = undefined;
    mockDrawn.renders = 0;
  });

  it('reports no detail for a map small enough to draw whole, and draws every system', () => {
    const onDetail = jest.fn<void, [readonly string[]]>();
    const renderer = createSpaceRenderer(surface, scaleDefinition(DETAIL_MAX, 0), { onDetail });
    renderer.setCamera({ focus: universeAt(0, 0), frame: still }, false);
    renderer.draw(0);
    renderer.draw(0.1);
    expect(onDetail).not.toHaveBeenCalled();
    expect(farFieldVisible()).toBeUndefined();
    expect(renderer.anchors().filter((anchor) => anchor.kind === 'system')).toHaveLength(DETAIL_MAX);
    renderer.dispose();
  });

  it('reports the systems it wants in full, at once, then only when that set changes', () => {
    const onDetail = jest.fn<void, [readonly string[]]>();
    const renderer = createSpaceRenderer(surface, big, { onDetail });
    expect(onDetail).toHaveBeenCalledTimes(1);
    const first = onDetail.mock.calls[0]![0];
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(DETAIL_MAX);
    renderer.setCamera({ focus: universeAt(0, 0), frame: still }, false);
    renderer.draw(0);
    renderer.draw(0.1);
    renderer.draw(0.2);
    const afterLooking = onDetail.mock.calls.length;
    renderer.draw(0.3);
    renderer.draw(0.4);
    // A camera that has settled reports nothing more.
    expect(onDetail.mock.calls.length).toBe(afterLooking);
    expect(farFieldVisible()).toBe(true);
    renderer.dispose();
  });

  it('follows the camera: a pan to another part of the map wants the systems there, and lets go of the ones behind', () => {
    const onDetail = jest.fn<void, [readonly string[]]>();
    const renderer = createSpaceRenderer(surface, big, { onDetail, buildsPerFrame: Infinity });
    renderer.setCamera({ focus: universeAt(0, 0), frame: still }, false);
    renderer.draw(0);
    renderer.draw(0.1);
    const here = onDetail.mock.calls.at(-1)![0];
    const meshesHere = meshesDrawn();
    // The far corner of the map.
    renderer.setCamera({ focus: universeAt(-60, -60), frame: { x: 0, y: 0, scale: 1 } }, false);
    renderer.draw(0.2);
    renderer.draw(0.3);
    const there = onDetail.mock.calls.at(-1)![0];
    expect(there).not.toEqual(here);
    expect(there.length).toBeLessThanOrEqual(DETAIL_MAX);
    // The same number of suns, not the sum of both places: the first were taken out.
    expect(meshesDrawn()).toBeLessThanOrEqual(meshesHere + 6);
    renderer.dispose();
  });

  it('keeps the system in focus, the one glowing and the one a script is about in detail wherever the camera is', () => {
    const onDetail = jest.fn<void, [readonly string[]]>();
    const renderer = createSpaceRenderer(surface, big, { onDetail, buildsPerFrame: Infinity });
    const far = big.systems.at(-1)!.id;
    renderer.setCamera({ focus: universeAt(0, 0), frame: still }, false);
    renderer.setHighlight(far);
    renderer.draw(0);
    renderer.draw(0.1);
    expect(onDetail.mock.calls.at(-1)![0]).toContain(far);
    const scripted = big.systems.at(-2)!.id;
    renderer.setHighlight(null);
    renderer.setScript({ kind: 'enter-system', systemId: scripted, clock: () => 0 });
    renderer.draw(0.2);
    renderer.draw(0.3);
    expect(onDetail.mock.calls.at(-1)![0]).toContain(scripted);
    expect(onDetail.mock.calls.at(-1)![0]).not.toContain(far);
    renderer.setScript(null);
    const focused = big.systems[150]!.id;
    renderer.setCamera(
      { focus: { kind: 'system', systemId: focused, center: { x: 0, z: 0 }, radius: 4 }, frame: still },
      false,
    );
    renderer.draw(0.4);
    renderer.draw(0.5);
    expect(onDetail.mock.calls.at(-1)![0]).toContain(focused);
    renderer.dispose();
  });

  it('builds a few systems a frame, and a still frame all of them at once', () => {
    const slow = createSpaceRenderer(surface, big, { buildsPerFrame: 1 });
    slow.setCamera({ focus: universeAt(-60, -60), frame: still }, false);
    slow.draw(0);
    slow.draw(0.1);
    const slowStart = meshesDrawn();
    slow.draw(0.2);
    expect(meshesDrawn()).toBeGreaterThanOrEqual(slowStart);
    expect(slowStart).toBeGreaterThan(0);
    for (let frame = 0; frame < 40; frame++) slow.draw(0.3 + frame * 0.1);
    const settled = meshesDrawn();
    // One a frame had not finished after two frames, and a still frame has.
    expect(slowStart).toBeLessThan(settled);
    slow.dispose();
    const still24 = createSpaceRenderer(surface, big, { buildsPerFrame: Infinity });
    still24.setCamera({ focus: universeAt(-60, -60), frame: still }, false);
    still24.draw(0);
    still24.draw(0);
    expect(meshesDrawn()).toBe(settled);
    still24.dispose();
  });

  it('changes a system without building the scene again, and releases much less than a rebuild would', () => {
    const renderer = createSpaceRenderer(surface, big, {});
    renderer.setCamera({ focus: universeAt(0, 0), frame: still }, false);
    renderer.draw(0);
    renderer.draw(0.1);
    const disposed = jest.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    try {
      const anchor = renderer.anchors().find((candidate) => candidate.kind === 'system' && candidate.radiusPx !== 10);
      expect(anchor).toBeDefined();
      const next: SpaceDefinition = {
        ...big,
        systems: big.systems.map((system) =>
          system.id === anchor!.id
            ? {
                ...system,
                planets: [{ id: `${system.id}-x`, name: 'New', type: 'gas', orbitRadius: 2, startAngle: 0 }],
              }
            : system,
        ),
      };
      painted.clear();
      renderer.setDefinition(next);
      // One system's sun and planet and the far field: nowhere near the whole scene.
      expect(disposed.mock.calls.length).toBeLessThan(25);
      renderer.draw(0.2);
      expect(renderer.anchors().some((candidate) => candidate.id === anchor!.id)).toBe(true);
    } finally {
      disposed.mockRestore();
    }
    renderer.dispose();
  });

  it('keeps what a screen can tap to the cap, and tells its tap targets apart from nothing at all', () => {
    const renderer = createSpaceRenderer(surface, scaleDefinition(5000, 0), {});
    renderer.setCamera(
      { focus: { kind: 'universe', center: { x: 0, z: 0 }, halfWidth: 340, halfDepth: 340 }, frame: still },
      false,
    );
    renderer.draw(0);
    renderer.draw(0.1);
    const anchors = renderer.anchors();
    expect(anchors.length).toBeLessThanOrEqual(160);
    expect(anchors.length).toBeGreaterThan(50);
    renderer.dispose();
  });
});
