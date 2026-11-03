import {
  AXIS_DOT_RADIUS,
  AXIS_REACH,
  axisDirection,
  CARDINAL_MONTHS,
  MONTH_ANGLE_DEGREES,
  onEllipse,
  orbitFrame,
  PALE_EARTH_SHARE,
  RECAP_FRAME,
  recapHalfHeight,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type EarthSkyScene,
  type Point,
  type RecapMark,
} from './earth-sky-scene';
import { boxesOverlap, inflate, type Box, type SceneLabel } from './earth-sky-boxes';

/**
 * Where everything on the orbit views and on the recap stands, worked out from the scene alone, so that nothing overlaps for
 * any month the picture can show (D-393). An Earth is laid out as the box round its disc and its axis; a label as the box of its
 * words. The orbit view's month names go beyond their Earths, the pale Earth that the Earth of the month would crowd is left
 * out, and each recap badge takes the first free place round its Earth. The drawing (`earth-sky.tsx`) and the figures and tags
 * set beside them (`earth-sky-figures.ts`) both read these places, so the layout tests check what is drawn.
 */

type Month = EarthSkyScene['month'];

/** The half-width of an outline, so that a box takes in the whole stroke. */
const STROKE_HALF = 1.25;
/** The air kept between a month's name and the Earth it names. */
const NAME_GAP = 3;

/** The box round an Earth: its disc and the axis that reaches past it, to the dot at the north end. */
export function earthExtent(at: Point, radius: number, axisTurn: number, reach: number = AXIS_REACH): Box {
  const axis = axisDirection(axisTurn);
  const end = {
    x: Math.abs(axis.x) * radius * reach + AXIS_DOT_RADIUS,
    y: Math.abs(axis.y) * radius * reach + AXIS_DOT_RADIUS,
  };
  const half = { x: Math.max(radius + STROKE_HALF, end.x), y: Math.max(radius + STROKE_HALF, end.y) };
  return { left: at.x - half.x, right: at.x + half.x, top: at.y - half.y, bottom: at.y + half.y };
}

export interface PaleEarth {
  readonly at: Point;
  readonly radius: number;
}

/** One of the orbit's four turning points: its name, and the pale Earth that stands there unless the Earth of the month is by it. */
export interface MonthMark {
  readonly month: Month;
  readonly label: SceneLabel;
  /** Absent where the Earth of the month stands, or is near enough that a pale one beside it would only be clutter. */
  readonly pale: (PaleEarth & { readonly extent: Box }) | undefined;
}

export interface OrbitLayout {
  readonly frame: ReturnType<typeof orbitFrame>;
  readonly months: readonly MonthMark[];
  /** The box round the Earth of the month, and the one round the Sun with its rays. */
  readonly earth: Box;
  readonly sun: Box;
}

/** Which side of its Earth a turning point's name goes: away from the orbit's middle, so that it never sits on the orbit. */
const NAME_SIDE: Readonly<Record<(typeof CARDINAL_MONTHS)[number], 'above' | 'below' | 'left' | 'right'>> = {
  sep: 'above',
  mar: 'below',
  dec: 'left',
  jun: 'right',
};

/** Two angles name the same place on the circle. */
function sameAngle(first: number, second: number): boolean {
  const gap = Math.abs(first - second) % 360;
  return Math.min(gap, 360 - gap) < 1;
}

/** A name of the given words set against one side of an Earth's box, `NAME_GAP` away from it. */
function nameBeside(text: string, side: 'above' | 'below' | 'left' | 'right', extent: Box, at: Point): SceneLabel {
  if (side === 'above') return { text, x: at.x, y: extent.top - NAME_GAP - 1.5, anchor: 'middle' };
  if (side === 'below') return { text, x: at.x, y: extent.bottom + NAME_GAP + 8, anchor: 'middle' };
  if (side === 'left') return { text, x: extent.left - NAME_GAP, y: at.y + 3, anchor: 'end' };
  return { text, x: extent.right + NAME_GAP, y: at.y + 3, anchor: 'start' };
}

/** The dashed orbit as small boxes along it, so that no words are set across it. */
export function orbitLine(frame: Pick<OrbitLayout['frame'], 'centre' | 'halfWidth' | 'halfHeight'>): Box[] {
  return Array.from({ length: 96 }, (_, step) => {
    const at = onEllipse(frame.centre, frame.halfWidth, frame.halfHeight, (step * 360) / 96);
    return { left: at.x - 2.5, right: at.x + 2.5, top: at.y - 2.5, bottom: at.y + 2.5 };
  });
}

