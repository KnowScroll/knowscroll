/**
 * The planet the camera is at, drawn as one world over the scene's painted planet once it is big enough to read: the
 * globe (`globe.ts`), its texture painted a few milliseconds per frame (`world-texture.ts`), which way it faces, its
 * light, and its regions' names as anchors. Near the planet the globe takes over: the painted body under it and its haze
 * fade, the sun's glow dims and the star's other planets step aside, as the prototype's planet stop shows one world
 * alone. Part of the driver: three.js reaches it only through `voyage-loader.ts`.
 */
import * as THREE from 'three';
import { clamp, smooth } from '../space/paint';
import type { BuiltSpace } from '../space/scene/build-scene';
import type { SpaceAnchor } from '../space/space-surface';
import { wrapAngle } from './flight';
import { createGlobe, localPointOf } from './globe';
import { namedFromPxOf, type ViewSize } from './voyage-chains';
import type { GlobeOnScreen, VoyageControl, VoyagePlanet } from './voyage-control';
import {
  BAND_WIDTH,
  createWorldPainter,
  groundPatchOf,
  worldLookOf,
  type GroundPatch,
  type LabelPoint,
  type WorldPainter,
} from './world-texture';

/**
 * The textures of a planet's world, painted a few milliseconds per frame: a quick one so the globe has its continents
 * within a second or so, then a sharper one, swapped in when it is done. On the ground the sphere is about 4,700 device
 * pixels round, so even the second is soft there: the ground's sharpness is the patch's (below).
 */
const TEXTURES = [
  { width: 1024, height: 512 },
  { width: 2048, height: 1024 },
] as const;
/**
 * The ground patch (`groundPatchOf`): a third texture, of only the window of the band round the place the camera comes
 * down over, painted by the same painter after the quick texture and before the sharper globe one (so the ground is
 * sharp soonest). It is wanted from the planet's stop on, so it is ready when a fall reaches the ground.
 */
interface PatchJob {
  /** The world it is painted from and the landing and screen it is for: it is painted again when any of them changes. */
  readonly key: string;
  readonly patch: GroundPatch;
  readonly painter: WorldPainter;
}
/** How long one frame may spend painting the world's texture (milliseconds): the rest of the frame is for drawing. */
const PAINT_BUDGET_MS = 4;
/** One turn of the globe in 70 s when nothing else turns it (the prototype's idle spin, `pl.lon += dt * TAU / 70`). */
const SPIN_PER_SECOND = (2 * Math.PI) / 70;
/** On the ground the globe turns no farther toward a pole than this (radians). */
const GROUND_LATITUDE_LIMIT = 1.2;
/** From orbit the globe turns no farther toward a pole than this (radians). */
const ORBIT_LATITUDE_LIMIT = 0.95;
/** From orbit the globe tilts toward the first region's latitude by this share of it. */
const ORBIT_LATITUDE_SHARE = 0.5;
/** The globe's radius is this much over the painted planet's, so it just covers it. */
const GLOBE_OVERSIZE = 1.004;
/** The globe starts to show over the painted planet at this on-screen radius (pixels) ... */
const GLOBE_FADE_FROM_PX = 20;
/** ... and is fully shown at this one. */
const GLOBE_FADE_TO_PX = 60;
/** How fast the globe closes on the way it should face (per second): a frame closes `1 - exp(-dt * rate)` of what is left. */
const ORIENT_RATE = 3.2;
/** The day-and-night shading starts to show at this on-screen radius (pixels) ... */
const LIGHT_FROM_PX = 200;
/** ... and is full at this one. */
const LIGHT_TO_PX = 430;
/** A region's name point is shown while its surface faces the camera at least this much (cosine of the angle). */
const FACING_LEAST = 0.25;
/** The sun starts to shrink away once the globe shows this much (its opacity), and is gone when it is whole. */
const SUN_GONE_FROM = 0.3;
/** A painted planet's ring at rest, in planet radii (`scene/planet.ts`), and the hand-over values that leave it and its moon where they are. */
const RING_AT_REST = { inner: 1.4, outer: 2.4 } as const;
const NO_TURN = new THREE.Quaternion();
const NO_MOVE = new THREE.Vector3();
/** Where the light comes from when the planet's star is not in the scene. */
const DEFAULT_TO_SUN = new THREE.Vector3(-0.45, 0.55, 0.7);

/** The stops the patch is wanted at: the planet (a fall is next) and the ground. */
const inFall = (stop: string): boolean => stop === 'planet' || stop === 'ground';
/** The longitude a point of the globe's band faces, in radians: the band is a whole turn, with its middle at 0. */
const lonOfBandX = (x: number): number => (x / BAND_WIDTH) * 2 * Math.PI - Math.PI;

