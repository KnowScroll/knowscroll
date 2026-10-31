import * as THREE from 'three';
import { clamp01 } from '../animation/easing';
import {
  cameraAt as enterPlanetCameraAt,
  clampT as clampPlanetT,
  DESIGN_GLOBE_RADIUS,
  finalFraming,
  globeAt,
  handoverAt,
  RING_NORMAL,
  RING_TURN,
} from '../animation/enter-planet';
import { enterSystemFrame, ENTER_SYSTEM } from '../animation/enter-system';
import { MOON_RADIANS_PER_SECOND, MOON_START_ANGLE, moonOffsetAt } from '../planet/globe-motion';
import { cameraBasis, length, mix, sub, type Vec3 } from '../animation/vec3';
import { withDrift, type CameraPose } from './camera-rig';
import type { BuiltSpace } from './scene/build-scene';
import type { PlanetHandover } from './scene/planet';
import type { ScriptFrame, SpaceScript } from './space-script';

const asTuple = (vector: THREE.Vector3): Vec3 => [vector.x, vector.y, vector.z];

/** The moon of the planet view stands this far toward the camera, in planet radii, so it is on the near side. */
const MOON_NEAR_SIDE = 1.3;
/** The hand-over fades the 3D moon to this share of its size by the time it reaches the planet view's place. */
const MOON_SHRINK_TO = 20 / DESIGN_GLOBE_RADIUS / 0.27;
/** The drift of the camera's breathing is let go over this long at the start of a glide to a planet. */
const DRIFT_RELEASE_SECONDS = 0.6;

/** The world orientation of the planet view's ring: its camera-space normal, turned about the view axis. */
function ringTurn(pose: CameraPose): THREE.Quaternion {
  const { right, up, back } = cameraBasis(pose.position, pose.target);
  const camera = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(new THREE.Vector3(...right), new THREE.Vector3(...up), new THREE.Vector3(...back)),
  );
  const normal = new THREE.Vector3(...RING_NORMAL).normalize().applyAxisAngle(new THREE.Vector3(0, 0, 1), RING_TURN);
  return camera.multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal));
}

/** Where the planet view's moon is, in the world, at `local` seconds into the glide. */
function moonPlace(pose: CameraPose, planet: THREE.Vector3, radius: number, local: number): THREE.Vector3 {
  const { right, up, back } = cameraBasis(pose.position, pose.target);
  const offset = moonOffsetAt(MOON_START_ANGLE + local * MOON_RADIANS_PER_SECOND, DESIGN_GLOBE_RADIUS);
  const perPixel = radius / DESIGN_GLOBE_RADIUS;
  return planet
    .clone()
    .addScaledVector(new THREE.Vector3(...right), offset.x * perPixel)
    .addScaledVector(new THREE.Vector3(...up), -offset.y * perPixel)
    .addScaledVector(new THREE.Vector3(...back), radius * MOON_NEAR_SIDE);
}

export interface DirectedFrame {
  /** The camera for this frame, with the camera's breathing as the live view has it. */
  readonly pose: CameraPose;
  /** Called once the scene has drawn with `pose`: reports what the screen lays over it. */
  readonly report: (projection: Projection) => void;
}

/** What the renderer can say about where a body is on the screen after it has set the camera. */
export interface Projection {
  readonly bodyOnScreen: (position: THREE.Vector3, radius: number) => { x: number; y: number; radiusPx: number };
}

export interface DirectInput {
  readonly script: SpaceScript;
  readonly space: BuiltSpace;
  /** The camera the animation starts from: the previous view, without its breathing. */
  readonly from: CameraPose;
  /** The camera the live view of the destination has, without its breathing. */
  readonly wanted: CameraPose;
  readonly size: { readonly width: number; readonly height: number };
  readonly t: number;
}

/** Poses the camera and the scene's props for one frame of a script. Returns `undefined` when the script's bodies are gone. */
export function directFrame(input: DirectInput): DirectedFrame | undefined {
  const { script } = input;
  const local = script.kind === 'enter-system' ? clampSystemT(script.clock()) : clampPlanetT(script.clock());
  if (script.kind === 'enter-system') return directEnterSystem(input, local);
  return directEnterPlanet(input, local);
}

const clampSystemT = (value: number): number => Math.min(Math.max(value, 0), ENTER_SYSTEM.seconds);

function directEnterSystem(input: DirectInput, local: number): DirectedFrame | undefined {
  const { script, space, from, wanted, t } = input;
  const sun = space.script.sun(script.systemId);
  const dock = space.script.dock(script.systemId);
  if (sun === undefined || dock === undefined) return undefined;
  const frame = enterSystemFrame(local, { from, to: wanted, sun: asTuple(sun), dock: asTuple(dock.position) });
  space.script.rocket(frame.rocket.visible ? frame.rocket : undefined, t);
  space.script.shipScale(frame.parkedShip);
  return {
    pose: withDrift(frame.pose, t),
    report: (projection) => {
      const at = projection.bodyOnScreen(sun, 0.7);
      script.onFrame?.({ t: local, system: { x: at.x, y: at.y } });
    },
  };
}

function directEnterPlanet(input: DirectInput, local: number): DirectedFrame | undefined {
  const { script, space, from, size, t } = input;
  const body = script.planetId === undefined ? undefined : space.script.planet(script.planetId);
  const sun = space.script.sun(script.systemId);
  if (body === undefined || sun === undefined || script.globe === undefined) return undefined;
  body.object.updateWorldMatrix(true, false);
  const planet = body.object.getWorldPosition(new THREE.Vector3());
  const scene = {
    from,
    planet: asTuple(planet),
    planetRadius: body.radius,
    sun: asTuple(sun),
    screen: size,
    globe: script.globe,
  };
  const glide = enterPlanetCameraAt(local, scene);
  const distance = length(sub(glide.position, scene.planet));
  const appearance = globeAt(local, distance, finalFraming(body.radius, size, script.globe).distance);
  space.script.closeUp(body.id, appearance);
  space.script.shipScale(appearance.shipScale);
  if (script.ringed === true) {
    const hand = handoverAt(local);
    const handover: PlanetHandover = {
      ring: { inner: hand.inner, outer: hand.outer, weight: hand.weight, fade: hand.fade, turnTo: ringTurn(glide) },
      moon: {
        weight: hand.moonWeight,
        fade: hand.fade,
        target: moonPlace(glide, planet, body.radius, local),
        shrinkTo: MOON_SHRINK_TO,
      },
    };
    space.script.handOver(body.id, handover);
  }
  // The camera's breathing is let go at the start, so there is no jump from the live view, and absent at the end,
  // where the planet has to sit exactly where the planet view draws its globe.
  const breathing = 1 - clamp01(local / DRIFT_RELEASE_SECONDS);
  const breathed = withDrift(glide, t);
  const pose: CameraPose = {
    position: mix(glide.position, breathed.position, breathing),
    target: glide.target,
    fov: glide.fov,
  };
  return {
    pose,
    report: (projection) => {
      const at = projection.bodyOnScreen(planet, body.radius);
      script.onFrame?.({
        t: local,
        planet: { x: at.x, y: at.y, radiusPx: at.radiusPx, appearance },
      } satisfies ScriptFrame);
    },
  };
}

/** Puts every prop a script touched back as the live view has it. */
export function endScript(space: BuiltSpace, script: SpaceScript): void {
  space.script.rocket(undefined, 0);
  space.script.shipScale(1);
  if (script.planetId !== undefined) {
    space.script.closeUp(script.planetId, undefined);
    space.script.handOver(script.planetId, null);
  }
}
