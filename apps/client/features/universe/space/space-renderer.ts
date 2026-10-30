import * as THREE from 'three';
import { buildSpace } from './scene/build-scene';
import type { SpaceDefinition } from './space-definition';
import type { SpaceAnchor, SpaceProbe, SpaceSurface } from './space-surface';

/** The drawing of one space view on one surface. */
export interface SpaceRenderer {
  /** Poses the scene at `t`, draws it and presents it. */
  draw(t: number): void;
  /** Layout size changed (a rotation or a window resize). */
  resize(width: number, height: number): void;
  /** The named points of the scene in layout pixels, for the labels drawn over the canvas. */
  anchors(): SpaceAnchor[];
  /** Reads a coarse sample of the last frame. Call right after `draw`, before the next frame. */
  probe(): SpaceProbe;
  /**
   * Releases the GPU resources. The surface itself belongs to its host. `releaseContext` also asks
   * the browser to free the WebGL context at once (the view is going away for good); it is ignored
   * on native, where the `GLView` owns its context.
   */
  dispose(options?: { releaseContext?: boolean }): void;
}

const SKY_CLEAR = 0x020308;
/** Rows of the frame (as a share of its height from the top) that {@link SpaceRenderer.probe} reads. */
const PROBE_ROWS = [0.25, 0.4, 0.55] as const;
/** A sampled pixel counts as lit when its red, green and blue add up to more than this. */
const LIT_THRESHOLD = 60;

/**
 * Creates the three.js renderer for `surface` and builds the scene on it. Throws when the surface
 * cannot give three.js a WebGL 2 context; the caller turns that into the Simple lists.
 */
export function createSpaceRenderer(surface: SpaceSurface, definition: SpaceDefinition): SpaceRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: surface.canvas as HTMLCanvasElement,
    context: surface.context,
    antialias: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: surface.preserveDrawingBuffer === true,
  });
  renderer.setPixelRatio(surface.pixelRatio);
  renderer.setSize(surface.width, surface.height, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(SKY_CLEAR);
  const space = buildSpace(definition, surface.width / surface.height, surface.pixelRatio);
  let size = { width: surface.width, height: surface.height };

  return {
    draw(t) {
      space.poseAt(t);
      renderer.render(space.scene, space.camera);
      surface.present?.();
    },
    resize(width, height) {
      size = { width, height };
      renderer.setSize(width, height, false);
      space.camera.aspect = width / height;
      space.camera.updateProjectionMatrix();
    },
    anchors() {
      space.camera.updateMatrixWorld();
      const point = new THREE.Vector3();
      return space.anchors.map(({ id, kind, name, object }) => {
        object.getWorldPosition(point).project(space.camera);
        return {
          id,
          kind,
          name,
          x: (point.x * 0.5 + 0.5) * size.width,
          y: (-point.y * 0.5 + 0.5) * size.height,
          visible: point.z < 1,
        };
      });
    },
    probe() {
      const gl = renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const row = new Uint8Array(width * 4);
      let lit = 0;
      let signature = 2166136261;
      for (const share of PROBE_ROWS) {
        gl.readPixels(0, Math.floor(height * (1 - share)), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        for (let at = 0; at < row.length; at += 4) {
          if (row[at]! + row[at + 1]! + row[at + 2]! > LIT_THRESHOLD) lit += 1;
          signature = Math.imul(signature ^ row[at]! ^ (row[at + 1]! << 8) ^ (row[at + 2]! << 16), 16777619) >>> 0;
        }
      }
      return { litPixels: lit, sampledPixels: width * PROBE_ROWS.length, signature };
    },
    dispose(options) {
      space.dispose();
      renderer.dispose();
      if (options?.releaseContext === true && surface.context === undefined) renderer.forceContextLoss();
    },
  };
}