/** The Sun and the rays that stand off it. */
function sunExtent(sun: Point, radius: number): Box {
  const reach = radius + 9 + STROKE_HALF;
  return { left: sun.x - reach, right: sun.x + reach, top: sun.y - reach, bottom: sun.y + reach };
}

/** The places of the orbit view: the four months' names and pale Earths, and the room the Earth of the month and the Sun take. */
export function orbitLayout(
  scene: Pick<EarthSkyScene, 'orbitRatio' | 'sunOffset' | 'earthAngle' | 'axisTurn'>,
): OrbitLayout {
  const frame = orbitFrame(scene);
  const { centre, halfWidth, halfHeight, earth, earthRadius, sun, sunRadius } = frame;
  const now = earthExtent(earth, earthRadius, scene.axisTurn);
  const paleRadius = earthRadius * PALE_EARTH_SHARE;
  const months = CARDINAL_MONTHS.map((month): MonthMark => {
    const angle = MONTH_ANGLE_DEGREES[month];
    const at = onEllipse(centre, halfWidth, halfHeight, angle);
    const extent = earthExtent(at, paleRadius, scene.axisTurn);
    const here = sameAngle(angle, scene.earthAngle);
    // The name stands beyond whichever Earth is drawn at this place.
    const named = here ? now : extent;
    return {
      month,
      label: nameBeside(month.toUpperCase(), NAME_SIDE[month], named, at),
      pale: here || boxesOverlap(inflate(now, 1), extent) ? undefined : { at, radius: paleRadius, extent },
    };
  });
  return { frame, months, earth: now, sun: sunExtent(sun, sunRadius) };
}

/** One numbered Earth of the recap: where on the orbit the Scroll shows it, and where its number goes. */
export interface RecapPlace {
  readonly mark: RecapMark;
  readonly earth: Point;
  readonly badge: Point;
}

/** The directions a badge is tried in, in degrees turned from straight out of the orbit: out first, then either side, then in. */
const BADGE_TURNS = [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120, 140, -140, 160, -160, 180] as const;
/** How far from the Earth, as a multiple of the nearest place, a badge is tried in each direction. */
const BADGE_REACHES = [1, 1.25, 1.5] as const;

const badgeBox = (badge: Point): Box =>
  inflate({ left: badge.x, right: badge.x, top: badge.y, bottom: badge.y }, RECAP_FRAME.badgeRadius);

/**
 * Each numbered Earth of a recap scene, with where its badge goes: on the outer side of the orbit where there is room, and
 * where the frame or another Earth is in the way, the nearest free place round the Earth. A badge never covers an Earth (its disc
 * and axis) or another badge, and stays inside the frame and clear of the tab the next Part shows at the right edge.
 */
export function recapPlaces(
  scene: Pick<EarthSkyScene, 'orbitRatio' | 'axisTurn'>,
  marks: readonly RecapMark[],
): readonly RecapPlace[] {
  const { centre, halfWidth, earthRadius, axisReach, badgeRadius, badgeGap, peekClearance } = RECAP_FRAME;
  const halfHeight = recapHalfHeight(scene);
  const earths = marks.map((mark) => onEllipse(centre, halfWidth, halfHeight, mark.angle));
  const bodies = earths.map((earth) => inflate(earthExtent(earth, earthRadius, scene.axisTurn, axisReach), 1));
  const badges: Box[] = [];
  const reach = earthRadius + badgeRadius + badgeGap;
  return marks.map((mark, index) => {
    const earth = earths[index]!;
    const outward = Math.atan2(earth.y - centre.y, earth.x - centre.x);
    const tries = BADGE_REACHES.flatMap((far) =>
      BADGE_TURNS.map((turn) => {
        const heading = outward + (turn * Math.PI) / 180;
        return { x: earth.x + Math.cos(heading) * reach * far, y: earth.y + Math.sin(heading) * reach * far };
      }),
    );
    const free = tries.find((badge) => {
      const box = badgeBox(badge);
      return (
        box.left >= 1 &&
        box.right <= SCENE_WIDTH - peekClearance &&
        box.top >= 1 &&
        box.bottom <= SCENE_HEIGHT - 1 &&
        bodies.every((body) => !boxesOverlap(box, body)) &&
        badges.every((other) => !boxesOverlap(inflate(box, badgeGap / 2), other))
      );
    });
    const badge = free ?? tries[0]!;
    badges.push(badgeBox(badge));
    return { mark, earth, badge };
  });
}
