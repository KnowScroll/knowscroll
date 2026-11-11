import * as THREE from 'three';
import { stationCaption, stationMapCaption } from '@knowscroll/client-core';
import type { PixelImage } from '../texture-data';
import { distanceOf, FIELD_OF_VIEW, type CameraPose } from '../camera-rig';
import { planetGenome } from '../planet-genome';
import type { SpaceDefinition, SpaceStationDefinition, SpaceSystemDefinition } from '../space-definition';
import { chooseDetail, drawsEverything, type SystemPlaces } from '../detail-set';
import { createSpriteTextures, pixelTexture, type Built, type PaintCache, type SceneContext } from './context';
import { makeFarField, type FarField } from './far-field';
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
  /** A station's label on the map: its count and what is live, without the constellation's name; absent where `caption` is. */
  readonly mapCaption?: string;
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
  /**
   * The named points of the bodies built in full: their suns, planets, stations and dust. A map at scale builds only
   * the systems in {@link BuiltSpace.detail}; the rest are in {@link BuiltSpace.places}.
   */
  readonly anchors: readonly WorldAnchor[];
  /** Every system of the definition and where it stands, in definition order, built in full or not. */
  readonly places: SystemPlaces & { readonly names: readonly string[]; readonly calm: ReadonlySet<string> };
  /** The ids of the systems built in full now. */
  readonly detail: ReadonlySet<string>;
  /** More systems than a frame can draw in full: the rest are the far field (D-417). */
  readonly scaled: boolean;
  /**
   * Moves the systems built in full toward `wanted` (a map at scale only): the ones that left are removed and their
   * geometries, materials and textures released, and at most `builds` of the newcomers are built. Returns whether the
   * set built changed.
   */
  readonly setDetail: (wanted: ReadonlySet<string>, builds?: number) => boolean;
  /**
   * Brings a map at scale to a new definition without building the scene again: only the systems whose own
   * definition changed are built again, and the far field is renewed.
   */
  readonly update: (definition: SpaceDefinition) => void;
  /** Poses the whole scene at time `t`. Calling it twice with the same `t` gives the same picture. */
  readonly poseAt: (t: number) => void;
  /** Puts the camera at `pose` and tunes the haze to its distance. */
  readonly setCamera: (pose: CameraPose) => void;
  /** Tells the far field how tall the view is, so its points have the size of the suns they stand for. */
  readonly setViewHeight: (heightPx: number) => void;
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
      ...(station.sky === undefined
        ? {}
        : {
            caption: stationCaption(station.sky, station.live),
            mapCaption: stationMapCaption(station.sky, station.live),
          }),
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
 * Releases the geometries and materials of everything under `root`. Textures are released by whoever tracked them.
 * Every sprite of three.js shares one four-corner geometry: it is released with the whole scene, not with one system.
 */
function disposeTree(root: THREE.Object3D, wholeScene = false): void {
  root.traverse((node) => {
    const drawable = node as Partial<THREE.Mesh>;
    if (wholeScene || !(node as THREE.Sprite).isSprite) drawable.geometry?.dispose();
    const material = drawable.material;
    for (const entry of Array.isArray(material) ? material : material ? [material] : []) entry.dispose();
  });
}

/** What one system built in full owns, so that it can be taken out of the scene again whole. */
interface LiveSystem {
  readonly id: string;
  /** The definition it was built from, as text: a changed one is built again. */
  readonly signature: string;
  readonly build: SystemBuild;
  readonly stations: readonly { readonly built: Built; readonly anchor: WorldAnchor }[];
  readonly textures: THREE.Texture[];
}

const signatureOf = (system: SpaceSystemDefinition, definition: SpaceDefinition): string =>
  JSON.stringify([
    system,
    (definition.stations ?? []).filter((station) => station.systemId === system.id),
    system.planets.some((planet) => planet.id === definition.shipPlanetId) ? definition.shipPlanetId : '',
  ]);

