import * as THREE from 'three';
import { stationCaption } from '@knowscroll/client-core';
import type { PixelImage } from '../texture-data';
import { distanceOf, FIELD_OF_VIEW, type CameraPose } from '../camera-rig';
import { planetGenome } from '../planet-genome';
import type { SpaceDefinition, SpaceStationDefinition, SpaceSystemDefinition } from '../space-definition';
import { createSpriteTextures, pixelTexture, type Built, type PaintCache, type SceneContext } from './context';
import { makeHalo } from './halo';
import { makeNebula } from './nebula';
import { makePlanet, type BuiltPlanet, type PlanetHandover } from './planet';
import { makeShip, makeStation } from './props';
import { makeRocket, type Rocket, type RocketPose } from './rocket';
import { addSky } from './sky';
import { makeSun, type BuiltSun } from './sun';

/** A point of the scene that a label or tap target follows. */
export interface WorldAnchor {
  readonly id: string;
  readonly kind: 'system' | 'planet' | 'station' | 'dust';
  readonly name: string;
  /** A station's sky in words ("6 of 7"), drawn beside its name; absent for any other body and for an outsider's station. */
  readonly caption?: string;
  /** The system it belongs to; dust belongs to none. */
  readonly systemId: string | null;
  readonly object: THREE.Object3D;
  /** Radius of the body in scene units, for sizing its tap target. */
  readonly radius: number;
}

export interface BuiltSpace {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly pixelRatio: { value: number };
  readonly anchors: readonly WorldAnchor[];
  /** Poses the whole scene at time `t`. Calling it twice with the same `t` gives the same picture. */
  readonly poseAt: (t: number) => void;
  /** Puts the camera at `pose` and tunes the haze to its distance. */
  readonly setCamera: (pose: CameraPose) => void;
  /** Shows one system alone (a System view), or everything (`null`). */
  readonly showOnly: (systemId: string | null) => void;
  /** Pulses a warm glow around one system (picked on the Far level) or one planet (picked on the desktop), or none. */
  readonly highlight: (id: string | null) => void;
  /** What a camera script ("Enter a system", "Enter a planet") reads of the scene and changes in it. */
  readonly script: SceneScripting;
  /** Releases textures, geometries and materials. */
  readonly dispose: () => void;
}

/** A planet seen from outside the scene builder. */
export interface PlanetBody {
  readonly id: string;
  readonly systemId: string;
  /** Radius in scene units. */
  readonly radius: number;
  readonly object: THREE.Object3D;
  readonly planet: BuiltPlanet;
}

/**
 * The few handles an animation needs, so it never reaches into the scene graph itself. Positions are
 * read at the instant of the last pose (`poseAt`), in world units.
 */
export interface SceneScripting {
  /** The planet, or `undefined` when it is not in this scene. */
  readonly planet: (id: string) => PlanetBody | undefined;
  /** The system's sun in the world. */
  readonly sun: (systemId: string) => THREE.Vector3 | undefined;
  /** Where a rocket parks in a system: beside the planet that holds the ship, or the first planet. */
  readonly dock: (systemId: string) => { readonly planetId: string; readonly position: THREE.Vector3 } | undefined;
  /** Poses the rocket for this frame, or hides it with `undefined`. */
  readonly rocket: (pose: RocketPose | undefined, t: number) => void;
  /** Scales the ship that stays parked (the rocket swaps for it, 0 to 1). */
  readonly shipScale: (scale: number) => void;
  /** Eases the atmosphere of a planet and the glow of its sun down as the camera comes close; `undefined` restores them. */
  readonly closeUp: (
    planetId: string,
    state: { atmosphere: number; sunBloom: number; sunGlow: number } | undefined,
  ) => void;
  /** Turns a planet's ring and moon into the planet view's, or back with `null`. */
  readonly handOver: (planetId: string, handover: PlanetHandover | null) => void;
}

