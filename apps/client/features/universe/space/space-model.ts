import type { RoomStation } from '@knowscroll/contracts';
import type { PlanetLook, SceneDescriptor, SceneLook } from '@knowscroll/scene-core';
import type { RigFocus } from './camera-rig';
import { seededRandom } from './paint';
import type { HazeFamily, PlanetType } from './planet-genome';
import type {
  SpaceDefinition,
  SpaceDustDefinition,
  SpacePlanetDefinition,
  SpaceStationDefinition,
  SpaceSystemDefinition,
} from './space-definition';
import { isQuiet, type UniverseIndex } from '../universe-layout';

/**
 * What the Universe's space views draw, worked out from the places the server projected. Pure: no
 * React, no GPU, no clock. Every position comes from a persisted anchor and a seed, never from how
 * many places there are, how recent they are or how much was read, so a place keeps its spot when
 * others arrive and size never encodes reading (D-006 m).
 *
 * The *look* (planet type, hue, rings, moon, system haze) is the server's, given once (D-102, D-103).
 * This file only places and sizes; it never picks a look. A place the server has not given a look
 * to (a friend's visit, a world not backfilled yet) is drawn with the plain look at the bottom.
 */

/** Scene units between two lattice slots (the projector's slots are 300 world units apart). */
const SLOT_UNITS = 3.2;
const LATTICE = 300;
/** Decorative wander of a system off its slot, in scene units, from its own seed. */
const SYSTEM_JITTER = 0.7;
const INNER_ORBIT = 1.5;
const ORBIT_STEP = 0.65;
const ORBIT_WOBBLE = 0.3;
const STATION_CLEARANCE = 1.1;
const DEFAULT_SPEED = 0.1;

/** The looks a screen draws: the server's, from the scene read (D-102), or a friend's, derived on this device (D-114). */
export function looksOfState(state: {
  readonly looks?: readonly SceneLook[];
  readonly read: { readonly snapshot?: { readonly read: { readonly looks?: readonly SceneLook[] } } };
}): readonly SceneLook[] | undefined {
  return state.looks ?? state.read.snapshot?.read.looks;
}

/** The looks of a read, by object id. */
export function looksById(looks: readonly SceneLook[] | undefined): ReadonlyMap<string, SceneLook> {
  return new Map((looks ?? []).map((look) => [look.objectId, look]));
}

/** The plain colour set a palette stands for, for a place that has no look yet. */
export const PLAIN_TYPE: Readonly<Record<SceneDescriptor['palette'], PlanetType>> = {
  sage: 'lush',
  ochre: 'barren',
  cobalt: 'ocean',
};
const PLAIN_HAZE: HazeFamily = 'teal';

const unit = (seed: string, salt: string): number => seededRandom(seed + salt)();

function planetLookOf(
  descriptor: SceneDescriptor,
  looks: ReadonlyMap<string, SceneLook>,
): Pick<SpacePlanetDefinition, 'type' | 'rings' | 'moon' | 'hueShift' | 'variant'> {
  const look = looks.get(descriptor.objectId);
  if (look?.kind === 'planet') {
    const planet: PlanetLook = look;
    return {
      type: planet.type,
      rings: planet.rings,
      moon: planet.moon,
      hueShift: planet.hueShift,
      variant: planet.variant,
    };
  }
  return { type: PLAIN_TYPE[descriptor.palette], hueShift: 0 };
}

function hazeOf(system: SceneDescriptor, looks: ReadonlyMap<string, SceneLook>): HazeFamily {
  const look = looks.get(system.objectId);
  return look?.kind === 'system' ? look.haze : PLAIN_HAZE;
}

const planeDistance = (from: { x: number; y: number }, to: { x: number; y: number }): number =>
  Math.hypot(from.x - to.x, from.y - to.y);

/** A planet sits on the orbit whose band matches its distance from the star on the lattice. */
function bandOf(distance: number): 0 | 1 | 2 {
  return distance < LATTICE * 1.2 ? 0 : distance < LATTICE * 2.4 ? 1 : 2;
}

