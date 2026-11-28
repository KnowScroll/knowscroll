import type { OuterFriend } from './friend-order';

/**
 * The places of the outer stop (pure, no React, no clock, no random number read at draw time). Your universe is the
 * middle of a field; every friend has a place in it worked out from nothing but their rank in the ordered list, so the
 * same list gives the same places on every run and on every device, and nothing about the places is stored or sent.
 *
 * Units. The field is laid out in CELLS (one cell is about the room a friend needs: bubble, initial above, name below),
 * not in universe radii, because what must hold is "five to ten on screen at a time". `cellOf` picks the cell from the
 * screen; a place is `cell` times its cell position, from the centre of your universe.
 *
 * Places. The first two friends take the prototype's two spots (angles 2.3 and 4.0 rad, both to the left, about 125 px
 * out on a phone); every later friend sits on a sunflower spiral, `RING` cells out and then `SPREAD * sqrt(rank - 1)`
 * further, at the golden angle, so any window of the field holds friends and no two touch.
 *
 * Pan. The field is panned by an offset in px that moves everything in it, your universe included (so a friend never
 * slides across your bubble). `panLimit` is how far the field may be moved: it keeps the screen inside the field.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}
/** A disc on screen: where a bubble is and how much room it takes. */
export interface Disc extends Point {
  readonly r: number;
}
export interface Viewport {
  readonly width: number;
  readonly height: number;
}
/** The free room above and below the field: the header and the chips. */
export interface Bands {
  readonly top: number;
  readonly bottom: number;
}
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The fewest friends the screen keeps in view (when there are that many): the owner's "5 to 10 at a time". */
export const LEAST_IN_VIEW = 5;
/** At most this many friends are drawn (and given a button) at a time. */
export const FRIEND_CAP = 10;
/** The seven unnamed universes of the prototype: decoration, never a friend, a button or a count. */
export const DECORATION_COUNT = 7;

/**
 * The stage's bands over the field, restated from `voyage-stage.tsx` (`LABEL_BANDS`, which is not exported): the header
 * and the chips take the top and bottom of a phone; a desktop (width 900 and up) takes less.
 */
export const PHONE_BANDS: Bands = { top: 150, bottom: 196 };
export const DESKTOP_BANDS: Bands = { top: 64, bottom: 46 };
const DESKTOP_WIDTH = 900;
export const bandsOf = (viewport: Viewport): Bands => (viewport.width >= DESKTOP_WIDTH ? DESKTOP_BANDS : PHONE_BANDS);

/** A cell, in px, for a screen: 56 on the smallest phone, 64 on a phone, 84 on a tablet, 96 on a desktop. */
const PHONE_CELL = 64;
export function cellOf(viewport: Viewport): number {
  if (viewport.width >= DESKTOP_WIDTH) return 96;
  if (viewport.width >= 600) return 84;
  return viewport.width >= 360 ? PHONE_CELL : 56;
}

/** The radius of a friend's bubble (its halo's edge), in px: half a cell, between 30 and 48. */
export const spotRadiusOf = (cell: number): number => Math.min(48, Math.max(30, Math.round(cell * 0.5)));

/** Where your own bubble is drawn from, in cells: the first ring, the prototype's 125 px at a cell of 72. */
const RING = 1.75;
/** The sunflower's spread: the area per friend is about `pi * SPREAD^2` cells. */
const SPREAD = 0.75;
const GOLDEN = 2.399963229728653;
/** The prototype's two spots (angle in radians, screen y down), then the spiral starts from the first of them. */
const MOCK_ANGLES = [2.3, 4.0] as const;
/** How much of the field's edge the screen may not pass (cells): the pan stops this far inside the outermost friend. */
const EDGE = 0.8;

/** No two friends sit closer than this, in cells: the spiral's candidate places that would are skipped, in order. */
const GAP = 1.15;
const places: Point[] = [];
let candidate = 2;
/**
 * The name under your universe, in cells from its centre (about 104 x 20 px, from 4 px below its bubble): a spiral place whose
 * bubble would sit on it is skipped, so no friend after the first two hides it. A bubble's web is 0.45 of a cell across its radius.
 */
const NAME_BOX = { left: -0.85, right: 0.85, top: 0.8, bottom: 1.3 };
const WEB = 0.45;
const onName = (spot: Point): boolean =>
  Math.hypot(
    spot.x - Math.max(NAME_BOX.left, Math.min(spot.x, NAME_BOX.right)),
    spot.y - Math.max(NAME_BOX.top, Math.min(spot.y, NAME_BOX.bottom)),
  ) < WEB;
const spiral = (index: number): Point => {
  const angle = MOCK_ANGLES[0] + index * GOLDEN;
  const distance = Math.sqrt(RING * RING + SPREAD * SPREAD * (index - 1));
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
};
/** The places made so far: a pure function of the rank, kept (the same every time) rather than made again each frame. */
function extendPlaces(rank: number): void {
  while (places.length <= rank) {
    if (places.length < 2) {
      const angle = MOCK_ANGLES[places.length]!;
      places.push({ x: Math.cos(angle) * RING, y: Math.sin(angle) * RING });
      continue;
    }
    let spot = spiral(candidate);
    candidate += 1;
    while (onName(spot) || places.some((other) => Math.hypot(other.x - spot.x, other.y - spot.y) < GAP)) {
      spot = spiral(candidate);
      candidate += 1;
    }
    places.push(spot);
  }
}