/** Angular speed of a planet: inner planets turn faster. */
function orbitSpeed(system: SpaceSystemDefinition, orbitRadius: number): number {
  const innermost = Math.min(...system.planets.map((planet) => planet.orbitRadius));
  return system.speed * Math.pow(innermost / orbitRadius, system.orbitFalloff);
}

export interface SystemBuild {
  readonly built: Built;
  readonly sun: BuiltSun;
  readonly bodies: PlanetBody[];
  readonly ships: readonly { readonly planetId: string; readonly ship: Built }[];
  readonly anchors: WorldAnchor[];
  /** The warm glows a pick turns on: the system's own, and one around each planet (D02 picks a planet). */
  readonly picks: ReadonlyMap<string, THREE.Sprite>;
}

/** The ship rides on its planet, a little above and beside it, sized to the planet it parks at. */
function parkShip(planet: THREE.Object3D, planetRadius: number, sun: THREE.Vector3, context: SceneContext): Built {
  const ship = makeShip(context, sun, (planetRadius / 0.3) * 0.75);
  ship.object.position.set(planetRadius * 1.45, planetRadius * 1.5, 0);
  planet.add(ship.object);
  return ship;
}

/** A soft additive glow, off until a pick turns it on. */
function makeGlow(context: SceneContext): THREE.Sprite {
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      color: new THREE.Color(1, 0.9, 0.35),
      opacity: 0,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  glow.visible = false;
  glow.userData['pick'] = true;
  return glow;
}

export function buildSystem(
  system: SpaceSystemDefinition,
  context: SceneContext,
  shipPlanetId: string | undefined,
): SystemBuild {
  const scoped: SceneContext = { ...context, calm: system.calm === true };
  const group = new THREE.Group();
  group.position.set(system.position.x, 0, system.position.z);
  const sunPosition = group.position.clone();
  const outer = Math.max(1, ...system.planets.map((planet) => planet.orbitRadius));
  group.add(makeHalo(outer * 2.2, system.family, scoped, 0.6));
  const sun = makeSun(system.sunRadius, scoped);
  group.add(sun.object);
  const pick = makeGlow(context);
  group.add(pick);
  const picks = new Map<string, THREE.Sprite>([[system.id, pick]]);
  const anchors: WorldAnchor[] = [
    {
      id: system.id,
      kind: 'system',
      name: system.name,
      systemId: system.id,
      object: sun.object,
      radius: system.sunRadius,
    },
  ];
  const ships: { planetId: string; ship: Built }[] = [];
  const bodies: PlanetBody[] = [];

  const orbiting = system.planets.map((definition) => {
    const genome = planetGenome(`${definition.id}:${definition.variant ?? 0}`, definition.type, system.family, {
      rings: definition.rings === true,
      moon: definition.moon === true,
      ...(definition.hueShift === undefined ? {} : { hueShift: definition.hueShift }),
    });
    const radius = Math.min(system.planetRadius * genome.size, system.sunRadius * 0.55);
    const planet = makePlanet(genome, radius, sunPosition, {
      ...context,
      calm: scoped.calm || definition.calm === true,
    });
    const pivot = new THREE.Group();
    planet.object.position.set(definition.orbitRadius, 0, 0);
    pivot.add(planet.object);
    group.add(pivot);
    const planetGlow = makeGlow(context);
    planet.object.add(planetGlow);
    picks.set(definition.id, planetGlow);
    anchors.push({
      id: definition.id,
      kind: 'planet',
      name: definition.name,
      systemId: system.id,
      object: planet.object,
      radius,
    });
    bodies.push({ id: definition.id, systemId: system.id, radius, object: planet.object, planet });
    if (definition.id === shipPlanetId)
      ships.push({ planetId: definition.id, ship: parkShip(planet.object, radius, sunPosition, scoped) });
    return { definition, planet, pivot, radius, speed: orbitSpeed(system, definition.orbitRadius) };
  });

  const tick = (t: number): void => {
    sun.tick(t);
    for (const { definition, planet, pivot, speed } of orbiting) {
      pivot.rotation.y = -(definition.startAngle + t * speed);
      planet.tick(t);
    }
    for (const { ship } of ships) ship.tick(t);
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    if (pick.visible) {
      pick.scale.setScalar(outer * (0.9 + 0.25 * pulse));
      pick.material.opacity = 0.3 + 0.3 * pulse;
    }
    for (const { definition, radius } of orbiting) {
      const glow = picks.get(definition.id)!;
      if (!glow.visible) continue;
      glow.scale.setScalar(radius * (3.4 + 0.6 * pulse));
      glow.material.opacity = 0.35 + 0.3 * pulse;
    }
  };
  tick(0);
  return { built: { object: group, tick }, sun, bodies, ships, anchors, picks };
}

