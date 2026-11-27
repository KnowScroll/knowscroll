/**
 * How the places on screen pull the ship. A star pulls harder and from farther than a planet, a planet more than the
 * small things the ship can only be dropped on (a region, a room's station), and every pull fades with distance, so a
 * ship dragged past a body curves toward it and one let go near it is drawn in. The prototype had one pull for
 * everything (a bend of 0.45 within 64 points of the finger, `Universe.dc.html` line 1904); the owner asked for a pull
 * that is felt "as we move around" planets, stars and galaxies (27 November), so bodies reach farther, and that law is
 * kept for the rest.
 *
 * The pull is a transform, not a simulation: it bends where the ship is going (the spring's goal), by a share of the
 * way toward each body that depends only on distances this frame. The shares never add up to the whole way, so the
 * finger always wins. Pure, three-free and allocation-light: the controller calls it every frame.
 */

/** How one place pulls the ship, in layout points. */
export interface Pull {
  /** Beyond this distance from the finger the place does not pull. */
  readonly reach: number;
  /** The share of the way toward the place the ship's goal bends when the finger is on it (0..1). */
  readonly bend: number;
  /**
   * How the bend fades with the finger's distance `d`, as `u = d / reach`: `even` is `1 - u`, the prototype's; `well`
   * is `(1 - u²)²`, which holds near the body and is still felt far out, and enters from nothing with no jolt.
   */
  readonly shape: 'even' | 'well';
  /** A ship let go nearer than this goes to the place. */
  readonly capture: number;
  /** A ship let go nearer than this, but not within `capture`, is drawn in and then goes (0: never). */
  readonly fall: number;
  /** A ship being drawn in has reached the body when it is this near: the body's edge on screen and a little more. */
  readonly core: number;
  /**
   * A body (a star, a planet) pulls from afar. A place that is not one (a region, a room's station) is small and aimed
   * at: with the finger on it, it is the candidate, whatever body pulls behind it.
   */
  readonly body: boolean;
}

/** Something on screen the ship could go to. */
export interface PullingPlace {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly pull: Pull;
}

/**
 * The prototype's one pull, kept for places that are not bodies: the bend `0.45 * (1 - d / 64)` while held (line 1904)
 * and the catch within 70 points on letting go (line 2075). A room is opened by dropping the ship on it, so it must
 * never draw the ship in by itself.
 */
export const PLACE_PULL: Pull = { reach: 64, bend: 0.45, shape: 'even', capture: 70, fall: 0, core: 0, body: false };

/** The kinds of place that are bodies: they pull with their size. A galaxy, when the map has one, pulls more than a star. */
type Body = 'system' | 'planet';

/**
 * A body's pull: its reach and its catch grow with its size on screen, so the sun filling a star's stop pulls from
 * across it while a far star is a point with a pull round it. `reach` and `capture` are the pull's own, before the
 * body's radius on screen is added.
 */
const BODY_PULLS: Readonly<Record<Body, Pull>> = {
  system: { reach: 170, bend: 0.6, shape: 'well', capture: 70, fall: 125, core: 20, body: true },
  planet: { reach: 150, bend: 0.55, shape: 'well', capture: 70, fall: 110, core: 18, body: true },
};

/** The most the goal may bend toward all the places together: always short of the whole way, so the finger wins. */
export const MAX_TOTAL_BEND = 0.62;
/** A new place takes over as the candidate only when it pulls this much harder than the one the ship is bending to. */
const SWITCH_MARGIN = 1.25;

const isBody = (kind: string): kind is Body => kind in BODY_PULLS;

/** How a place of `kind`, `radiusPx` round on screen, pulls the ship. */
export function pullOf(kind: string, radiusPx: number): Pull {
  if (!isBody(kind)) return PLACE_PULL;
  const pull = BODY_PULLS[kind];
  const radius = Math.max(0, radiusPx);
  return {
    ...pull,
    reach: pull.reach + radius,
    capture: pull.capture + radius,
    fall: pull.fall + radius,
    core: pull.core + radius,
  };
}

/** The share of the way toward `place` its pull bends a goal at `at` (0 out of reach). */
export function bendAt(place: PullingPlace, at: { readonly x: number; readonly y: number }): number {
  const distance = Math.hypot(place.x - at.x, place.y - at.y);
  const { reach, bend, shape } = place.pull;
  if (distance >= reach) return 0;
  const u = distance / reach;
  if (shape === 'even') return bend * (1 - u);
  const well = 1 - u * u;
  return bend * well * well;
}

/** Where the finger's goal bends to, which place pulls it most (the candidate), and how strongly (0..1). */
export interface Pulled {
  readonly x: number;
  readonly y: number;
  readonly candidate: string | null;
  /** The candidate's bend as a share of its strongest: 1 with the finger on it, 0 at the edge of its reach. */
  readonly strength: number;
}

/**
 * Bends the goal of a held ship toward every place in reach of the finger, each by its own share, the shares together
 * capped at {@link MAX_TOTAL_BEND}. The candidate is the place pulling hardest, a place that is not a body first (a
 * room beside its star is aimed at, and must win over the star). The one already chosen stays chosen until another of
 * its rank pulls {@link SWITCH_MARGIN} times harder, so two places in reach do not make the glow flicker.
 */
export function pullGoal(
  finger: { readonly x: number; readonly y: number },
  places: readonly PullingPlace[],
  current: string | null,
): Pulled {
  let total = 0;
  let dx = 0;
  let dy = 0;
  // The strongest place of each rank, and the current candidate's own share.
  let aimed: { place: PullingPlace; share: number } | null = null;
  let body: { place: PullingPlace; share: number } | null = null;
  let kept: { place: PullingPlace; share: number } | null = null;
  for (const place of places) {
    const share = bendAt(place, finger);
    if (share <= 0) continue;
    total += share;
    dx += (place.x - finger.x) * share;
    dy += (place.y - finger.y) * share;
    if (place.pull.body) {
      if (body === null || share > body.share) body = { place, share };
    } else if (aimed === null || share > aimed.share) aimed = { place, share };
    if (place.id === current) kept = { place, share };
  }
  if (total === 0) return { x: finger.x, y: finger.y, candidate: null, strength: 0 };
  const scale = total > MAX_TOTAL_BEND ? MAX_TOTAL_BEND / total : 1;
  const best = aimed ?? body;
  const chosen =
    kept !== null &&
    best !== null &&
    kept.place.pull.body === best.place.pull.body &&
    kept.share * SWITCH_MARGIN >= best.share
      ? kept
      : best;
  return {
    x: finger.x + dx * scale,
    y: finger.y + dy * scale,
    candidate: chosen?.place.id ?? null,
    strength: chosen === null ? 0 : chosen.share / chosen.place.pull.bend,
  };
}

/** What letting go at a distance `distance` from the candidate does: go there now, be drawn in first, or nothing. */
export function onLettingGo(pull: Pull, distance: number): 'go' | 'fall' | 'stay' {
  if (distance < pull.capture) return 'go';
  if (distance < pull.fall) return 'fall';
  return 'stay';
}
