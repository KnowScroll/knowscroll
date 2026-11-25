/**
 * Where each place stands for the camera: a chain of links, one per place the target is in (its planet, its star, the
 * whole universe), each a point to look at and how far away to look from. A flight moves along two chains
 * (`flight.ts`); a stop is a distance on its own chain. Pure and free of three.js: the driver hands it the live
 * positions it needs.
 */
import { distanceOf, FIELD_OF_VIEW, rigPose, type RigFocus, type Vec3 } from '../space/camera-rig';
import type { Chain } from './flight';
import type { VoyageTarget } from './ladder';

/** A width and a height, in layout points. */
export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A star is seen from farther than the map's System view framed it: in the prototype its sun is a small bright ball
 * with its planets round it, not a disc filling a third of the screen.
 */
export const STAR_DISTANCE_SCALE = 1.6;
/*
 * How the camera distances of a planet and of its ground follow from the screen: the prototype's `DPL` and `DSF`, with
 * `WMIN = min(width, 0.62 * height)`. From orbit the globe is 0.36 of `WMIN` across in radius, `F * RP / (0.36 * WMIN)`;
 * on the ground it spans `RSF = max(1.25 * WMIN, 0.54 * diagonal)`.
 */
/** The share of `WMIN` that a planet's radius spans from orbit. */
const ORBIT_RADIUS_SHARE = 0.36;
/** The share of the view's height that `WMIN` allows (the prototype's `0.62 * H`). */
const SHORT_SIDE_OF_HEIGHT = 0.62;
/** On the ground the planet spans this many `WMIN` ... */
const GROUND_SHORT_SIDES = 1.25;
/** ... or this share of the view's diagonal, whichever is more. */
const GROUND_DIAGONALS = 0.54;
/** Each link of a chain is at least this much farther than the one before it. */
const LINK_GROWTH = 1.25;

const TAN_HALF_FOV = Math.tan(((FIELD_OF_VIEW / 2) * Math.PI) / 180);

/** Pixels on screen for one scene unit at one unit of distance: the camera's focal length in layout points. */
export const focalOf = (size: { readonly height: number }): number => size.height / 2 / TAN_HALF_FOV;

/**
 * The camera distances of a planet and of the ground for a planet of `radius`, after the prototype: from orbit the
 * globe is {@link ORBIT_RADIUS_SHARE} of the short side across in radius; on the ground it is larger than the screen.
 */
export function planetDistances(radius: number, size: ViewSize): { readonly planet: number; readonly ground: number } {
  const focal = focalOf(size);
  const short = Math.min(size.width, SHORT_SIDE_OF_HEIGHT * size.height);
  const ground = Math.max(GROUND_SHORT_SIDES * short, GROUND_DIAGONALS * Math.hypot(size.width, size.height));
  return { planet: (focal * radius) / (ORBIT_RADIUS_SHARE * short), ground: (focal * radius) / ground };
}

/** The id of the whole universe in a chain's `ids`: the last place of every chain. */
export const UNIVERSE_ID = 'universe';

/** A link per place the chain passes through, with ids so two chains can be compared. */
export interface PlacedChain {
  /** The places of the chain, innermost first; the last is always {@link UNIVERSE_ID}. */
  readonly ids: readonly string[];
  readonly chain: Chain;
  /** How far from its first place the camera stands at the target's stop. */
  readonly stopDistance: number;
  /** The radius of the target's planet, when the chain holds one. */
  readonly planetRadius: number | null;
}

/** What a chain needs to know of the scene: where the whole universe, a star and a planet are. */
export interface ChainPlaces {
  readonly universeFocus: Extract<RigFocus, { kind: 'universe' }>;
  readonly systemFocus: (systemId: string) => Extract<RigFocus, { kind: 'system' }> | undefined;
  /** A planet's position now (it orbits) and its radius, in scene units; undefined for one the scene does not hold. */
  readonly planetAt: (planetId: string) => { readonly position: Vec3; readonly radius: number } | undefined;
}

/** Makes every link farther than the one before, so the focus never has to move along a link of no length. */
export function increasing(chain: Chain): Chain {
  const result: { distance: number; point: Vec3 }[] = [];
  for (const link of chain) {
    const floor = result.length === 0 ? 0 : result[result.length - 1]!.distance * LINK_GROWTH;
    result.push({ distance: Math.max(link.distance, floor), point: link.point });
  }
  return result;
}

const CENTRED = { x: 0, y: 0, scale: 1 } as const;

/**
 * The chain of a target: its planet (if any), its star (if any) and the whole universe, with how far from the first the
 * camera stands at the target's stop. A place the scene does not hold ends the chain at the place above it.
 */
export function chainOf(target: VoyageTarget, places: ChainPlaces, size: ViewSize): PlacedChain {
  const universe = rigPose({ focus: places.universeFocus, frame: CENTRED, ...size });
  const universeLink = { distance: distanceOf(universe), point: universe.target };
  const systemFocus = target.systemId === null ? undefined : places.systemFocus(target.systemId);
  if (target.stop === 'universe' || systemFocus === undefined || target.systemId === null)
    return { ids: [UNIVERSE_ID], chain: [universeLink], stopDistance: universeLink.distance, planetRadius: null };
  const system = rigPose({ focus: systemFocus, frame: CENTRED, ...size });
  const systemLink = { distance: distanceOf(system) * STAR_DISTANCE_SCALE, point: system.target };
  const planet = target.planetId === null ? undefined : places.planetAt(target.planetId);
  if (target.stop === 'star' || planet === undefined || target.planetId === null)
    return {
      ids: [target.systemId, UNIVERSE_ID],
      chain: increasing([systemLink, universeLink]),
      stopDistance: systemLink.distance,
      planetRadius: null,
    };
  const distances = planetDistances(planet.radius, size);
  const chain = increasing([{ distance: distances.planet, point: planet.position }, systemLink, universeLink]);
  return {
    ids: [target.planetId, target.systemId, UNIVERSE_ID],
    chain,
    stopDistance: target.stop === 'ground' ? distances.ground : chain[0]!.distance,
    planetRadius: planet.radius,
  };
}

/**
 * The distance of the first place both chains hold, when neither end holds the other: a flight between two places of
 * one star climbs to that star's distance and comes down again. Null when one end is inside the other.
 */
export function peakOf(from: PlacedChain, to: PlacedChain): number | null {
  if (to.ids.includes(from.ids[0]!) || from.ids.includes(to.ids[0]!)) return null;
  const shared = to.ids.findIndex((id) => from.ids.includes(id));
  return shared < 0 ? null : to.chain[shared]!.distance;
}
