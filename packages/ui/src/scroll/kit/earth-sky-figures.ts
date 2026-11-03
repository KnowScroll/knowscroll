import { formatFigure, type StageFigure } from '../model';
import { orbitFrame, SCENE_WIDTH, type EarthSkyScene, type Point } from './earth-sky-scene';
import {
  firstFree,
  freeAmong,
  inflate,
  LABEL_CHARACTER_PX,
  labelBox,
  type Box,
  type SceneLabel,
} from './earth-sky-boxes';
import { orbitLayout, orbitLine } from './earth-sky-orbit-layout';

/**
 * Where the picture sets the figures a stop gave it (D-382, V3 F4 and F7): the nearest and farthest distance on the orbit views, beside
 * the "you are here" tag, and the hours of daylight of a place in June and in December as two bands of a day on the Sun and Earth view.
 * All of it is placed from the scene alone, so a test can check every label against the frame and against the others. The words are the
 * passage's (its number, unit and place); the picture adds only its own fixed words and never a figure of its own.
 */

const SHORT_UNITS: Readonly<Record<string, string>> = {
  kilometres: 'km',
  kilometers: 'km',
  kilometre: 'km',
  kilometer: 'km',
  miles: 'mi',
  mile: 'mi',
};

/**
 * A distance as the picture's small mono text has room for ("91.4 M mi"): millions written with an M and a common unit
 * shortened. The number and the unit are the passage's; the text version of the stage says them in full.
 */
export function compactFigure(figure: Pick<StageFigure, 'value' | 'unit'>): string {
  const unit = SHORT_UNITS[figure.unit.trim().toLowerCase()] ?? figure.unit;
  return figure.value >= 1e6
    ? `${formatFigure(Number((figure.value / 1e6).toPrecision(6)))} M ${unit}`
    : `${formatFigure(figure.value)} ${unit}`;
}

const figureOf = (scene: Pick<EarthSkyScene, 'figures'>, slot: StageFigure['slot']): StageFigure | undefined =>
  scene.figures.find((figure) => figure.slot === slot);

/** One end of the orbit: the dot, the two lines of text that name it and the thin line joining them. */
export interface OrbitEnd {
  readonly dot: Point;
  /** Earth stands on this end, so it needs no dot of its own. */
  readonly earthOnIt: boolean;
  readonly name: SceneLabel;
  readonly value: SceneLabel;
  readonly leader: { readonly from: Point; readonly to: Point };
}

export interface DistanceMarks {
  /** The dotted line through the Sun from the nearest point to the farthest. */
  readonly axis: { readonly from: Point; readonly to: Point };
  readonly nearest: OrbitEnd | undefined;
  readonly farthest: OrbitEnd | undefined;
  /** What the picture says beside the Sun: it is drawn larger than it is. */
  readonly sunCaption: SceneLabel;
  /** The pin on Earth (its tip, and whether it stands above Earth) and the words beside it. */
  readonly here: { readonly pin: Point; readonly pinUp: boolean; readonly label: SceneLabel };
}

const MONTH_TEXT = (month: EarthSkyScene['month']): string => month.toUpperCase();

/** What the orbit view already draws and the new marks keep clear of: the months' names and the Earths with their axes. */
function orbitObstacles(scene: EarthSkyScene): readonly Box[] {
  const layout = orbitLayout(scene);
  return [
    ...layout.months.flatMap((mark) => [labelBox(mark.label), ...(mark.pale ? [mark.pale.extent] : [])]),
    inflate(layout.earth, 2),
  ];
}

function endOf(scene: EarthSkyScene, figure: StageFigure | undefined, side: 'left' | 'right'): OrbitEnd | undefined {
  if (figure === undefined) return undefined;
  const { centre, halfWidth } = orbitFrame(scene);
  const left = side === 'left';
  const x = left ? 6 : SCENE_WIDTH - 6;
  const anchor = left ? 'start' : 'end';
  const dot = { x: centre.x + (left ? -halfWidth : halfWidth), y: centre.y };
  return {
    dot,
    earthOnIt: false,
    name: { text: left ? 'NEAREST' : 'FARTHEST', x, y: 13, anchor },
    value: { text: compactFigure(figure), x, y: 23.5, anchor },
    leader: { from: { x: left ? 16 : SCENE_WIDTH - 16, y: 28 }, to: { x: dot.x + (left ? -2 : 2), y: dot.y - 6 } },
  };
}

const boxAround = (at: Point, reach: number): Box => ({
  left: at.x - reach,
  right: at.x + reach,
  top: at.y - reach,
  bottom: at.y + reach,
});

