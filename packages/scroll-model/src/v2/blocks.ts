import { z } from '../zod.js';
import { plainText } from '../primitives.js';
import { countWords } from '../text.js';
import { FIELD_LIMITS_V2 as F, LIMITS_V2 as L } from './limits.js';

/**
 * The play blocks of a v2 stop (D-207): a sort, a fork, a scale and a growing chart ride on a read
 * stop as its `interactive`, and a guide's line as its `guide`. Everything here is data the writer
 * fills in from words and cited figures: nothing is drawn, laid out or written as markup by the model.
 * The reader draws each from its own parts. Interactions are played on the device and report nothing
 * (D-063, D-209): there is no value to carry and no kind for it.
 */

export const INTERACTIVE_KINDS = ['sort', 'fork', 'scale', 'chart'] as const;
export type InteractiveKind = (typeof INTERACTIVE_KINDS)[number];

/** The words a passage puts after a figure ("8.3 million"): a figure and one of them make a value. */
export const MAGNITUDES = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 } as const;
export type Magnitude = keyof typeof MAGNITUDES;

export const SCALE_AXES = ['linear', 'log'] as const;
export const CHART_SHAPES = ['bars', 'line'] as const;

/** The characters a recipe may give a Scroll as its guide. One today: Ray, the sunbeam. */
export const GUIDE_CHARACTERS = ['ray'] as const;
export type GuideCharacter = (typeof GUIDE_CHARACTERS)[number];
/** How the guide looks while it speaks: a face of the drawing kit, never a sentence. */
export const GUIDE_POSES = ['smile', 'wonder', 'point'] as const;

/** A labelled number of a scale or a chart. It is a figure the cited passages state, never one made up (D-208). */
export const SeriesPoint = z.strictObject({
  label: plainText(1, F.pointLabelChars),
  value: z.number().min(0).max(1e15),
});
export type SeriesPoint = z.infer<typeof SeriesPoint>;

/**
 * Put the items in order. `items` are in the order they are shown; `order[n]` is the index in `items`
 * of the one that comes n-th. The reader checks the person's order against `order`: the document is the
 * answer key, as for a call (D-181), and nothing is sent about the attempt.
 */
export const SortBlock = z.strictObject({
  type: z.literal('sort'),
  items: z.array(plainText(1, F.sortItemChars)).min(L.sortItems.min).max(L.sortItems.max),
  order: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(L.sortItems.max - 1),
    )
    .min(L.sortItems.min)
    .max(L.sortItems.max),
  /** Shown once the order is revealed: why it goes this way. */
  explain: plainText(1, F.explainChars),
});
export type SortBlock = z.infer<typeof SortBlock>;

/** Choose a path: both branches are written, one is read now and the other stays to be read. They rejoin at the next stop. */
export const ForkBlock = z.strictObject({
  type: z.literal('fork'),
  prompt: plainText(1, F.promptChars),
  branches: z
    .array(z.strictObject({ label: plainText(1, F.branchLabelChars), text: plainText(1, F.branchChars) }))
    .min(2)
    .max(2),
});
export type ForkBlock = z.infer<typeof ForkBlock>;

/**
 * A value placed on a line, with a point marked "you are here". `points` are in rising order of value. The
 * zoom stops are derived from the points (each point from the second on is a wider view), so the writer
 * chooses no range and no coordinate.
 */
export const ScaleBlock = z.strictObject({
  type: z.literal('scale'),
  axis: z.enum(SCALE_AXES),
  unit: plainText(1, F.unitChars),
  points: z.array(SeriesPoint).min(L.scalePoints.min).max(L.scalePoints.max),
  /** The index of the point that is "you are here". */
  here: z
    .number()
    .int()
    .min(0)
    .max(L.scalePoints.max - 1)
    .optional(),
});
export type ScaleBlock = z.infer<typeof ScaleBlock>;