/** The system the parked ship is in, when its planet is known. */
function shipSystemOf(definition: SpaceDefinition): string | undefined {
  if (definition.shipPlanetId === undefined) return undefined;
  return definition.systems.find((system) => system.planets.some((planet) => planet.id === definition.shipPlanetId))
    ?.id;
}

/**
 * Builds the scene of a space view from its definition: stars, systems with their suns, haze and
 * revolving planets, stations, a parked ship and clouds of dust. Nothing here talks to the GPU until
 * a renderer draws it. There are no lines of any kind (D-074).
 *
 * A definition of {@link DETAIL_MAX} systems or fewer is built whole, as ever. A map at scale (D-417) is built for
 * the systems in `initialDetail` (the nearest to the camera's target when it is not given); every other system is
 * a point of the far field until {@link BuiltSpace.setDetail} brings it into detail.
 */
export function buildSpace(
  initial: SpaceDefinition,
  aspect: number,
  pixelRatio: number,
  paintCache: PaintCache = new Map(),
  initialDetail?: ReadonlySet<string>,
): BuiltSpace {
  let definition = initial;
  const { context, textures } = createSceneContext(definition.camera.fogRange, pixelRatio, paintCache);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, aspect, 0.1, MIN_FAR);
  // The stars are shells around the middle of the map; for a map larger than they are, they travel with the camera.
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);
  addSky(skyGroup, 'sky', context, new THREE.Vector3(...definition.camera.position));

  /** The system, station and dust ticks that pose the scene, by what owns them. */
  const live = new Map<string, LiveSystem>();
  const dustTicks = new Map<string, (t: number) => void>();
  const dustObjects = new Map<string, THREE.Object3D>();
  /** What belongs to each system (or dust cloud), so a System view can show one alone. */
  const belongings = new Map<string, THREE.Object3D[]>();
  let anchorList: WorldAnchor[] = [];
  let highlighted: string | null = null;
  let only: string | null = null;
  let heightPx = 640;
  let fov: number = FIELD_OF_VIEW;
  let places = placesOf(definition);
  let systemsById = new Map(definition.systems.map((system) => [system.id, system]));
  let far: FarField | undefined;
  let scaled = !drawsEverything(definition.systems.length);

  const shownNow = (id: string): boolean => only === null || only === id;

  /** Builds one system in full, with its stations, and adds it to the scene. */
  const bringIn = (system: SpaceSystemDefinition): void => {
    const own: THREE.Texture[] = [];
    const scoped: SceneContext = {
      ...context,
      trackTexture: (image) => {
        const texture = pixelTexture(image);
        own.push(texture);
        return texture;
      },
    };
    const build = buildSystem(system, scoped, definition.shipPlanetId);
    const stations = (definition.stations ?? [])
      .filter((station) => station.systemId === system.id)
      .map((station) => buildStation(station, systemsById, scoped));
    scene.add(build.built.object);
    for (const { built } of stations) scene.add(built.object);
    const objects = [build.built.object, ...stations.map(({ built }) => built.object)];
    for (const object of objects) object.visible = shownNow(system.id);
    belongings.set(system.id, objects);
    for (const [id, sprite] of build.picks) sprite.visible = id === highlighted;
    live.set(system.id, { id: system.id, signature: signatureOf(system, definition), build, stations, textures: own });
  };

  /** Takes a system out of the scene and releases everything it built. */
  const takeOut = (id: string): void => {
    const record = live.get(id);
    if (record === undefined) return;
    for (const object of belongings.get(id) ?? []) {
      scene.remove(object);
      disposeTree(object);
    }
    for (const texture of record.textures) texture.dispose();
    belongings.delete(id);
    live.delete(id);
  };

  const refreshAnchors = (): void => {
    const next: WorldAnchor[] = [];
    // Definition order, so the anchors of a map built whole are the ones it always had.
    for (const system of definition.systems) {
      const record = live.get(system.id);
      if (record !== undefined) next.push(...record.build.anchors);
    }
    for (const station of definition.stations ?? []) {
      const owner = live.get(station.systemId);
      const found = owner?.stations.find(({ anchor }) => anchor.id === station.id);
      if (found !== undefined) next.push(found.anchor);
    }
    for (const dust of definition.dust ?? []) {
      const object = dustObjects.get(dust.id);
      if (object !== undefined)
        next.push({ id: dust.id, kind: 'dust', name: '', systemId: null, object, radius: dust.radius });
    }
    anchorList = next;
  };

  const buildDust = (): void => {
    for (const [id, object] of dustObjects) {
      scene.remove(object);
      disposeTree(object);
      belongings.delete(id);
    }
    dustObjects.clear();
    dustTicks.clear();
    for (const dust of definition.dust ?? []) {
      const nebula = makeNebula(dust.radius, dust.dots, dust.id, context, dust.dots > 2000 ? 22 : 8);
      nebula.object.position.set(dust.position.x, dust.position.y, dust.position.z);
      scene.add(nebula.object);
      dustTicks.set(dust.id, nebula.tick);
      dustObjects.set(dust.id, nebula.object);
      belongings.set(dust.id, [nebula.object]);
    }
  };

  const buildFar = (): void => {
    if (far !== undefined) {
      scene.remove(far.object);
      far.dispose();
      far = undefined;
    }
    if (!scaled) return;
    far = makeFarField(
      definition.systems.map((system) => ({
        id: system.id,
        x: system.position.x,
        z: system.position.z,
        family: system.family,
        calm: system.calm === true,
      })),
      context,
    );
    far.setView(heightPx, fov);
    far.object.visible = only === null;
    scene.add(far.object);
    far.hide(new Set(live.keys()));
  };

  // The systems built first: all of a small map, the ones nearest the camera's target of a map at scale.
  const target = definition.camera.target;
  const first = scaled
    ? (initialDetail ??
      chooseDetail({
        places,
        target: { x: target[0], z: target[2] },
        pinned: new Set(shipSystemOf(definition) === undefined ? [] : [shipSystemOf(definition)!]),
        previous: new Set(),
      }))
    : new Set(definition.systems.map((system) => system.id));
  for (const system of definition.systems) if (first.has(system.id)) bringIn(system);
  buildDust();
  buildFar();
  refreshAnchors();

  const light = new THREE.Vector3();
  const rocket: Rocket = makeRocket(context, light);
  scene.add(rocket.object);
  const place = new THREE.Vector3();
  const positionOf = (systemId: string): THREE.Vector3 | undefined => {
    const system = systemsById.get(systemId);
    return system === undefined ? undefined : new THREE.Vector3(system.position.x, 0, system.position.z);
  };
  const bodyOf = (id: string): PlanetBody | undefined => {
    for (const record of live.values()) {
      const found = record.build.bodies.find((body) => body.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const script: SceneScripting = {
    planet: bodyOf,
    sun: (systemId) => positionOf(systemId),
    dock(systemId) {
      const own = live.get(systemId)?.build.bodies ?? [];
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
      for (const { build } of live.values())
        for (const { ship } of build.ships) {
          ship.object.visible = amount > 0.001;
          ship.object.scale.setScalar(Math.max(amount, 0.001));
        }
    },
    closeUp(planetId, state) {
      const body = bodyOf(planetId);
      if (body === undefined) return;
      body.planet.setAtmosphere(state?.atmosphere ?? 1.15);
      live.get(body.systemId)?.build.sun.setCloseUp(state?.sunBloom ?? 1, state?.sunGlow ?? 1);
    },
    handOver: (planetId, handover) => bodyOf(planetId)?.planet.handOver(handover),
  };

  return {
    scene,
    camera,
    pixelRatio: context.pixelRatio,
    get anchors() {
      return anchorList;
    },
    get places() {
      return places;
    },
    get detail() {
      return new Set(live.keys());
    },
    get scaled() {
      return scaled;
    },
    script,
    setDetail(wanted, builds = Infinity) {
      if (!scaled) return false;
      let changed = false;
      for (const id of [...live.keys()])
        if (!wanted.has(id)) {
          takeOut(id);
          changed = true;
        }
      let built = 0;
      for (const system of definition.systems) {
        if (built >= builds) break;
        if (!wanted.has(system.id) || live.has(system.id)) continue;
        bringIn(system);
        built += 1;
        changed = true;
      }
      if (changed) {
        far?.hide(new Set(live.keys()));
        refreshAnchors();
      }
      return changed;
    },
    update(next) {
      definition = next;
      systemsById = new Map(next.systems.map((system) => [system.id, system]));
      places = placesOf(next);
      scaled = !drawsEverything(next.systems.length);
      for (const id of [...live.keys()]) {
        const system = systemsById.get(id);
        if (system === undefined || live.get(id)!.signature !== signatureOf(system, next)) {
          takeOut(id);
          if (system !== undefined) bringIn(system);
        }
      }
      buildDust();
      buildFar();
      refreshAnchors();
    },
    poseAt(t) {
      context.time.value = t;
      for (const record of live.values()) {
        record.build.built.tick(t);
        for (const { built } of record.stations) built.tick(t);
      }
      for (const tick of dustTicks.values()) tick(t);
    },
    setCamera(pose) {
      camera.position.set(...pose.position);
      camera.fov = pose.fov;
      fov = pose.fov;
      const distance = distanceOf(pose);
      // A map larger than the camera's default reach needs a deeper view, and stars that stay around it.
      camera.far = Math.max(MIN_FAR, distance * 4);
      camera.updateProjectionMatrix();
      camera.lookAt(new THREE.Vector3(...pose.target));
      const out = Math.hypot(...pose.position);
      const follow = out > SKY_FOLLOWS_FROM ? (out - SKY_FOLLOWS_FROM) / out : 0;
      skyGroup.position.set(pose.position[0] * follow, pose.position[1] * follow, pose.position[2] * follow);
      context.fog.set(distance, distance * 2.2);
      far?.setView(heightPx, pose.fov);
    },
    setViewHeight(height) {
      heightPx = height;
      far?.setView(heightPx, fov);
    },
    showOnly(systemId) {
      only = systemId;
      for (const [id, objects] of belongings)
        for (const object of objects) object.visible = systemId === null || id === systemId;
      if (far !== undefined) far.object.visible = systemId === null;
    },
    highlight(pickedId) {
      highlighted = pickedId;
      for (const { build } of live.values()) for (const [id, sprite] of build.picks) sprite.visible = id === pickedId;
    },
    dispose() {
      disposeTree(scene, true);
      for (const texture of textures) texture.dispose();
      for (const record of live.values()) for (const texture of record.textures) texture.dispose();
      live.clear();
    },
  };
}

/** The far plane of the camera at rest; a map larger than this deepens it. */
const MIN_FAR = 3000;
/** The stars stay put until the camera is this far from the middle of the map, then travel with it. */
const SKY_FOLLOWS_FROM = 250;

/** Where every system of a definition stands, as parallel arrays, so thousands are cheap to scan. */
function placesOf(definition: SpaceDefinition): BuiltSpace['places'] {
  const ids: string[] = [];
  const names: string[] = [];
  const x = new Float32Array(definition.systems.length);
  const z = new Float32Array(definition.systems.length);
  const calm = new Set<string>();
  definition.systems.forEach((system, at) => {
    ids.push(system.id);
    names.push(system.name);
    x[at] = system.position.x;
    z[at] = system.position.z;
    if (system.calm === true) calm.add(system.id);
  });
  return { ids, names, x, z, calm };
}