function placePlanet(
  planet: SceneDescriptor,
  origin: { x: number; y: number },
  lately: boolean,
  looks: ReadonlyMap<string, SceneLook>,
): SpacePlanetDefinition {
  const distance = planeDistance(planet.anchor, origin);
  const orbitRadius = INNER_ORBIT + bandOf(distance) * ORBIT_STEP + unit(planet.seed, 'orbit') * ORBIT_WOBBLE;
  return {
    id: planet.objectId,
    name: planet.label,
    orbitRadius,
    startAngle: Math.atan2(planet.anchor.y - origin.y, planet.anchor.x - origin.x),
    ...planetLookOf(planet, looks),
    ...(lately && isQuiet(planet) ? { calm: true } : {}),
  };
}

function placeSystem(
  system: SceneDescriptor,
  index: UniverseIndex,
  lately: boolean,
  looks: ReadonlyMap<string, SceneLook>,
): SpaceSystemDefinition {
  const star = index.stars.get(system.objectId);
  const origin = (star ?? system).anchor;
  const planets = (index.planets.get(system.objectId) ?? []).map((planet) =>
    placePlanet(planet, origin, lately, looks),
  );
  return {
    id: system.objectId,
    name: system.label,
    family: hazeOf(system, looks),
    position: {
      x: (system.anchor.x / LATTICE) * SLOT_UNITS + (unit(system.seed, 'x') - 0.5) * 2 * SYSTEM_JITTER,
      z: (system.anchor.y / LATTICE) * SLOT_UNITS + (unit(system.seed, 'z') - 0.5) * 2 * SYSTEM_JITTER,
    },
    // Size comes from the seed alone, never from activity (D-006 m).
    sunRadius: 0.7 + unit(system.seed, 'sun') * 0.14,
    planetRadius: 0.3,
    speed: DEFAULT_SPEED,
    orbitFalloff: 0.8,
    planets,
    ...(lately && isQuiet(system) ? { calm: true } : {}),
  };
}

const outerOrbitOf = (system: SpaceSystemDefinition): number =>
  Math.max(INNER_ORBIT, ...system.planets.map((planet) => planet.orbitRadius));

/** Where a station sits around its system, on the lower side so its name never meets the system's own. */
function placeStation(station: RoomStation, system: SpaceSystemDefinition, lately: boolean): SpaceStationDefinition {
  const hex = station.room.roomId.replaceAll('-', '');
  const share = Number.parseInt(hex.slice(20, 28), 16) / 0xffffffff;
  const angle = (24 + share * 132) * (Math.PI / 180);
  const planet = system.planets.find((candidate) => candidate.id === station.placement.planetId);
  const reach = (planet === undefined ? outerOrbitOf(system) : planet.orbitRadius) + STATION_CLEARANCE;
  return {
    id: station.room.roomId,
    name: station.room.name,
    systemId: system.id,
    ...(station.room.identity === undefined
      ? {}
      : { emblem: { emblem: station.room.identity.kit.emblem, palette: station.room.identity.kit.palette } }),
    ...(station.sky === undefined ? {} : { sky: station.sky }),
    ...(station.live === true ? { live: true } : {}),
    position: {
      x: system.position.x + Math.cos(angle) * reach,
      y: 0.6,
      z: system.position.z + Math.sin(angle) * reach,
    },
    ...(lately ? { calm: true } : {}),
  };
}

/** The centre and half extents of everything the whole-universe views must fit. */
function universeBounds(systems: readonly SpaceSystemDefinition[]): {
  center: { x: number; z: number };
  halfWidth: number;
  halfDepth: number;
} {
  if (systems.length === 0) return { center: { x: 0, z: 0 }, halfWidth: 6, halfDepth: 6 };
  const reach = (system: SpaceSystemDefinition): number => outerOrbitOf(system) + 1;
  const left = Math.min(...systems.map((system) => system.position.x - reach(system)));
  const right = Math.max(...systems.map((system) => system.position.x + reach(system)));
  const near = Math.min(...systems.map((system) => system.position.z - reach(system)));
  const far = Math.max(...systems.map((system) => system.position.z + reach(system)));
  return {
    center: { x: (left + right) / 2, z: (near + far) / 2 },
    halfWidth: Math.max((right - left) / 2, 6),
    halfDepth: Math.max((far - near) / 2, 6),
  };
}