/** A chart that grows: the reader reveals its points in order. Every value is a figure of a cited passage. */
export const GrowingChart = z.strictObject({
  type: z.literal('chart'),
  shape: z.enum(CHART_SHAPES),
  unit: plainText(1, F.unitChars),
  points: z.array(SeriesPoint).min(L.chartPoints.min).max(L.chartPoints.max),
});
export type GrowingChart = z.infer<typeof GrowingChart>;

export const Interactive = z.discriminatedUnion('type', [SortBlock, ForkBlock, ScaleBlock, GrowingChart]);
export type Interactive = z.infer<typeof Interactive>;

/** A line from the Scroll's guide character on a read stop. The recipe picks the character; the writer picks the pose and the line. */
export const Guide = z.strictObject({
  character: z.enum(GUIDE_CHARACTERS),
  pose: z.enum(GUIDE_POSES),
  line: plainText(1, F.guideChars),
});
export type Guide = z.infer<typeof Guide>;

const wordsOf = (texts: readonly string[]): number => texts.reduce((total, text) => total + countWords(text), 0);

/** The words a reader reads in an interactive: a fork counts the longer branch, as a call counts the longer path. */
export function interactiveWords(interactive: Interactive): number {
  switch (interactive.type) {
    case 'sort':
      return wordsOf([...interactive.items, interactive.explain]);
    case 'fork':
      return (
        countWords(interactive.prompt) +
        Math.max(...interactive.branches.map((branch) => countWords(branch.label) + countWords(branch.text)))
      );
    case 'scale':
    case 'chart':
      return wordsOf([interactive.unit, ...interactive.points.map((point) => point.label)]);
  }
}

/** The indexes of a sort's items in the order the person must put them: the answer key as a sequence. */
export function sortedItems(sort: Pick<SortBlock, 'items' | 'order'>): string[] {
  return sort.order.map((index) => sort.items[index] ?? '');
}

/** Whether `attempt` (indexes into `items`, in the order the person placed them) is the document's order. */
export function isSortRight(sort: Pick<SortBlock, 'order'>, attempt: readonly number[]): boolean {
  return attempt.length === sort.order.length && attempt.every((index, place) => index === sort.order[place]);
}

/** How many items of an attempt stand in the place the document gives them. */
export function sortPlacedRight(sort: Pick<SortBlock, 'order'>, attempt: readonly number[]): number {
  return attempt.filter((index, place) => index === sort.order[place]).length;
}

/** A figure as a reader sees it: thousands grouped, no trailing zeros ("152", "1.52", "4,096"). */
export function formatFigure(value: number): string {
  const [integer = '0', fraction] = value.toFixed(4).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const trimmed = (fraction ?? '').replace(/0+$/u, '');
  return trimmed === '' ? grouped : `${grouped}.${trimmed}`;
}

/** One point as words: "Earth: 147 million km". */
export const describePoint = (point: SeriesPoint, unit: string): string =>
  `${point.label}: ${formatFigure(point.value)} ${unit}`;

/**
 * The words that stand in for a scale (its text version): the points from the smallest to the largest, and
 * where "you are here" is. Derived from the data, so the text cannot disagree with the drawing.
 */
export function describeScale(scale: ScaleBlock): string {
  const here = scale.here === undefined ? undefined : scale.points[scale.here];
  return [
    `A ${scale.axis === 'log' ? 'logarithmic' : 'linear'} scale in ${scale.unit}, from smallest to largest.`,
    scale.points.map((point) => describePoint(point, scale.unit)).join('; ') + '.',
    ...(here === undefined ? [] : [`You are here: ${here.label}.`]),
  ].join(' ');
}

/** The words that stand in for a chart: its points in order, as a list a table could hold. */
export function describeChart(chart: GrowingChart): string {
  return [
    `A ${chart.shape === 'bars' ? 'bar' : 'line'} chart in ${chart.unit}, in order.`,
    chart.points.map((point) => describePoint(point, chart.unit)).join('; ') + '.',
  ].join(' ');
}

/** The words that stand in for a fork: both paths, so neither has to be chosen to be read. */
export function describeFork(fork: ForkBlock): string {
  return [fork.prompt, ...fork.branches.map((branch) => `${branch.label}: ${branch.text}`)].join(' ');
}
