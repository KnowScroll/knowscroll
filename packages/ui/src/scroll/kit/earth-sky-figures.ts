import { formatFigure, type StageFigure } from '../model';
import {
  CARDINAL_MONTHS,
  MONTH_ANGLE_DEGREES,
  onEllipse,
  orbitFrame,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type EarthSkyScene,
  type Point,
} from './earth-sky-scene';

/**
 * Where the picture sets the figures a stop gave it (D-381, V3 F4 and F7): the nearest and farthest distance on the orbit views, beside
 * the "you are here" tag, and the hours of daylight of a place in June and in December as two bands of a day on the Sun and Earth view.
 * All of it is placed from the scene alone, so a test can check every label against the frame and against the others. The words are the
 * passage's (its number, unit and place); the picture adds only its own fixed words and never a figure of its own.
 */

export type Anchor = 'start' | 'middle' | 'end';

/** A line of mono text at 8.5 px, anchored at its start, middle or end. */
export interface SceneLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: Anchor;
}

/** The mono face at 8.5 px is about this many frame units a character (the layout tests keep a margin). */
export const LABEL_CHARACTER_PX = 5.4;
const LABEL_HEIGHT = 9.5;

export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** The box a label takes, estimated from its text. */
export function labelBox(label: SceneLabel): Box {
  const width = label.text.length * LABEL_CHARACTER_PX;
  const left = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - width : label.x - width / 2;
  return { left, right: left + width, top: label.y - 8, bottom: label.y - 8 + LABEL_HEIGHT };
}

const overlap = (first: Box, second: Box): boolean =>
  first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;

/** The phone's TEXT pill covers the lower right corner of the frame, from this x and y on. */
export const TEXT_PILL = { left: 272, top: 186 } as const;

/** A label sits inside the frame and clear of the TEXT pill. */
function fits(box: Box): boolean {
  return (
    box.left >= 2 &&
    box.right <= SCENE_WIDTH - 2 &&
    box.top >= 0 &&
    box.bottom <= SCENE_HEIGHT &&
    !(box.right > TEXT_PILL.left && box.bottom > TEXT_PILL.top)
  );
}

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
  /** The pin on Earth and the words beside it. */
  readonly here: { readonly pin: Point; readonly label: SceneLabel };
}

const MONTH_TEXT = (month: EarthSkyScene['month']): string => month.toUpperCase();

/** The labels the orbit views already draw (a month at each of the four turning points), so the new ones keep clear of them. */
function monthLabels(scene: Pick<EarthSkyScene, 'orbitRatio' | 'sunOffset' | 'earthAngle'>): SceneLabel[] {
  const { centre, halfWidth, halfHeight } = orbitFrame(scene);
  return CARDINAL_MONTHS.map((month) => {
    const at = onEllipse(centre, halfWidth + 22, halfHeight + 16, MONTH_ANGLE_DEGREES[month]);
    return { text: MONTH_TEXT(month), x: at.x, y: at.y + 3, anchor: 'middle' as const };
  });
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
    name: { text: left ? 'NEAREST' : 'FARTHEST', x, y: 13, anchor },
    value: { text: compactFigure(figure), x, y: 23.5, anchor },
    leader: { from: { x: left ? 16 : SCENE_WIDTH - 16, y: 28 }, to: { x: dot.x + (left ? -2 : 2), y: dot.y - 6 } },
  };
}

/** The "you are here" words stand where they collide with nothing: above Earth, then below it, then at its right, then its left. */
function hereLabel(scene: EarthSkyScene, others: readonly SceneLabel[]): SceneLabel {
  const { earth, earthRadius } = orbitFrame(scene);
  const text = `YOU ARE HERE · ${MONTH_TEXT(scene.month)}`;
  const candidates: SceneLabel[] = [
    { text, x: earth.x, y: earth.y - earthRadius - 17, anchor: 'middle' },
    { text, x: earth.x, y: earth.y + earthRadius + 16, anchor: 'middle' },
    { text, x: earth.x + earthRadius + 7, y: earth.y + 3, anchor: 'start' },
    { text, x: earth.x - earthRadius - 7, y: earth.y + 3, anchor: 'end' },
  ];
  const taken = others.map(labelBox);
  const free = candidates.find((candidate) => {
    const box = labelBox(candidate);
    return fits(box) && taken.every((other) => !overlap(box, other));
  });
  return free ?? candidates[1] ?? candidates[0]!;
}

/**
 * The marks of a distance picture, or none when the state carries no distance (D-381). Both ends are drawn when both are
 * stated; one figure gets its own end and the dotted line still runs through the Sun.
 */
export function distanceMarks(scene: EarthSkyScene): DistanceMarks | undefined {
  const near = figureOf(scene, 'nearest');
  const far = figureOf(scene, 'farthest');
  if ((scene.view !== 'orbit' && scene.view !== 'orbit-stretched') || (near === undefined && far === undefined))
    return undefined;
  const { centre, halfWidth, sun, sunRadius, earth, earthRadius } = orbitFrame(scene);
  const nearest = endOf(scene, near, 'left');
  const farthest = endOf(scene, far, 'right');
  const sunCaption: SceneLabel = { text: 'SUN NOT TO SCALE', x: sun.x, y: sun.y + sunRadius + 18, anchor: 'middle' };
  const fixed = [
    ...monthLabels(scene),
    sunCaption,
    ...[nearest, farthest].flatMap((end) => (end === undefined ? [] : [end.name, end.value])),
  ];
  return {
    axis: { from: { x: centre.x - halfWidth, y: centre.y }, to: { x: centre.x + halfWidth, y: centre.y } },
    nearest,
    farthest,
    sunCaption,
    here: {
      pin: { x: earth.x, y: earth.y - earthRadius - 4 },
      label: hereLabel(scene, fixed),
    },
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
        text: `${month} · ${(figure.place ?? '').toUpperCase().slice(0, PLACE_CHARS)} · ${formatFigure(figure.value)} ${figure.unit.toUpperCase()}`,
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
