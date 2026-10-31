/**
 * CI-only stand-ins for the GPU side of a space view, so a screen test can run the real stage, loop and
 * overlay without WebGL: a canvas host that reports a surface, and a renderer that "projects" the
 * definition's bodies onto a grid. No pixels are claimed; the browser and the emulator prove those
 * (`e2e/space-gallery.spec.ts`, `maestro/space.yaml`). Never imported by a production route.
 */
import { useEffect } from 'react';
import { stationSkyLine } from '@knowscroll/client-core';
import type { SpaceCanvasProps } from './space-canvas-props';
import type { SpaceCameraSpec, SpaceRenderer } from './space-renderer';
import type { SpaceDefinition } from './space-definition';
import type { SpaceAnchor } from './space-surface';

interface FakeGpuControls {
  /** The renderers made so far, newest last. */
  readonly renderers: FakeRenderer[];
  /** Whether the renderers report the Far level. */
  far: boolean;
  /** Makes the next renderer creation throw, as a device without WebGL does. */
  failToCreate: boolean;
  /** Makes every frame throw, as a driver that fails mid-draw does. */
  failToDraw: boolean;
  /** Tells the host the context was lost, as a browser does when it takes the GPU back. */
  readonly loseContext: () => void;
}

export interface FakeRenderer extends SpaceRenderer {
  readonly draws: number[];
  readonly cameras: { spec: SpaceCameraSpec; animate: boolean }[];
  definition: SpaceDefinition;
  highlighted: string | null;
}

export interface FakeGpu extends FakeGpuControls {
  readonly Canvas: (props: SpaceCanvasProps) => null;
  readonly load: () => Promise<{
    createSpaceRenderer: (surface: unknown, definition: SpaceDefinition) => SpaceRenderer;
  }>;
}

export function createFakeGpu(): FakeGpu {
  let reportFailure: SpaceCanvasProps['onFailure'] | undefined;
  const gpu: FakeGpu = {
    renderers: [],
    far: false,
    failToCreate: false,
    failToDraw: false,
    loseContext: () => reportFailure?.('context-lost'),
    Canvas(props) {
      useEffect(() => {
        reportFailure = props.onFailure;
        props.onSurface({ canvas: {}, width: 390, height: 640, pixelRatio: 1 });
        // The host reports once per mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- a test double
      }, []);
      return null;
    },
    load: () =>
      Promise.resolve({
        createSpaceRenderer: (_surface: unknown, definition: SpaceDefinition) => {
          if (gpu.failToCreate) throw new Error('Error creating WebGL context.');
          const created = makeRenderer(
            definition,
            () => gpu.far,
            () => gpu.failToDraw,
          );
          gpu.renderers.push(created);
          return created;
        },
      }),
  };
  return gpu;
}

function makeRenderer(definition: SpaceDefinition, far: () => boolean, failing: () => boolean): FakeRenderer {
  const renderer: FakeRenderer = {
    draws: [],
    cameras: [],
    definition,
    highlighted: null,
    draw: (t) => {
      if (failing()) throw new Error('A frame failed.');
      renderer.draws.push(t);
    },
    resize: () => undefined,
    setDefinition: (next) => void (renderer.definition = next),
    setCamera: (spec, animate) => void renderer.cameras.push({ spec, animate }),
    setHighlight: (id) => void (renderer.highlighted = id),
    isFar: far,
    probe: () => ({ litPixels: 1, sampledPixels: 2, signature: 3 }),
    dispose: () => undefined,
    anchors: () => anchorsOf(renderer),
  };
  return renderer;
}

/** Lays the bodies of the definition on a grid, hiding what a System view would not show. */
function anchorsOf(renderer: FakeRenderer): SpaceAnchor[] {
  const focus = renderer.cameras.at(-1)?.spec.focus;
  const only = focus?.kind === 'system' ? focus.systemId : null;
  const shown = (systemId: string | null): boolean => only === null || systemId === only;
  const anchors: SpaceAnchor[] = [];
  let slot = 0;
  const place = (anchor: Omit<SpaceAnchor, 'x' | 'y' | 'radiusPx' | 'visible'>): void => {
    anchors.push({
      ...anchor,
      x: 70 + (slot % 3) * 110,
      y: 200 + Math.floor(slot / 3) * 100,
      radiusPx: 12,
      visible: shown(anchor.systemId),
    });
    slot += 1;
  };
  for (const system of renderer.definition.systems) {
    place({ id: system.id, kind: 'system', name: system.name, systemId: system.id });
    for (const planet of system.planets)
      place({ id: planet.id, kind: 'planet', name: planet.name, systemId: system.id });
  }
  for (const station of renderer.definition.stations ?? [])
    place({
      id: station.id,
      kind: 'station',
      name: station.name,
      ...(station.sky === undefined ? {} : { caption: stationSkyLine(station.sky) }),
      systemId: station.systemId,
    });
  for (const dust of renderer.definition.dust ?? []) place({ id: dust.id, kind: 'dust', name: '', systemId: null });
  return anchors;
}

/** The one stand-in a test file wires in with `jest.mock`; call {@link resetFakeGpu} in `beforeEach`. */
export const fakeGpu = createFakeGpu();
export function resetFakeGpu(): void {
  fakeGpu.renderers.length = 0;
  fakeGpu.far = false;
  fakeGpu.failToCreate = false;
  fakeGpu.failToDraw = false;
}