/** Clouds of dust: one large cloud when nothing else exists (U01 Emerging), else small ones past the systems. */
function placeDust(
  cueIds: readonly string[],
  hasSystems: boolean,
  bounds: { center: { x: number; z: number }; halfWidth: number; halfDepth: number },
): readonly SpaceDustDefinition[] {
  const ids = [...cueIds].sort();
  if (ids.length === 1 && !hasSystems && ids[0] !== undefined)
    return [{ id: ids[0], position: { x: 0, y: 0, z: 0 }, radius: 4.6, dots: 4200 }];
  return ids.map((id) => {
    const angle = unit(id, 'angle') * Math.PI * 2;
    const reach = Math.max(bounds.halfWidth, bounds.halfDepth) + 4 + unit(id, 'reach') * 4;
    return {
      id,
      position: {
        x: bounds.center.x + Math.cos(angle) * reach,
        y: 0.5,
        z: bounds.center.z + Math.sin(angle) * reach * 0.8,
      },
      radius: 2.6,
      dots: 700,
    };
  });
}

/** The planet that holds the last place: itself, or the planet of a region. Nothing for a system. */
export function shipPlanetOf(index: UniverseIndex, lastPlaceId: string | undefined): string | undefined {
  const place = lastPlaceId === undefined ? undefined : index.byId.get(lastPlaceId);
  if (place?.kind === 'planet') return place.objectId;
  return place?.kind === 'region' ? place.parentId : undefined;
}

export interface UniverseSpaceInput {
  readonly index: UniverseIndex;
  readonly looks: ReadonlyMap<string, SceneLook>;
  readonly stations: readonly RoomStation[];
  readonly dustCueIds: readonly string[];
  /** The Lately lens: quiet places draw calm, and the ship is not shown. */
  readonly lately: boolean;
  readonly lastPlaceId: string | undefined;
}

/** What the space views need beyond the definition: where to aim the camera. */
export interface UniverseSpace {
  readonly definition: SpaceDefinition;
  readonly universeFocus: Extract<RigFocus, { kind: 'universe' }>;
  /** The focus of a System view, by system id. */
  readonly systemFocus: (systemId: string) => Extract<RigFocus, { kind: 'system' }> | undefined;
}

/** Lays out the whole universe in scene units, for the Overview, Far and every System view. */
export function layOutUniverse(input: UniverseSpaceInput): UniverseSpace {
  const { index, looks, lately } = input;
  const systems = index.systems.map((system) => placeSystem(system, index, lately, looks));
  const byId = new Map(systems.map((system) => [system.id, system]));
  const stations = input.stations.flatMap((station) => {
    const home = byId.get(station.placement.systemId);
    return home === undefined ? [] : [placeStation(station, home, lately)];
  });
  const bounds = universeBounds(systems);
  const shipPlanetId = lately ? undefined : shipPlanetOf(index, input.lastPlaceId);
  return {
    definition: {
      camera: { position: [0, 22, 46], target: [0, 0, 2], drift: 0.9, fogRange: [46, 105] },
      systems,
      stations,
      dust: placeDust(input.dustCueIds, systems.length > 0, bounds),
      ...(shipPlanetId === undefined ? {} : { shipPlanetId }),
    },
    universeFocus: {
      kind: 'universe',
      center: bounds.center,
      halfWidth: bounds.halfWidth,
      halfDepth: bounds.halfDepth,
    },
    systemFocus(systemId) {
      const system = byId.get(systemId);
      if (system === undefined) return undefined;
      const reach = Math.max(
        outerOrbitOf(system),
        ...stations
          .filter((station) => station.systemId === systemId)
          .map((station) => Math.hypot(station.position.x - system.position.x, station.position.z - system.position.z)),
      );
      return { kind: 'system', systemId, center: system.position, radius: reach + 1.2 };
    },
  };
}
