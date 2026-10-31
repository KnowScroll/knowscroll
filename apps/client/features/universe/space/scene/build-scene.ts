import * as THREE from 'three';
import type { PixelImage } from '../texture-data';
import { distanceOf, FIELD_OF_VIEW, type CameraPose } from '../camera-rig';
import { planetGenome } from '../planet-genome';
import type { SpaceDefinition, SpaceStationDefinition, SpaceSystemDefinition } from '../space-definition';
import { createSpriteTextures, pixelTexture, type Built, type PaintCache, type SceneContext } from './context';
import { makeHalo } from './halo';
import { makeNebula } from './nebula';
import { makePlanet } from './planet';
import { makeShip, makeStation } from './props';
import { addSky } from './sky';
import { makeSun } from './sun';

/** A point of the scene that a label or tap target follows. */
export interface WorldAnchor {
  readonly id: string;
  readonly kind: 'system' | 'planet' | 'station' | 'dust';
  readonly name: string;
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
  /** Pulses a warm glow around one system (the one picked on the Far level), or none. */
  readonly highlight: (systemId: string | null) => void;
  /** Releases textures, geometries and materials. */
  readonly dispose: () => void;
}

/** Angular speed of a planet: inner planets turn faster. */
function orbitSpeed(system: SpaceSystemDefinition, orbitRadius: number): number {
  const innermost = Math.min(...system.planets.map((planet) => planet.orbitRadius));
  return system.speed * Math.pow(innermost / orbitRadius, system.orbitFalloff);
}

interface SystemBuild {
  readonly built: Built;
  readonly anchors: WorldAnchor[];
  readonly pick: THREE.Sprite;
}

/** The ship rides on its planet, a little above and beside it, sized to the planet it parks at. */
function parkShip(planet: THREE.Object3D, planetRadius: number, sun: THREE.Vector3, context: SceneContext): Built {
  const ship = makeShip(context, sun, (planetRadius / 0.3) * 0.75);
  ship.object.position.set(planetRadius * 1.45, planetRadius * 1.5, 0);
  planet.add(ship.object);
  return ship;
}

function buildSystem(
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
  const pick = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      color: new THREE.Color(1, 0.9, 0.35),
      opacity: 0,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  pick.visible = false;
  group.add(pick);
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
  const ships: Built[] = [];

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
    anchors.push({
      id: definition.id,
      kind: 'planet',
      name: definition.name,
      systemId: system.id,
      object: planet.object,
      radius,
    });
    if (definition.id === shipPlanetId) ships.push(parkShip(planet.object, radius, sunPosition, scoped));
    return { definition, planet, pivot, speed: orbitSpeed(system, definition.orbitRadius) };
  });

  const tick = (t: number): void => {
    sun.tick(t);
    for (const { definition, planet, pivot, speed } of orbiting) {
      pivot.rotation.y = -(definition.startAngle + t * speed);
      planet.tick(t);
    }
    for (const ship of ships) ship.tick(t);
    if (pick.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
      pick.scale.setScalar(outer * (0.9 + 0.25 * pulse));
      pick.material.opacity = 0.3 + 0.3 * pulse;
    }
  };
  tick(0);
  return { built: { object: group, tick }, anchors, pick };
}

function buildStation(
  station: SpaceStationDefinition,
  systems: ReadonlyMap<string, SpaceSystemDefinition>,
  context: SceneContext,
): { built: Built; anchor: WorldAnchor } {
  const home = systems.get(station.systemId);
  const sun = new THREE.Vector3(home?.position.x ?? 0, 0, home?.position.z ?? 0);
  const built = makeStation({ ...context, calm: station.calm === true }, sun, station.emblem);
  built.object.position.set(station.position.x, station.position.y, station.position.z);
  // Stations are small beside a sun: they are a doorway, not a place.
  built.object.scale.setScalar(0.7);
  return {
    built,
    anchor: {
      id: station.id,
      kind: 'station',
      name: station.name,
      systemId: station.systemId,
      object: built.object,
      radius: 0.6,
    },
  };
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
  const textures: THREE.Texture[] = [];
  const trackTexture = (image: PixelImage): THREE.DataTexture => {
    const texture = pixelTexture(image);
    textures.push(texture);
    return texture;
  };
  const context: SceneContext = {
    time: { value: 0 },
    pixelRatio: { value: pixelRatio },
    fog: new THREE.Vector2(definition.camera.fogRange[0], definition.camera.fogRange[1]),
    calm: false,
    sprites: createSpriteTextures(trackTexture),
    trackTexture,
    paintCache,
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, aspect, 0.1, 3000);
  addSky(scene, 'sky', context, new THREE.Vector3(...definition.camera.position));

  const ticks: ((t: number) => void)[] = [];
  const anchors: WorldAnchor[] = [];
  const picks = new Map<string, THREE.Sprite>();
  /** What belongs to each system (or dust cloud), so a System view can show one alone. */
  const belongings = new Map<string, THREE.Object3D[]>();
  for (const system of definition.systems) {
    const { built, anchors: systemAnchors, pick } = buildSystem(system, context, definition.shipPlanetId);
    scene.add(built.object);
    ticks.push(built.tick);
    anchors.push(...systemAnchors);
    picks.set(system.id, pick);
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

  return {
    scene,
    camera,
    pixelRatio: context.pixelRatio,
    anchors,
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
    highlight(systemId) {
      for (const [id, sprite] of picks) sprite.visible = id === systemId;
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
