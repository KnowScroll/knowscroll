/**
 * What a drag on the text of a v2 Scroll means (D-134), decided once at release. Vertical reading
 * never navigates: only a drag that is clearly sideways moves between Parts, and only a deliberate
 * pull up from the very end of the text asks for a new topic.
 */
export type PartMove = 'next-part' | 'previous-part' | 'next-topic';

/** Travel a sideways swipe needs (the Reel's own threshold). */
export const SWIPE_DISTANCE = 64;
/** Travel a pull past the end needs: further than a swipe, so a momentum fling at the end never counts. */
export const PULL_DISTANCE = 96;
/** The width of the zone along each screen edge that belongs to the platform's Back gesture. */
export const EDGE_ZONE = 24;

export interface DragEnd {
  readonly dx: number;
  readonly dy: number;
  /** The text was already scrolled to its end when the drag began. */
  readonly startedAtEnd: boolean;
  /** Where on the screen the drag began and how wide the screen is, to leave the edge zones to the platform. */
  readonly startX?: number;
  readonly screenWidth?: number;
}

/**
 * Left = the next Part, right = the one before, up from the end = a new topic. A drag that began in a
 * platform edge zone is the platform's (Back) and never moves a Part.
 */
export function partMoveOf({ dx, dy, startedAtEnd, startX, screenWidth }: DragEnd): PartMove | undefined {
  if (startX !== undefined && screenWidth !== undefined && (startX < EDGE_ZONE || startX > screenWidth - EDGE_ZONE))
    return undefined;
  const sideways = Math.abs(dx) >= Math.abs(dy) * 1.2;
  if (sideways && Math.abs(dx) >= SWIPE_DISTANCE) return dx < 0 ? 'next-part' : 'previous-part';
  if (startedAtEnd && dy <= -PULL_DISTANCE && Math.abs(dy) >= Math.abs(dx) * 1.5) return 'next-topic';
  return undefined;
}

/** A drag has to be this far along before it is shown: a nudge shows nothing (the first two thirds of `SWIPE_DISTANCE`). */
export const DRAG_SHOWS_AT = 12;

/**
 * Where a drag stands while it is still under way, for what the screen draws under the finger. It is
 * `partMoveOf`'s sibling: the same reading of "clearly sideways" and "a pull from the end", but asked
 * at every move, not once at release. A `part` drag is the next Part when `dx` is negative, the one
 * before when it is positive.
 */
export type PartDrag =
  | { readonly kind: 'part'; readonly dx: number }
  | { readonly kind: 'pull'; readonly progress: number }
  /** The finger is up. `move` is what the release meant, so the screen can settle what it drew. */
  | { readonly kind: 'end'; readonly move: PartMove | undefined };

/** How far a pull from the end has got, from 0 to 1 (1 is the distance a release needs). */
export function pullProgress(dy: number): number {
  return Math.min(1, Math.max(0, -dy / PULL_DISTANCE));
}

/** What a drag in progress shows, or nothing for a nudge and for reading. */
export function dragOf({ dx, dy, startedAtEnd }: DragEnd): Exclude<PartDrag, { kind: 'end' }> | undefined {
  if (Math.abs(dx) >= Math.abs(dy) * 1.2 && Math.abs(dx) >= DRAG_SHOWS_AT) return { kind: 'part', dx };
  if (startedAtEnd && dy < 0 && Math.abs(dy) >= Math.abs(dx) * 1.5) return { kind: 'pull', progress: pullProgress(dy) };
  return undefined;
}