/** A friend's place in cells from the centre of your universe. */
export function slotOf(rank: number): Point {
  extendPlaces(rank);
  return places[rank]!;
}

/** How far the outermost of `count` friends is from your universe, in cells. */
export function fieldRadius(count: number): number {
  let farthest = 0;
  for (let rank = 0; rank < count; rank += 1) {
    const slot = slotOf(rank);
    farthest = Math.max(farthest, Math.hypot(slot.x, slot.y));
  }
  return farthest;
}

/** How far (px) the field may be moved from rest in any direction at most: the disc the screen's middle stays inside. */
export const panLimit = (count: number, cell: number): number => Math.max(0, fieldRadius(count) - EDGE) * cell;

/** One friend on screen. */
export interface FriendSpot {
  readonly handle: string;
  readonly name: string;
  readonly personId: string;
  /** The friend's rank in the ordered list. */
  readonly index: number;
  /** The centre, in px on screen. */
  readonly x: number;
  readonly y: number;
  /** The bubble's radius (halo edge), in px. */
  readonly radius: number;
  /** What the bubble's web is made from: the handle, as the crossing film's is, so the web tapped is the web it opens on. */
  readonly seed: string;
}

/** One of the seven unnamed universes: a place and a look, nothing else. */
export interface DecorationSpot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** The prototype's own seeds, `o0` to `o6`. */
  readonly seed: string;
}

export interface FieldInput {
  readonly viewport: Viewport;
  /** Where your universe sits on screen at rest (before `pan`) and how big it is drawn. */
  readonly universe: { readonly x: number; readonly y: number; readonly radiusPx: number };
  /** The field's offset in px. It moves everything, your universe included: pass `{0, 0}` if `universe` already carries the pan. */
  readonly pan: Point;
  /** Overrides the stage's bands (a screen that lets go of its chips here). */
  readonly bands?: Bands;
}

export interface FieldLayout {
  readonly cell: number;
  /** The free band the friends are drawn in. */
  readonly band: Rect;
  /** Your universe as drawn: where, and how big (never wider than the first ring leaves room for). */
  readonly home: { readonly x: number; readonly y: number; readonly radius: number };
  /** The friends on screen, at most `FRIEND_CAP`, nearest the middle of the band first. */
  readonly friends: readonly FriendSpot[];
  readonly decorations: readonly DecorationSpot[];
}

/** The most room your own bubble takes: the first ring less a friend's bubble and a gap, so it never meets a friend. */
const homeRadiusCap = (cell: number): number => RING * cell - spotRadiusOf(cell) - 14;