/** The planet being drawn this frame, where it is and what lights it. */
export interface CloseUpFrame {
  /** Scene time and the length of the last frame, in seconds. */
  readonly t: number;
  readonly dt: number;
  /** The planet's world, its scene body (id, position now, radius) and the sun lighting it, if the scene holds it. */
  readonly world: VoyagePlanet;
  readonly planet: { readonly id: string; readonly position: THREE.Vector3; readonly radius: number };
  readonly sun: THREE.Vector3 | undefined;
  /** Where the camera stands this frame, and its focal length in layout points. */
  readonly cameraPosition: THREE.Vector3;
  readonly focal: number;
  readonly size: ViewSize;
}

/** The planet drawn as one world: see the top of this file. */
export interface PlanetCloseUp {
  /** Puts the globe into a newly built scene; the painted bodies of the last one are no longer set aside. */
  attach(space: BuiltSpace): void;
  /** Draws the globe for this frame over the planet, or hides it while the planet is too small to read. */
  show(space: BuiltSpace, frame: CloseUpFrame): void;
  /** No planet this frame: hides the globe and gives back what it set aside. */
  hide(space: BuiltSpace): void;
  /** Where the globe was drawn on screen in the last frame, if it was. */
  readonly onScreen: () => GlobeOnScreen | null;
  /** The globe's regions facing the camera, as named points, once it is big enough to name them. */
  anchors(space: BuiltSpace, size: ViewSize, world: VoyagePlanet | null): SpaceAnchor[];
  /**
   * Compiles the globe's shader program, without drawing it: the globe first shows mid-flight, as the camera nears a
   * planet, and a program linked then holds that frame back.
   */
  compile(renderer: THREE.WebGLRenderer, space: BuiltSpace): void;
  /** Takes the globe out of the scene and frees it. */
  dispose(): void;
}

