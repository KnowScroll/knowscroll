/**
 * Where the ship stands on the ground, and what the "you are here" pill says about it. On the ground the ship is always
 * landed: it stands just above the region the camera came down over while that region is on screen, and once the view
 * turns away from it, it stays landed at its fixed spot near the bottom of the screen, as the land moves under it. It
 * never goes back up to hover in the sky. Pure and three-free.
 */
import { FOOT_SHARE, GROUND_SIZE } from './ship-ground';
import { parkingSpot, type Point, type ShipBounds, type ShipHome } from './ship-motion';

/** A ship that has parked comes back to its region only when the region has slid this near its spot, in points. */
export const REATTACH_DISTANCE = 50;

/** What the ground needs of a named point on screen. */
interface Named extends Point {
  readonly id: string;
  readonly radiusPx: number;
  readonly visible: boolean;
}

/** What {@link groundHome} is told. */
export interface GroundHomeInput {
  /** What is named on screen (the visible ones count), as the ship sees them. */
  readonly anchors: readonly Named[];
  /** The region the camera came down over; null when the planet has none named. */
  readonly regionId: string | null;
  /** The ship's own spot, near the bottom of the screen (`SHIP_LAYOUT`'s `parkAt` of the layout), before it steps aside. */
  readonly spot: Point;
  /** A parked ship steps clear of these (everything named on screen, with a radius). */
  readonly avoid: readonly (Point & { readonly r: number })[];
  /** Where the ship may be on screen. */
  readonly bounds: ShipBounds;
  /** The ship had parked in the last frame. */
  readonly parked: boolean;
}

const inside = (point: Point, bounds: ShipBounds): boolean =>
  point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;

/**
 * Where a landed ship stands: on its region's point while that is on screen (inside what the ship may reach, not just
 * facing the camera), else at its spot on screen. Once it has parked it stays there until the region has slid under it,
 * so the ship does not cross the screen to the region each time the region touches the edge of its room and leaves it.
 * Returns the ship's home and whether it is parked.
 */
export function groundHome(input: GroundHomeInput): { readonly home: ShipHome; readonly parked: boolean } {
  const { anchors, regionId, bounds } = input;
  const region = anchors.find((anchor) => anchor.visible && anchor.id === regionId);
  const stand = region === undefined ? null : { x: region.x, y: region.y - GROUND_SIZE * FOOT_SHARE };
  const spot = parkingSpot({ anchor: input.spot, avoid: input.avoid });
  const home = (at: Point): ShipHome => ({ x: at.x, y: at.y, size: GROUND_SIZE, heading: 0 });
  if (stand === null || !inside(stand, bounds)) return { home: home(spot), parked: true };
  if (input.parked && Math.hypot(stand.x - spot.x, stand.y - spot.y) > REATTACH_DISTANCE)
    return { home: home(spot), parked: true };
  return { home: home(stand), parked: false };
}

/**
 * What the "you are here" pill says: the opened region the ship stands on, and where the pill goes. `at` is null while
 * the pill rides its region's own point (the ship is over it), else the point of the ground under the ship's fins, where
 * the pill is hung. Nothing (`id` null) when the ship stands over the sea or over land not reached, which is never named.
 */
export interface Stands {
  readonly id: string | null;
  readonly at: Point | null;
}

/** The ship stands on nothing the pill names. */
export const NOWHERE: Stands = { id: null, at: null };

/** A ship slower than this, in points a second, has come to rest. */
export const REST_SPEED = 8;

/** What {@link standsOf} is told. */
export interface StandsInput {
  /** The ship is held, falling into a place, lifted or settling, flying, or not yet back: the pill is not shown. */
  readonly busy: boolean;
  /** The ship was let go in empty land and stays where it is. */
  readonly free: boolean;
  /** The ship has left its region and stands at its own spot on screen. */
  readonly parked: boolean;
  /** The region the camera came down over (`standsOn`). */
  readonly regionId: string | null;
  /** How fast the ship moves, in points a second. */
  readonly speed: number;
  /** The point of the ground under its fins. */
  readonly foot: Point;
  /** What is under a point of the screen, if the world can say. */
  readonly regionAt: ((x: number, y: number) => string | null) | undefined;
}

/**
 * What the ship stands on, for the pill (the prototype's `pill`: shown when the ship is present and not held). Over its
 * own region the pill rides that region's point. Anywhere else, once it has come to rest, the land under it says: an
 * opened region is named, hung under the ship; the sea and land not reached give no pill, and nothing says that closed
 * land is there.
 */
export function standsOf(input: StandsInput): Stands {
  if (input.busy) return NOWHERE;
  if (!input.free && !input.parked && input.regionId !== null) return { id: input.regionId, at: null };
  if (input.speed > REST_SPEED) return NOWHERE;
  const id = input.regionAt?.(input.foot.x, input.foot.y) ?? null;
  return id === null ? NOWHERE : { id, at: { x: Math.round(input.foot.x), y: Math.round(input.foot.y) } };
}