const frac = (value: number): number => value - Math.floor(value);
const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The seven unnamed universes, the prototype's own formula (`drawMulti`) in px from your universe: angle `-1.3 + 0.5 k`
 * (the right-hand arc), distance `2.35 + (k % 2) * 1.05 + 0.2 frac(k phi)` of `unit`, radius `0.42 + 0.3 frac(0.71 k)`
 * of `unit` (a little under, as the prototype's depth does).
 */
function decorationOffsets(unit: number): readonly (Point & { readonly radius: number; readonly id: string })[] {
  return Array.from({ length: DECORATION_COUNT }, (_, k) => {
    const angle = -1.3 + k * 0.5;
    const distance = 2.35 + (k % 2) * 1.05 + 0.2 * frac(k * PHI);
    return {
      id: `o${k}`,
      x: Math.cos(angle) * distance * unit,
      y: Math.sin(angle) * distance * unit * 0.92,
      radius: (0.42 + 0.3 * frac(k * 0.71)) * unit * 0.8,
    };
  });
}

/** The yellow initial above a friend's bubble: its width, and how far its centre sits above the bubble's rim (px). */
export const INITIAL_DISC = 26;
export const INITIAL_GAP = 6;
/** The title and its line take this much of the band's top (px) before a mark may begin. */
export const TITLE_ROOM = 56;
/** What a mark takes beyond its bubble: the yellow initial above (px), the name below. */
const MARK_ABOVE = INITIAL_GAP + INITIAL_DISC / 2;
const MARK_BELOW = 26;
/** How far a friend's centre keeps from the screen's sides, in cells. */
const SIDE_ROOM = 0.4;
/** The most of the band's height the margins above and below the friends may take. */
const MARGIN_SHARE = 0.4;

/** The room a name takes under a friend, below its bubble, that an unnamed universe must stay clear of. */
const NAME_ROOM = 34;

/** Where everything is on screen now: the friends in view (at most ten), your universe, and the unnamed seven. */
export function layoutField(friends: readonly OuterFriend[], input: FieldInput): FieldLayout {
  const { viewport, universe, pan } = input;
  const cell = cellOf(viewport);
  const bands = input.bands ?? bandsOf(viewport);
  const band: Rect = {
    left: 0,
    top: bands.top,
    right: viewport.width,
    bottom: Math.max(bands.top, viewport.height - bands.bottom),
  };
  const radius = spotRadiusOf(cell);
  const home = {
    x: universe.x + pan.x,
    y: universe.y + pan.y,
    radius: Math.min(universe.radiusPx, homeRadiusCap(cell)),
  };
  // A whole mark (the initial above, the bubble, the name below) should sit in the band, clear of the title at its top.
  // On a short screen that would leave nothing, so the margins give way to at most this share of the band's height.
  const above = TITLE_ROOM + radius + MARK_ABOVE;
  const below = radius + MARK_BELOW;
  const height = band.bottom - band.top;
  const give = Math.min(1, (MARGIN_SHARE * height) / (above + below));
  const window: Rect = {
    left: band.left + cell * SIDE_ROOM,
    right: band.right - cell * SIDE_ROOM,
    top: band.top + above * give,
    bottom: band.bottom - below * give,
  };
  // On a screen too short for that, a friend may sit nearer the band's edges (its initial, which would sit on the title, is
  // then left out by the layer) so the field is not left empty.
  const loose: Rect = {
    left: band.left + radius * 0.5,
    right: band.right - radius * 0.5,
    top: band.top + TITLE_ROOM * 0.7 + radius,
    bottom: band.bottom - radius * 0.5,
  };
  const places: Point[] = [];
  const spots: FriendSpot[] = friends.map((friend, index) => {
    const slot = slotOf(index);
    const x = home.x + slot.x * cell;
    const y = home.y + slot.y * cell;
    places.push({ x, y });
    return {
      handle: friend.handle,
      name: friend.name,
      personId: friend.personId,
      index,
      x,
      y,
      radius,
      seed: friend.handle,
    };
  });
  const pick = (within: Rect): FriendSpot[] => {
    const middle = { x: (within.left + within.right) / 2, y: (within.top + within.bottom) / 2 };
    return spots
      .filter(
        (spot) => spot.x >= within.left && spot.x <= within.right && spot.y >= within.top && spot.y <= within.bottom,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y) || a.index - b.index,
      )
      .slice(0, FRIEND_CAP);
  };
  let shown = pick(window);
  if (shown.length < Math.min(LEAST_IN_VIEW, friends.length)) {
    const nearer = pick(loose);
    if (nearer.length > shown.length) shown = nearer;
  }
  const decorations: DecorationSpot[] = [];
  for (const offset of decorationOffsets(cell * 0.7)) {
    const x = home.x + offset.x;
    const y = home.y + offset.y;
    // The picture of an unnamed one is dropped when it would sit on a friend (the ones in view, or any beyond).
    const onFriend = places.some(
      (place) => Math.hypot(place.x - x, place.y - y) < radius + offset.radius + NAME_ROOM * 0.5,
    );
    const onScreen =
      x + offset.radius > band.left &&
      x - offset.radius < band.right &&
      y + offset.radius > band.top &&
      y - offset.radius < band.bottom;
    if (!onFriend && onScreen) decorations.push({ id: offset.id, x, y, radius: offset.radius, seed: offset.id });
  }
  return { cell, band, home, friends: shown, decorations };
}

/** The discs the bubbles take on screen, yours and the friends' and the unnamed ones: what the parked ship keeps off. */
export const bubbleDiscs = (layout: FieldLayout): readonly Disc[] => [
  { x: layout.home.x, y: layout.home.y, r: layout.home.radius },
  ...layout.friends.map((spot) => ({ x: spot.x, y: spot.y, r: spot.radius })),
  ...layout.decorations.map((spot) => ({ x: spot.x, y: spot.y, r: spot.radius })),
];

/**
 * `pan` held where the screen still shows at least `min(5, friends)` friends: inside `panLimit`, and, if the field has
 * run thin there, brought back along the same line to the farthest offset that shows enough. So a person can fly to
 * the edge of their friends and never into empty sky. On a screen too small to show five at rest, it keeps what rest shows.
 */
export function clampPan(friends: readonly OuterFriend[], input: Omit<FieldInput, 'pan'>, pan: Point): Point {
  const cell = cellOf(input.viewport);
  const limit = panLimit(friends.length, cell);
  const length = Math.hypot(pan.x, pan.y);
  const reach = length <= limit ? pan : { x: (pan.x / length) * limit, y: (pan.y / length) * limit };
  // A screen too small to show five at rest keeps what it shows at rest, so the field still moves there.
  const enough = Math.min(
    LEAST_IN_VIEW,
    friends.length,
    layoutField(friends, { ...input, pan: { x: 0, y: 0 } }).friends.length,
  );
  for (let step = CLAMP_STEPS; step > 0; step -= 1) {
    const at = { x: (reach.x * step) / CLAMP_STEPS, y: (reach.y * step) / CLAMP_STEPS };
    if (layoutField(friends, { ...input, pan: at }).friends.length >= enough) return at;
  }
  return { x: 0, y: 0 };
}
const CLAMP_STEPS = 24;
