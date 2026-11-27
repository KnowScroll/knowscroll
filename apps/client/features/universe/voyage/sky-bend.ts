/**
 * The look of gravity, drawn: the background stars bend round the bodies in front of them (`sky-lens.ts` says which
 * and how much). Each frame, after the camera is placed and before the scene is drawn, the stars and planets of the
 * scene are projected from the scene itself, so a lens sits on its body in the very frame it is drawn, flight or
 * lean, and a still frame under reduced motion is bent too. Radii ease from frame to frame (under reduced motion they
 * are set at once), so a body coming into view bends the sky in instead of snapping.
 */
import * as THREE from 'three';
import type { BuiltSpace } from '../space/scene/build-scene';
import { SKY_LENSES } from '../space/scene/shaders';
import type { BentSky } from '../space/scene/sky';
import type { Stop } from './ladder';
import { lensRadii, strongestLenses, type LensBody } from './sky-lens';

/** How fast a lens radius follows what its body wants, per second. */
const LENS_RATE = 7;
/** An eased radius this small is dropped. */
const LENS_GONE = 0.25;

/** What a frame of the bent sky needs. */
export interface SkyBendFrame {
  readonly stop: Stop;
  readonly size: { readonly width: number; readonly height: number };
  /** Seconds since the last frame. */
  readonly dt: number;
  readonly reducedMotion: boolean;
}

export interface SkyBend {
  /** Bends the sky of `space` from now on: links its program, so call it when the scene is attached. */
  attach(space: BuiltSpace): void;
  /** Sets this frame's lenses on the attached scene's stars. */
  draw(space: BuiltSpace, frame: SkyBendFrame): void;
}

/** True when `object` and every parent it hangs from are drawn. */
function drawn(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
}

export function createSkyBend(): SkyBend {
  let sky: BentSky | null = null;
  let bentFor: BuiltSpace | null = null;
  const eased = new Map<string, number>();
  const point = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const right = new THREE.Vector3();

  /** The stars and planets drawn on screen now, with their radius on screen. */
  const bodiesOf = (space: BuiltSpace, size: SkyBendFrame['size']): LensBody[] => {
    const camera = space.camera;
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    const bodies: LensBody[] = [];
    for (const anchor of space.anchors) {
      if ((anchor.kind !== 'system' && anchor.kind !== 'planet') || !drawn(anchor.object)) continue;
      anchor.object.getWorldPosition(point);
      edge.copy(point).addScaledVector(right, anchor.radius);
      point.project(camera);
      edge.project(camera);
      if (point.z >= 1 || Math.abs(point.x) > 1.4 || Math.abs(point.y) > 1.4) continue;
      const x = (point.x * 0.5 + 0.5) * size.width;
      bodies.push({
        id: anchor.id,
        kind: anchor.kind,
        x,
        y: (-point.y * 0.5 + 0.5) * size.height,
        radiusPx: Math.abs((edge.x * 0.5 + 0.5) * size.width - x),
      });
    }
    return bodies;
  };

  return {
    attach(space) {
      sky = space.bentSky();
      bentFor = space;
      eased.clear();
    },
    draw(space, frame) {
      if (sky === null || bentFor !== space) return;
      const bodies = bodiesOf(space, frame.size);
      const wanted = lensRadii(frame.stop, bodies);
      const step = frame.reducedMotion ? 1 : Math.min(1, frame.dt * LENS_RATE);
      for (const id of new Set([...eased.keys(), ...wanted.keys()])) {
        const from = eased.get(id) ?? 0;
        const next = from + ((wanted.get(id) ?? 0) - from) * step;
        if (next < LENS_GONE && !wanted.has(id)) eased.delete(id);
        else eased.set(id, next);
      }
      sky.set(strongestLenses(bodies, eased, SKY_LENSES), frame.size);
    },
  };
}
