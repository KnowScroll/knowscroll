/**
 * Which systems of a map are drawn in full, and how many tap targets a frame may carry (D-417). Pure: no three.js,
 * no React, no clock, so a test can read the choice and the web and Hermes agree on it.
 *
 * A map with a few systems draws every one in full, as it always has. A map at scale draws the systems near the
 * camera in full, a bounded few, and the rest as one cheap field of glow points; the drawing never builds a mesh for
 * thousands of systems nobody can see.
 */

/** A map with this many systems or fewer is drawn in full, every system, exactly as before the sky existed. */
export const DETAIL_MAX = 24;
/** How far from the camera's target, in scene units, a system comes into detail. */
export const DETAIL_RADIUS = 60;
/** A system already in detail stays until it is this much farther than a newcomer would have to be (hysteresis). */
export const DETAIL_HOLD = 1.25;
/** Systems built in one frame, so the paint of their planets never stalls a frame. */
export const DETAIL_BUILDS_PER_FRAME = 1;
/** The tap targets and labels one frame carries, nearest the middle of the screen first. */
export const ANCHOR_CAP = 160;
/** Anchors this far (as a share of the half screen) outside the screen are still kept, so a label never pops at the edge. */
export const SCREEN_MARGIN = 0.15;

/** Where a system stands on the ground, in scene units. Parallel arrays keep thousands of systems cheap to scan. */
export interface SystemPlaces {
  readonly ids: readonly string[];
  readonly x: ArrayLike<number>;
  readonly z: ArrayLike<number>;
}

export interface DetailInput {
  readonly places: SystemPlaces;
  /** Where the camera looks, on the ground. */
  readonly target: { readonly x: number; readonly z: number };
  /** Systems that are always in detail: the one focused, picked, scripted or holding the ship. */
  readonly pinned: ReadonlySet<string>;
  /** The set chosen last time, for the hysteresis. */
  readonly previous: ReadonlySet<string>;
}

/** Whether a map of this many systems is drawn in full everywhere. */
export const drawsEverything = (systemCount: number): boolean => systemCount <= DETAIL_MAX;

/**
 * The systems to draw in full. Everything for a small map. Otherwise the pinned systems, then the nearest to the
 * target inside {@link DETAIL_RADIUS}, at most {@link DETAIL_MAX} in all. A system already in detail counts as
 * {@link DETAIL_HOLD} times nearer than it is, so one that sits at the edge does not come and go as the camera
 * breathes. The order of the result is by distance, then id, so the same input always gives the same set.
 */
export function chooseDetail(input: DetailInput): ReadonlySet<string> {
  const { places, target, pinned, previous } = input;
  if (drawsEverything(places.ids.length)) return new Set(places.ids);
  const chosen = new Set<string>();
  for (const id of pinned) if (chosen.size < DETAIL_MAX) chosen.add(id);
  const near: { id: string; effective: number }[] = [];
  for (let at = 0; at < places.ids.length; at++) {
    const id = places.ids[at]!;
    if (chosen.has(id)) continue;
    const distance = Math.hypot(places.x[at]! - target.x, places.z[at]! - target.z);
    const effective = previous.has(id) ? distance / DETAIL_HOLD : distance;
    if (effective <= DETAIL_RADIUS) near.push({ id, effective });
  }
  near.sort((a, b) => a.effective - b.effective || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { id } of near) {
    if (chosen.size >= DETAIL_MAX) break;
    chosen.add(id);
  }
  return chosen;
}

/** Whether two sets hold the same ids. */
export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** What a projected anchor needs to be ranked: its place on the screen in normalised device coordinates. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Whether a point (normalised device coordinates, -1 to 1) is on the screen or within {@link SCREEN_MARGIN} of it. */
export const onScreen = (point: ScreenPoint): boolean =>
  Math.abs(point.x) <= 1 + SCREEN_MARGIN && Math.abs(point.y) <= 1 + SCREEN_MARGIN;

/** How far a point is from the middle of the screen, for ranking: nearest first. */
export const fromMiddle = (point: ScreenPoint): number => point.x * point.x + point.y * point.y;