function buildStation(
  station: SpaceStationDefinition,
  systems: ReadonlyMap<string, SpaceSystemDefinition>,
  context: SceneContext,
): { built: Built; anchor: WorldAnchor } {
  const home = systems.get(station.systemId);
  const sun = new THREE.Vector3(home?.position.x ?? 0, 0, home?.position.z ?? 0);
  const built = makeStation(
    { ...context, calm: station.calm === true },
    sun,
    station.emblem,
    station.sky,
    station.live !== undefined,
  );
  built.object.position.set(station.position.x, station.position.y, station.position.z);
  // Stations are small beside a sun: they are a doorway, not a place.
  built.object.scale.setScalar(0.7);
  return {
    built,
    anchor: {
      id: station.id,
      kind: 'station',
      name: station.name,
      ...(station.sky === undefined ? {} : { caption: stationCaption(station.sky, station.live) }),
      systemId: station.systemId,
      object: built.object,
      radius: 0.6,
    },
  };
}

/** The shared context of one scene: the clock, the haze, the soft sprites and the textures that go with it. */
export function createSceneContext(
  fogRange: readonly [number, number],
  pixelRatio: number,
  paintCache: PaintCache = new Map(),
): { readonly context: SceneContext; readonly textures: THREE.Texture[] } {
  const textures: THREE.Texture[] = [];
  const trackTexture = (image: PixelImage): THREE.DataTexture => {
    const texture = pixelTexture(image);
    textures.push(texture);
    return texture;
  };
  const context: SceneContext = {
    time: { value: 0 },
    pixelRatio: { value: pixelRatio },
    fog: new THREE.Vector2(fogRange[0], fogRange[1]),
    calm: false,
    sprites: createSpriteTextures(trackTexture),
    trackTexture,
    paintCache,
  };
  return { context, textures };
}

/**
 * Builds the scene of a space view from its definition: stars, systems with their suns, haze and
 * revolving planets, stations, a parked ship and clouds of dust. Nothing here talks to the GPU until
 * a renderer draws it. There are no lines of any kind (D-074).
 */