/** Makes the close-up for one screen's control. */
export function createPlanetCloseUp(control: VoyageControl): PlanetCloseUp {
  const globe = createGlobe();
  let attachedTo: BuiltSpace | null = null;
  /** The texture being painted a few milliseconds per frame, and which of {@link TEXTURES} it is. */
  let painting: { key: string; size: number; painter: WorldPainter } | null = null;
  /** The planet whose texture is on the globe, and which of {@link TEXTURES} it is. */
  let painted: { key: string; size: number } | null = null;
  /** The patch being painted, and the key of the one the globe wears. */
  let patching: PatchJob | null = null;
  let patchWorn: string | null = null;
  /** Where the globe faces now (radians), which eases toward {@link wantedOrientation}. */
  const orientation = { lon: 0, lat: 0 };
  let onScreen: GlobeOnScreen | null = null;
  /** The planet whose painted body, glow and neighbours the globe has set aside, to give them back when it goes. */
  let closeUpOf: { id: string; siblings: readonly string[] } | null = null;

  const scratch = {
    toCamera: new THREE.Vector3(),
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    facing: new THREE.Matrix4(),
    turn: new THREE.Matrix4(),
    turnY: new THREE.Matrix4(),
    toSun: new THREE.Vector3(),
    centre: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    view: new THREE.Vector3(),
    point: new THREE.Vector3(),
  };

  const giveBack = (space: BuiltSpace) => {
    if (closeUpOf === null) return;
    space.script.closeUp(closeUpOf.id, undefined);
    space.script.handOver(closeUpOf.id, null);
    for (const id of [closeUpOf.id, ...closeUpOf.siblings]) {
      const body = space.script.planet(id);
      if (body) body.object.visible = true;
    }
    closeUpOf = null;
  };
  const setAside = (space: BuiltSpace, planetId: string, opacity: number) => {
    if (closeUpOf !== null && closeUpOf.id !== planetId) giveBack(space);
    closeUpOf = { id: planetId, siblings: control.siblings.filter((id) => id !== planetId) };
    space.script.closeUp(planetId, {
      atmosphere: 1.15 * (1 - opacity),
      sunBloom: 1 - 0.85 * opacity,
      sunGlow: 1 - 0.85 * opacity,
      // The prototype's planet stop shows no sun, and a sun cut off by the screen's edge reads as a flat shape: it
      // shrinks away, glow and all, as the globe takes over, and the sky behind the planet goes dark.
      sun: 1 - smooth(SUN_GONE_FROM, 1, opacity),
    });
    const body = space.script.planet(planetId);
    if (body) body.object.visible = opacity < 0.98;
    // The globe has no ring or moon: the painted planet's come in as the globe goes, instead of all at once.
    const fade = 1 - opacity;
    space.script.handOver(planetId, {
      ring: { inner: RING_AT_REST.inner, outer: RING_AT_REST.outer, weight: 0, fade, turnTo: NO_TURN },
      moon: { weight: 0, fade, target: NO_MOVE, shrinkTo: 1 },
    });
    for (const id of closeUpOf.siblings) {
      const sibling = space.script.planet(id);
      if (sibling) sibling.object.visible = opacity < 0.5;
    }
  };

  /** The region the ground faces: the chosen one, else the world's first (as {@link wantedOrientation} reads it). */
  const landingOf = (world: VoyagePlanet): LabelPoint | null =>
    world.labels.find((label) => label.objectId === control.target.regionId) ?? world.labels[0] ?? null;

  /** Wears the texture just painted. */
  const finish = () => {
    if (painting === null) return;
    globe.setTexture(painting.painter.result());
    painted = { key: painting.key, size: painting.size };
    painting = null;
  };

  /**
   * Paints one painter a few milliseconds more, and one only: the quick texture first, then the ground patch (when the
   * camera is at the planet or its ground, for the region the ground faces), then the sharper globe texture. A painter
   * left half done keeps its place while another goes first.
   */
  const paintStep = (world: VoyagePlanet, size: ViewSize) => {
    const budget = control.reducedMotion ? Infinity : PAINT_BUDGET_MS;
    if (painting !== null && painting.key !== world.key) painting = null;
    if (painted !== null && painted.key !== world.key) painted = null;
    // A patch is part of one world's drawing: another world's is dropped at once, never worn.
    if (patching !== null && !patching.key.startsWith(`${world.key}|`)) patching = null;
    if (patchWorn !== null && !patchWorn.startsWith(`${world.key}|`)) {
      patchWorn = null;
      globe.setPatch(null, null);
    }
    if (painted?.key !== world.key && painting === null) {
      painting = { key: world.key, size: 0, painter: createWorldPainter({ ...world, ...TEXTURES[0] }) };
      painted = null;
      globe.setTexture(null);
      patching = null;
      globe.setColours({
        sea: world.palette.sea[0],
        cap: world.palette.cloud[0],
        air: world.palette.atmosphere,
        look: worldLookOf(world.palette),
      });
    }
    // Under reduced motion every texture is painted in the one frame drawn, so a patch would hold that frame for a
    // second on a phone, again at every region: the ground keeps the sharper whole-band texture there instead.
    const landing =
      !control.reducedMotion && painted?.key === world.key && inFall(control.target.stop) ? landingOf(world) : null;
    const patchKey = landing === null ? null : `${world.key}|${landing.x}|${landing.lat}|${size.width}x${size.height}`;
    if (patching !== null && patching.key !== patchKey) patching = null;
    if (patchKey !== null && landing !== null && patchWorn !== patchKey && patching === null) {
      const patch = groundPatchOf(landing, size);
      patching = {
        key: patchKey,
        patch,
        painter: createWorldPainter({ ...world, width: patch.width, height: patch.height, patch }),
      };
    }
    if (patching === null && painting === null && painted !== null && painted.size + 1 < TEXTURES.length) {
      const next = painted.size + 1;
      painting = { key: world.key, size: next, painter: createWorldPainter({ ...world, ...TEXTURES[next]! }) };
    }
    // One painter a frame: the quick texture, else the patch, else the sharper texture.
    if (painting !== null && painting.size === 0) {
      if (painting.painter.step(budget)) finish();
    } else if (patching !== null) {
      if (patching.painter.step(budget)) {
        globe.setPatch(patching.painter.result(), patching.patch.window);
        patchWorn = patching.key;
        patching = null;
      }
    } else if (painting !== null) {
      if (painting.painter.step(budget)) finish();
    }
  };
  /** Where the globe should face: on the ground the chosen region (or the first); from orbit a slow spin from the first. */
  const wantedOrientation = (world: VoyagePlanet, t: number, radiusPx: number) => {
    const turnLon = control.turn.x / Math.max(radiusPx, 1);
    const turnLat = control.turn.y / Math.max(radiusPx, 1);
    if (control.target.stop === 'ground') {
      const region =
        world.labels.find((label) => label.objectId === control.target.regionId) ?? world.labels[0] ?? null;
      const lon = region === null ? 0 : lonOfBandX(region.x);
      return {
        lon: lon + turnLon,
        lat: clamp((region?.lat ?? 0) - turnLat, -GROUND_LATITUDE_LIMIT, GROUND_LATITUDE_LIMIT),
      };
    }
    // From orbit the globe turns slowly, starting with the first formed region facing you.
    const first = world.labels[0];
    const facing = first === undefined ? 0 : lonOfBandX(first.x);
    const spin = control.reducedMotion ? 0 : t * SPIN_PER_SECOND;
    return {
      lon: facing + spin + turnLon,
      lat: clamp((first?.lat ?? 0) * ORBIT_LATITUDE_SHARE - turnLat, -ORBIT_LATITUDE_LIMIT, ORBIT_LATITUDE_LIMIT),
    };
  };

  /** Turns the globe so that the point at its current `orientation` faces the camera along `direction`, north up. */
  const orient = (direction: THREE.Vector3) => {
    const up = scratch.up.set(0, 1, 0).addScaledVector(direction, -direction.y).normalize();
    const right = scratch.right.crossVectors(up, direction).normalize();
    const facing = scratch.facing.makeBasis(right, up, direction);
    const turn = scratch.turn.makeRotationX(orientation.lat).multiply(scratch.turnY.makeRotationY(-orientation.lon));
    globe.mesh.quaternion.setFromRotationMatrix(facing.multiply(turn));
  };

  return {
    attach(space) {
      attachedTo = space;
      closeUpOf = null;
      space.scene.add(globe.mesh);
    },
    show(space, frame) {
      const { planet, cameraPosition } = frame;
      paintStep(frame.world, frame.size);
      const radiusPx = (frame.focal * planet.radius) / Math.max(planet.position.distanceTo(cameraPosition), 1e-6);
      const opacity = smooth(GLOBE_FADE_FROM_PX, GLOBE_FADE_TO_PX, radiusPx);
      globe.mesh.visible = opacity > 0.01;
      if (globe.mesh.visible) setAside(space, planet.id, opacity);
      else giveBack(space);
      globe.mesh.position.copy(planet.position);
      globe.mesh.scale.setScalar(planet.radius * GLOBE_OVERSIZE);
      const wanted = wantedOrientation(frame.world, frame.t, radiusPx);
      const follow = control.reducedMotion ? 1 : 1 - Math.exp(-frame.dt * ORIENT_RATE);
      orientation.lon += wrapAngle(wanted.lon - orientation.lon) * follow;
      orientation.lat += (wanted.lat - orientation.lat) * follow;
      orient(scratch.toCamera.copy(cameraPosition).sub(planet.position).normalize());
      globe.setLight(
        frame.sun === undefined ? DEFAULT_TO_SUN : scratch.toSun.copy(frame.sun).sub(planet.position),
        smooth(LIGHT_FROM_PX, LIGHT_TO_PX, radiusPx),
        opacity,
      );
      const centre = scratch.centre.copy(planet.position).project(space.camera);
      onScreen = {
        x: (centre.x * 0.5 + 0.5) * frame.size.width,
        y: (-centre.y * 0.5 + 0.5) * frame.size.height,
        radiusPx,
      };
    },
    hide(space) {
      onScreen = null;
      globe.mesh.visible = false;
      giveBack(space);
    },
    onScreen: () => onScreen,
    anchors(space, size, world) {
      if (
        world === null ||
        !globe.mesh.visible ||
        onScreen === null ||
        onScreen.radiusPx < namedFromPxOf(control.room === undefined ? size : { ...size, room: control.room })
      )
        return [];
      space.camera.updateMatrixWorld();
      globe.mesh.updateMatrixWorld();
      const anchors: SpaceAnchor[] = [];
      for (const label of world.labels) {
        const surface = globe.mesh.localToWorld(localPointOf(label.x, label.lat));
        const normal = scratch.normal.copy(surface).sub(globe.mesh.position).normalize();
        const facing = normal.dot(scratch.view.copy(space.camera.position).sub(surface).normalize());
        const point = scratch.point.copy(surface).project(space.camera);
        anchors.push({
          id: label.objectId,
          kind: 'region',
          name: world.names.get(label.objectId) ?? '',
          systemId: control.target.systemId,
          x: (point.x * 0.5 + 0.5) * size.width,
          y: (-point.y * 0.5 + 0.5) * size.height,
          radiusPx: 0,
          visible: facing > FACING_LEAST && point.z < 1,
        });
      }
      return anchors;
    },
    compile(renderer, space) {
      // `compileAsync` links without blocking the frame where the browser can (KHR_parallel_shader_compile). The
      // globe is hidden, which `compile` does not skip. If it fails, the first draw links it instead, as before.
      renderer.compileAsync(globe.mesh, space.camera, space.scene).catch(() => undefined);
    },
    dispose() {
      attachedTo?.scene.remove(globe.mesh);
      globe.dispose();
    },
  };
}
