/**
 * Where each place stands for the camera: a chain of links, one per place the target is in (its planet, its star, the
 * whole universe), each a point to look at and how far away to look from. A flight moves along two chains
 * (`flight.ts`); a stop is a distance on its own chain. Pure and free of three.js: the driver hands it the live
 * positions it needs.
 */
import { distanceOf, FIELD_OF_VIEW, rigPose, type RigFocus, type Vec3 } from '../space/camera-rig';
import type { Chain } from './flight';
import { STOPS, type VoyageTarget } from './ladder';

/**
 * The band of the view, from `top` to `bottom` in layout points from the top, that a planet's globe seen from orbit must
 * lie in: between the header and the planet's caption. Given only where the usual place of the globe would not clear
 * the caption (a short phone, or one with a notice up).
 */
export interface GlobeRoom {
  readonly top: number;
  readonly bottom: number;
}

/** A width and a height, in layout points, and the room a planet's globe has when the screen says so. */
export interface ViewSize {
  readonly width: number;
  readonly height: number;
  readonly room?: GlobeRoom;
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
/**
 * A globe fitted to a room is never smaller than this radius on screen (pixels): it is fully drawn from here (the close
 * up's `GLOBE_FADE_TO_PX`), and its regions are still a few targets a finger can choose between.
 */
export const MIN_GLOBE_RADIUS_PX = 60;
/** The regions of a globe are named, and the ship goes round it, from this on-screen radius (pixels). */
export const GLOBE_NAMED_FROM_PX = 90;
/** On a globe fitted to a room, from this share of its radius: it is as big as it will get, and must not lose its names. */
const FITTED_NAMED_SHARE = 0.93;
/** Each link of a chain is at least this much farther than the one before it. */
const LINK_GROWTH = 1.25;

/**
 * The field of view on the ground, degrees: a longer lens than the sky's, so the land is seen nearly from above, at
 * close to the prototype's flat map's scale, and still curves away at the edges. The camera narrows to it as it falls
 * from the planet to the ground (`voyage-view.ts`, `fieldOfView`).
 */
export const GROUND_FIELD_OF_VIEW = 24;

/** Pixels on screen for one scene unit at one unit of distance: the camera's focal length in layout points. */
export const focalOf = (size: { readonly height: number }, fieldOfView = FIELD_OF_VIEW): number =>
  size.height / 2 / Math.tan(((fieldOfView / 2) * Math.PI) / 180);

/**
 * The camera distances of a planet and of the ground for a planet of `radius`, after the prototype: from orbit the
 * globe is {@link ORBIT_RADIUS_SHARE} of the short side across in radius; on the ground, seen through the ground's
 * longer lens, it is larger than the screen.
 */
export function planetDistances(radius: number, size: ViewSize): { readonly planet: number; readonly ground: number } {
  const short = Math.min(size.width, SHORT_SIDE_OF_HEIGHT * size.height);
  const ground = Math.max(GROUND_SHORT_SIDES * short, GROUND_DIAGONALS * Math.hypot(size.width, size.height));
  return {
    planet: (focalOf(size) * radius) / orbitGlobeOf(size).radius,
    ground: (focalOf(size, GROUND_FIELD_OF_VIEW) * radius) / ground,
  };
}

/**
 * Where a planet's globe stands seen from orbit, in layout points: its middle's height from the top and its radius.
 * The prototype's: `heldAt` of the height down, {@link ORBIT_RADIUS_SHARE} of the short side across. Where a room is
 * given and that globe would leave it, the globe is the one that fits: as big as the room allows, never under
 * {@link MIN_GLOBE_RADIUS_PX}, in the middle of the room (or, when the room is smaller than that globe, on its bottom edge).
 */
export function orbitGlobeOf(size: ViewSize): { readonly centreY: number; readonly radius: number } {
  const short = Math.min(size.width, SHORT_SIDE_OF_HEIGHT * size.height);
  const usual = { centreY: STOPS.planet.heldAt * size.height, radius: ORBIT_RADIUS_SHARE * short };
  const { room } = size;
  if (room === undefined) return usual;
  if (usual.centreY - usual.radius >= room.top && usual.centreY + usual.radius <= room.bottom) return usual;
  const half = (room.bottom - room.top) / 2;
  // A room too small for even the smallest globe gives the caption its room first: the globe stands on the room's
  // bottom edge and reaches up into the header's row.
  if (half < MIN_GLOBE_RADIUS_PX) return { centreY: room.bottom - MIN_GLOBE_RADIUS_PX, radius: MIN_GLOBE_RADIUS_PX };
  return { centreY: (room.top + room.bottom) / 2, radius: Math.min(usual.radius, half) };
}

/**
 * The on-screen radius (pixels) from which a globe's regions are named and the ship goes round it: always
 * {@link GLOBE_NAMED_FROM_PX}, except on a globe fitted to a smaller room, where it is a little under that globe's own
 * radius, so a fitted globe keeps its regions.
 */
export const namedFromPxOf = (size: ViewSize): number =>
  size.room === undefined
    ? GLOBE_NAMED_FROM_PX
    : Math.min(GLOBE_NAMED_FROM_PX, FITTED_NAMED_SHARE * orbitGlobeOf(size).radius);

/**
 * How far below a globe, and how far above the caption under it, a region's 48 px target may reach: the caption stands
 * this far from the globe's edge, so no target on the globe lies under it.
 */
export const CAPTION_BELOW_GLOBE = 32;

/** The height from the top at which a planet's caption stands under the globe seen from orbit at its usual place. */
export const captionBelowGlobe = (size: ViewSize): number => {
  const { centreY, radius } = orbitGlobeOf({ width: size.width, height: size.height });
  return centreY + radius + CAPTION_BELOW_GLOBE;
};

/** The room a globe has between the header's bottom edge and a caption whose top edge stands at `captionTop`. */
export const globeRoomOf = (captionTop: number, headerBottom: number): GlobeRoom => ({
  top: headerBottom,
  bottom: captionTop - CAPTION_BELOW_GLOBE,
});

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