/** The thin line from a label to its end of the orbit, as small boxes along it, so that no words are set across it. */
export function leaderBoxes(leader: OrbitEnd['leader']): Box[] {
  const steps = 10;
  return Array.from({ length: steps + 1 }, (_, step) =>
    boxAround(
      {
        x: leader.from.x + ((leader.to.x - leader.from.x) * step) / steps,
        y: leader.from.y + ((leader.to.y - leader.from.y) * step) / steps,
      },
      2,
    ),
  );
}

/** A label of the given words centred on `x` as far as the frame lets it be, so its words never leave the picture. */
function centred(text: string, x: number, y: number): SceneLabel {
  const half = (text.length * LABEL_CHARACTER_PX) / 2;
  return { text, x: Math.min(SCENE_WIDTH - 2 - half, Math.max(2 + half, x)), y, anchor: 'middle' };
}

/**
 * The words about the Sun stand below it, or above it where an Earth, a label or the frame is in the way, then a little to one
 * side of it, nearest first, and then beside the Sun on the right, above or below the dotted line, where the stretched orbit is too
 * narrow for words under the Sun. They keep off the dashed orbit where there is room for that, and cross it where there is not.
 */
function sunCaptionOf(scene: EarthSkyScene, obstacles: readonly Box[]): SceneLabel {
  const { centre, sun, sunRadius } = orbitFrame(scene);
  const text = 'SUN NOT TO SCALE';
  const rows = [sun.y + sunRadius + 18, sun.y - sunRadius - 14];
  const beside = (y: number): SceneLabel => ({ text, x: sun.x + sunRadius + 14, y, anchor: 'start' });
  const candidates = [
    ...[0, -24, 24, -48, 48, -72, 72].flatMap((shift) => rows.map((y) => centred(text, sun.x + shift, y))),
    beside(centre.y - 5),
    beside(centre.y + 13),
  ];
  return (
    freeAmong(candidates, [...obstacles, ...orbitLine(orbitLayout(scene).frame)]) ?? firstFree(candidates, obstacles)
  );
}

/** How high the pin and the room it needs above Earth, in frame units. */
const PIN_HEIGHT = 13;

/** How far sideways, in frame units, the "you are here" words are tried from straight above or below Earth, at most. */
const HERE_SHIFTS = [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90, 120, -120, 150, -150] as const;

/**
 * The pin on Earth and the "you are here" words. The pin stands above Earth, or below it, upside down, when Earth is so high
 * in the frame that the pin and its words would be cut off. The words are tried beyond the pin, then on the other side of Earth,
 * then beside it, each moved sideways a step at a time, nearest to Earth first, and then in any row of the frame, and take the
 * first place that fits the frame and covers nothing.
 */
function hereOf(scene: EarthSkyScene, obstacles: readonly Box[]): DistanceMarks['here'] {
  const { earth, earthRadius } = orbitFrame(scene);
  const text = `YOU ARE HERE · ${MONTH_TEXT(scene.month)}`;
  const wordsHeight = 12;
  const up = earth.y - earthRadius - 4 - PIN_HEIGHT - wordsHeight - 8 >= 0;
  const beyond = up ? earth.y - earthRadius - PIN_HEIGHT - wordsHeight : earth.y + earthRadius + PIN_HEIGHT + 16;
  // On the far side of Earth the words stand just off the end of its axis.
  const extent = orbitLayout(scene).earth;
  const opposite = up ? extent.bottom + 11 : extent.top - 4;
  const outward = up ? -22 : 22;
  const rows = [beyond, opposite, beyond + outward, opposite - outward];
  const beside: SceneLabel[] = [
    { text, x: earth.x + earthRadius + 7, y: earth.y + 3, anchor: 'start' },
    { text, x: earth.x - earthRadius - 7, y: earth.y + 3, anchor: 'end' },
  ];
  // Each place is weighed by how far it is from straight above (or below) Earth and how many rows out it is.
  const above = rows.flatMap((y, row) =>
    HERE_SHIFTS.map((shift) => ({ label: centred(text, earth.x + shift, y), cost: Math.abs(shift) + row * 20 })),
  );
  // Where none of those is free, any row of the frame, nearest to Earth first.
  const anywhere = Array.from({ length: 31 }, (_, row) => 8 + row * 6).flatMap((y) =>
    HERE_SHIFTS.map((shift) => ({
      label: centred(text, earth.x + shift, y),
      cost: 100 + Math.abs(y - earth.y) + Math.abs(shift),
    })),
  );
  const candidates = [...above, ...beside.map((label) => ({ label, cost: 25 })), ...anywhere]
    .sort((first, second) => first.cost - second.cost)
    .map(({ label }) => label);
  const line = orbitLine(orbitLayout(scene).frame);
  const label = freeAmong(candidates, [...obstacles, ...line]) ?? firstFree(candidates, obstacles);
  return { pin: { x: earth.x, y: earth.y + (up ? -earthRadius - 4 : earthRadius + 4) }, pinUp: up, label };
}

