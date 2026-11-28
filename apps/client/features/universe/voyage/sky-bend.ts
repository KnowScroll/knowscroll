/**
 * The look of gravity, drawn: the background bends round the groups in front of it (`sky-lens.ts` says which and how),
 * and the bodies stay as they are. Each frame, after the camera is placed, the suns and planets of the scene are
 * projected from the scene itself, so a lens sits on its mass in the very frame it is drawn, flight or lean, and a still
 * frame under reduced motion is bent too. A system's lens is centred on its sun and as wide as its planets' orbits (a
 * lone star's, as its glow); a planet's, when it is alone at its stop, as its globe. Their weights ease from frame to
 * frame (under reduced motion they are set at once), so a lens fades in and out and never pops. The drawing itself is
 * `sky-pass.ts`.
 */
import * as THREE from 'three';
import { HALO_REACH, type BuiltSpace } from '../space/scene/build-scene';
import type { LensTarget, LensMass } from './sky-lens';
import { LENS_SLOTS, strongestLenses, wantedMasses } from './sky-lens';
import { createSkyPass } from './sky-pass';
import type { GlobeOnScreen } from './voyage-control';

/** How fast a lens weight follows what its mass wants, per second. */
const LENS_RATE = 7;
/** An eased weight this small is dropped. */
const LENS_GONE = 0.01;

/** What a frame of the bent sky needs. */
export interface SkyBendFrame {
  readonly target: LensTarget;
  readonly size: { readonly width: number; readonly height: number };
  /** Seconds since the last frame. */
  readonly dt: number;
  readonly reducedMotion: boolean;
  /** Where the planet's globe was drawn this frame, if it was: a planet alone at its stop bends round it. */
  readonly globe: GlobeOnScreen | null;
}

export interface SkyBend {
  /** Splits the sky of `space` off its bodies, so it can be bent: call it when the scene is attached. */
  attach(space: BuiltSpace): void;
  /** Draws `space` for this frame, its background bent. */
  draw(renderer: THREE.WebGLRenderer, space: BuiltSpace, frame: SkyBendFrame): void;
  /** Frees the pass. */
  dispose(): void;
}

/** True when `object` and every parent it hangs from are drawn. */
function drawn(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
}

export function createSkyBend(): SkyBend {
  const pass = createSkyPass();
  let attachedTo: BuiltSpace | null = null;
  const eased = new Map<string, number>();
  const point = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const sunPoint = new THREE.Vector3();
  const right = new THREE.Vector3();

  /** Projects the point `point` (world) and returns its place and the radius, on screen, of `world` units at its depth. */
  const project = (
    camera: THREE.Camera,
    world: number,
    size: SkyBendFrame['size'],
  ): { x: number; y: number; radiusPx: number } | null => {
    edge.copy(point).addScaledVector(right, world);
    point.project(camera);
    edge.project(camera);
    if (point.z >= 1 || Math.abs(point.x) > 1.6 || Math.abs(point.y) > 1.6) return null;
    const x = (point.x * 0.5 + 0.5) * size.width;
    return { x, y: (-point.y * 0.5 + 0.5) * size.height, radiusPx: Math.abs((edge.x * 0.5 + 0.5) * size.width - x) };
  };

  /** The systems' groups and the planets drawn on screen now. */
  const massesOf = (space: BuiltSpace, frame: SkyBendFrame): LensMass[] => {
    const camera = space.camera;
    camera.updateMatrixWorld();
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    const masses: LensMass[] = [];
    for (const anchor of space.anchors) {
      if ((anchor.kind !== 'system' && anchor.kind !== 'planet') || anchor.systemId === null) continue;
      // The planet the camera is at is drawn as its globe, which sets the painted body aside: the globe is its place.
      const globe = anchor.kind === 'planet' && anchor.id === frame.target.planetId ? frame.globe : null;
      if (globe !== null) {
        masses.push({ id: anchor.id, kind: 'planet', systemId: anchor.systemId, ...globe });
        continue;
      }
      if (!drawn(anchor.object)) continue;
      anchor.object.getWorldPosition(point);
      if (anchor.kind === 'system') {
        // The group reaches as far as its farthest planet's orbit, measured at the sun's depth; a star alone, its glow.
        sunPoint.copy(point);
        let reach = 0;
        for (const other of space.anchors)
          if (other.kind === 'planet' && other.systemId === anchor.systemId)
            reach = Math.max(reach, other.object.getWorldPosition(edge).distanceTo(sunPoint));
        point.copy(sunPoint);
        const at = project(camera, reach > 0 ? reach : HALO_REACH, frame.size);
        if (at !== null) masses.push({ id: anchor.id, kind: 'system', systemId: anchor.systemId, ...at });
      } else {
        const at = project(camera, anchor.radius, frame.size);
        if (at !== null) masses.push({ id: anchor.id, kind: 'planet', systemId: anchor.systemId, ...at });
      }
    }
    return masses;
  };

  return {
    attach(space) {
      space.splitSky();
      attachedTo = space;
      eased.clear();
    },
    draw(renderer, space, frame) {
      if (attachedTo !== space) {
        renderer.render(space.scene, space.camera);
        return;
      }
      const masses = massesOf(space, frame);
      const wanted = wantedMasses(frame.target, masses);
      const step = frame.reducedMotion ? 1 : Math.min(1, frame.dt * LENS_RATE);
      for (const id of new Set([...eased.keys(), ...wanted.keys()])) {
        const from = eased.get(id) ?? 0;
        const next = from + ((wanted.get(id) ?? 0) - from) * step;
        if (next < LENS_GONE && !wanted.has(id)) eased.delete(id);
        else eased.set(id, next);
      }
      pass.draw(renderer, space, strongestLenses(masses, eased, LENS_SLOTS), frame.size);
    },
    dispose() {
      pass.dispose();
    },
  };
}