export function buildSpace(
  definition: SpaceDefinition,
  aspect: number,
  pixelRatio: number,
  paintCache: PaintCache = new Map(),
): BuiltSpace {
  const { context, textures } = createSceneContext(definition.camera.fogRange, pixelRatio, paintCache);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, aspect, 0.1, 3000);
  addSky(scene, 'sky', context, new THREE.Vector3(...definition.camera.position));

  const ticks: ((t: number) => void)[] = [];
  const anchors: WorldAnchor[] = [];
  const picks = new Map<string, THREE.Sprite>();
  /** What belongs to each system (or dust cloud), so a System view can show one alone. */
  const belongings = new Map<string, THREE.Object3D[]>();
  const planetBodies = new Map<string, PlanetBody>();
  const suns = new Map<string, { readonly built: BuiltSun; readonly position: THREE.Vector3 }>();
  const shipsOf: { planetId: string; ship: Built }[] = [];
  for (const system of definition.systems) {
    const {
      built,
      sun,
      bodies,
      ships,
      anchors: systemAnchors,
      picks: systemPicks,
    } = buildSystem(system, context, definition.shipPlanetId);
    suns.set(system.id, { built: sun, position: new THREE.Vector3(system.position.x, 0, system.position.z) });
    for (const body of bodies) planetBodies.set(body.id, body);
    shipsOf.push(...ships);
    scene.add(built.object);
    ticks.push(built.tick);
    anchors.push(...systemAnchors);
    for (const [id, sprite] of systemPicks) picks.set(id, sprite);
    belongings.set(system.id, [built.object]);
  }
  const systemsById = new Map(definition.systems.map((system) => [system.id, system]));
  for (const station of definition.stations ?? []) {
    const { built, anchor } = buildStation(station, systemsById, context);
    scene.add(built.object);
    ticks.push(built.tick);
    anchors.push(anchor);
    belongings.get(station.systemId)?.push(built.object);
  }
  for (const dust of definition.dust ?? []) {
    const nebula = makeNebula(dust.radius, dust.dots, dust.id, context, dust.dots > 2000 ? 22 : 8);
    nebula.object.position.set(dust.position.x, dust.position.y, dust.position.z);
    scene.add(nebula.object);
    ticks.push(nebula.tick);
    anchors.push({ id: dust.id, kind: 'dust', name: '', systemId: null, object: nebula.object, radius: dust.radius });
    belongings.set(dust.id, [nebula.object]);
  }

  const light = new THREE.Vector3();
  const rocket: Rocket = makeRocket(context, light);
  scene.add(rocket.object);
  const place = new THREE.Vector3();
  const script: SceneScripting = {
    planet: (id) => planetBodies.get(id),
    sun: (systemId) => suns.get(systemId)?.position.clone(),
    dock(systemId) {
      const own = [...planetBodies.values()].filter((body) => body.systemId === systemId);
      const parked = own.find((body) => body.id === definition.shipPlanetId);
      const body = parked ?? own[0];
      if (body === undefined) return undefined;
      body.object.updateWorldMatrix(true, false);
      // The same spot the parked ship rides at, beside and above the planet.
      return {
        planetId: body.id,
        position: body.object.localToWorld(place.set(body.radius * 1.45, body.radius * 1.5, 0)).clone(),
      };
    },
    rocket(pose, t) {
      if (pose === undefined) {
        rocket.object.visible = false;
        return;
      }
      // A key light up and to the left of the camera, so the ship always reads.
      light.copy(camera.localToWorld(place.set(-2.3, 2.75, 2.3)));
      rocket.set(pose, t);
    },
    shipScale(amount) {
      for (const { ship } of shipsOf) {
        ship.object.visible = amount > 0.001;
        ship.object.scale.setScalar(Math.max(amount, 0.001));
      }
    },
    closeUp(planetId, state) {
      const body = planetBodies.get(planetId);
      if (body === undefined) return;
      body.planet.setAtmosphere(state?.atmosphere ?? 1.15);
      suns.get(body.systemId)?.built.setCloseUp(state?.sunBloom ?? 1, state?.sunGlow ?? 1);
    },
    handOver: (planetId, handover) => planetBodies.get(planetId)?.planet.handOver(handover),
  };

  return {
    scene,
    camera,
    pixelRatio: context.pixelRatio,
    anchors,
    script,
    poseAt(t) {
      context.time.value = t;
      for (const tick of ticks) tick(t);
    },
    setCamera(pose) {
      camera.position.set(...pose.position);
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
      camera.lookAt(new THREE.Vector3(...pose.target));
      const distance = distanceOf(pose);
      context.fog.set(distance, distance * 2.2);
    },
    showOnly(systemId) {
      for (const [id, objects] of belongings)
        for (const object of objects) object.visible = systemId === null || id === systemId;
    },
    highlight(pickedId) {
      for (const [id, sprite] of picks) sprite.visible = id === pickedId;
    },
    dispose() {
      scene.traverse((node) => {
        const drawable = node as Partial<THREE.Mesh>;
        drawable.geometry?.dispose();
        const material = drawable.material;
        for (const entry of Array.isArray(material) ? material : material ? [material] : []) entry.dispose();
      });
      for (const texture of textures) texture.dispose();
    },
  };
}