/**
 * The marks of a distance picture, or none when the state carries no distance (D-382). Both ends are drawn when both are
 * stated; one figure gets its own end and the dotted line still runs through the Sun. Everything is placed clear of what the
 * orbit view already draws (the month names, the pale Earths, the Earth of the month, the Sun and the line through the Sun) and of the other marks.
 */
export function distanceMarks(scene: EarthSkyScene): DistanceMarks | undefined {
  const near = figureOf(scene, 'nearest');
  const far = figureOf(scene, 'farthest');
  if ((scene.view !== 'orbit' && scene.view !== 'orbit-stretched') || (near === undefined && far === undefined))
    return undefined;
  const { centre, halfWidth, sun, sunRadius, earth, earthRadius } = orbitFrame(scene);
  const nearest = endOf(scene, near, 'left');
  const farthest = endOf(scene, far, 'right');
  const sunBox = boxAround(sun, sunRadius + 10);
  const axisBox: Box = { left: 0, right: SCENE_WIDTH, top: centre.y - 2, bottom: centre.y + 2 };
  const fixed = [
    ...orbitObstacles(scene),
    ...[nearest, farthest].flatMap((end) =>
      end === undefined ? [] : [labelBox(end.name), labelBox(end.value), ...leaderBoxes(end.leader)],
    ),
  ];
  const sunCaption = sunCaptionOf(scene, [...fixed, axisBox]);
  const here = hereOf(scene, [...fixed, labelBox(sunCaption), sunBox, axisBox]);
  const standingOn = (end: OrbitEnd | undefined): OrbitEnd | undefined =>
    end === undefined
      ? end
      : { ...end, earthOnIt: Math.hypot(end.dot.x - earth.x, end.dot.y - earth.y) <= earthRadius };
  return {
    axis: { from: { x: centre.x - halfWidth, y: centre.y }, to: { x: centre.x + halfWidth, y: centre.y } },
    nearest: standingOn(nearest),
    farthest: standingOn(farthest),
    sunCaption,
    here,
  };
}

/** One band of a day: its words, the whole day as a bar and how much of it is light. */
export interface DayBand {
  readonly slot: 'june-daylight' | 'december-daylight';
  readonly label: SceneLabel;
  readonly bar: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The width of the lit part of the bar: the hours of daylight over the hours of a day. */
  readonly lit: number;
}

const BAND = { x: 8, width: 150, height: 8, firstY: 160, rowHeight: 22 } as const;
/** The longest place name a band's words carry before they are cut, so the words stay inside the frame. */
const PLACE_CHARS = 20;

/** A place name as a band says it: in capitals, and cut at a word with an ellipsis when it is longer than `PLACE_CHARS`. */
function shortPlace(place: string): string {
  const upper = place.trim().toUpperCase();
  if (upper.length <= PLACE_CHARS) return upper;
  const room = upper.slice(0, PLACE_CHARS - 1);
  const atWord = upper.charAt(PLACE_CHARS - 1) === ' ' ? room : room.replace(/\s+\S*$/u, '');
  return `${atWord.trimEnd()}…`;
}
const HOURS_IN_A_DAY = 24;

/** The bands of the daylight figures a state carries, June above December, or none. */
export function dayBands(scene: EarthSkyScene): readonly DayBand[] {
  if (scene.view !== 'sun-earth') return [];
  const bands: DayBand[] = [];
  for (const [slot, month] of [
    ['june-daylight', 'JUNE'],
    ['december-daylight', 'DECEMBER'],
  ] as const) {
    const figure = figureOf(scene, slot);
    if (figure === undefined) continue;
    const top = BAND.firstY + bands.length * BAND.rowHeight;
    bands.push({
      slot,
      label: {
        text: `${month} · ${shortPlace(figure.place ?? '')} · ${formatFigure(figure.value)} ${figure.unit.toUpperCase()}`,
        x: BAND.x,
        y: top,
        anchor: 'start',
      },
      bar: { x: BAND.x, y: top + 4, width: BAND.width, height: BAND.height },
      lit: (Math.min(figure.value, HOURS_IN_A_DAY) / HOURS_IN_A_DAY) * BAND.width,
    });
  }
  return bands;
}
