/**
 * Makes the stations and the forming dust of the trial look stand apart, in the scene itself. Each frame, once the
 * camera is placed, it measures the suns, the stations and the dust clouds on screen, asks `stand-apart.ts` how far each
 * must move, and moves each object that far, in the camera's plane, so its depth (and so its size on screen) is the
 * same. Everything that reads a place from the scene then reads the moved one: the station's picture, its button and
 * name, the dust cloud as three.js draws it and the ship's drop target. The scene's own placing (`placeStation` and
 * `placeDust` in `space-model.ts`, which the shipping map shares) is not touched: each object keeps the place it was
 * built at and is put at that place plus the offset of this frame, so nothing drifts and an offset that is no longer
 * needed is gone the same frame.
 */
import * as THREE from 'three';
import type { CameraPose } from '../space/camera-rig';
import { HALO_REACH, type BuiltSpace } from '../space/scene/build-scene';
import { standApart, type Disc, type Offset, type StationClears, type StationDisc, type SunDisc } from './stand-apart';
import { stationSize } from './station-look';

/**
 * What a station keeps clear of at its own system: the whole group, out to its farthest planet's orbit (as `sky-bend.ts`
 * measures it), so it stands in open space off its system, never among its planets ("separate and not around a sun",
 * the owner, 28 November). `'sun'` clears only the sun's disc. Every other sun's disc is cleared either way.
 */
export const STATION_CLEARS: StationClears = 'group';

/** What the scene needs of a frame. */
interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** An object the pass moves, with the length on screen of a scene unit at its depth. */
interface Mover {
  readonly object: THREE.Object3D;
  readonly base: THREE.Vector3;
  /** Scene units for each point of the screen at the object's depth. */
  readonly unitsPerPoint: number;
}

export interface StandApartScene {
  /**
   * Puts the camera at `pose` (the renderer does so again, to the same pose, once the driver has returned it) and moves
   * the stations and dust of `space` apart for it.
   */
  apply(space: BuiltSpace, pose: CameraPose, size: FrameSize): void;
}

/** True when `object` and every parent it hangs from are drawn. */
function drawn(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
}

export function createStandApart(stationClears: StationClears = STATION_CLEARS): StandApartScene {
  /** Where each object was built, kept for as long as the object lives: an object of a scene built again has its own. */
  const bases = new WeakMap<THREE.Object3D, THREE.Vector3>();
  const point = new THREE.Vector3();
  const inView = new THREE.Vector3();
  const sunPoint = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();

  const baseOf = (object: THREE.Object3D): THREE.Vector3 => {
    let base = bases.get(object);
    if (base === undefined) {
      base = object.position.clone();
      bases.set(object, base);
    }
    return base;
  };

  return {
    apply(space, pose, size) {
      const camera = space.camera;
      space.setCamera(pose);
      camera.updateMatrixWorld();
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);

      /** The world point `at` on screen, a body of `radius` scene units there as a disc; null behind the camera. */
      const measure = (at: THREE.Vector3, radius: number): (Disc & { readonly unitsPerPoint: number }) | null => {
        inView.copy(at).applyMatrix4(camera.matrixWorldInverse);
        const depth = -inView.z;
        if (depth <= camera.near) return null;
        const unitsPerPoint = (2 * depth * halfTan) / size.height;
        return {
          x: size.width / 2 + inView.x / unitsPerPoint,
          y: size.height / 2 - inView.y / unitsPerPoint,
          radius: radius / unitsPerPoint,
          unitsPerPoint,
        };
      };

      const suns: SunDisc[] = [];
      const stations: (StationDisc & Mover)[] = [];
      const dust: (Disc & Mover)[] = [];
      for (const anchor of space.anchors) {
        const { object } = anchor;
        if (anchor.kind === 'station' || anchor.kind === 'dust') object.position.copy(baseOf(object));
        if (!drawn(object)) continue;
        object.getWorldPosition(point);
        if (anchor.kind === 'system') {
          let reach = HALO_REACH;
          if (stationClears === 'group') {
            sunPoint.copy(point);
            reach = 0;
            for (const other of space.anchors)
              if (other.kind === 'planet' && other.systemId === anchor.systemId)
                reach = Math.max(reach, other.object.getWorldPosition(edge).distanceTo(sunPoint));
            if (reach === 0) reach = HALO_REACH;
          }
          const sun = measure(point, anchor.radius);
          const group = measure(point, reach);
          if (sun !== null && group !== null) suns.push({ ...sun, systemId: anchor.systemId!, reach: group.radius });
        } else if (anchor.kind === 'station') {
          const at = measure(point, anchor.radius);
          if (at !== null)
            stations.push({
              ...at,
              radius: stationSize(at.radius) / 2,
              systemId: anchor.systemId!,
              object,
              base: baseOf(object),
            });
        } else if (anchor.kind === 'dust') {
          const at = measure(point, anchor.radius);
          if (at !== null) dust.push({ ...at, object, base: baseOf(object) });
        }
      }
      if (stations.length === 0 && dust.length === 0) return;

      const offsets = standApart({ suns, stations, dust, stationClears, view: size });
      const move = (movers: readonly Mover[], by: readonly Offset[]): void =>
        movers.forEach(({ object, base, unitsPerPoint }, index) => {
          const { x, y } = by[index]!;
          // Screen y runs down; the camera's up runs up.
          object.position
            .copy(base)
            .addScaledVector(right, x * unitsPerPoint)
            .addScaledVector(up, -y * unitsPerPoint);
        });
      move(stations, offsets.stations);
      move(dust, offsets.dust);
    },
  };
}
