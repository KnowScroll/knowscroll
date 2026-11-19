import { z } from '../zod.js';
import { LocalId, plainText } from '../primitives.js';
import { FIELD_LIMITS_V3 as F } from './limits.js';

/**
 * The picture kinds of `scroll-document.v3` (#756, decision A1): a closed set of things one general renderer draws.
 * A picture is data the writer fills with words, cited numbers and choices from closed lists; code lays it out, draws
 * it and derives its words. Nothing in a picture is a colour, a coordinate, markup or a size in pixels. The one
 * position a writer gives is a plan's coarse cell, the way the v1 `diagram` grid already allows.
 *
 * A kind is added by adding its data here, its state rules and words in `picture-rules.ts`, and its drawing in
 * `packages/ui/src/scroll/picture`. No picture in document v3 names a drawing kit.
 */
export const PICTURE_KINDS = ['statement', 'flow', 'cycle', 'grid', 'chart', 'plan'] as const;
export type PictureKind = (typeof PICTURE_KINDS)[number];

/**
 * What an item means, never what colour it is: `warm` for heat, light or danger, `cool` for cold or water, `mark` for
 * the one thing the text is pointing at. The renderer maps each to a fixed colour that reads on both page grounds.
 */
export const TONES = ['warm', 'cool', 'mark'] as const;
export const Tone = z.enum(TONES);
export type Tone = z.infer<typeof Tone>;

/**
 * One named thing in a picture: a step, a place on a ring, a cell's row. Its `id` is what a linked phrase names and
 * what a state lights. `note` is the sentence a reader is given when the item is picked or reached by a scrub.
 */
export const PictureItem = z.strictObject({
  id: LocalId,
  label: plainText(1, F.itemLabelChars),
  note: plainText(1, F.itemNoteChars).optional(),
  tone: Tone.optional(),
});
export type PictureItem = z.infer<typeof PictureItem>;

/**
 * A figure as a passage writes it (D-208): digits with an optional sign, thousands commas and decimals (`"147"`,
 * `"93.6"`, `"1,000"`, `"-12"`). Its words and unit are other fields, so a value can be found in a cited passage
 * exactly as written.
 */
export const FigureText = z
  .string()
  .max(F.valueChars)
  .regex(/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u, { message: 'figure_format' });

const head = {
  id: LocalId,
  /** What the picture is of, in a few words: the figure's name for a screen reader and its heading in text. */
  title: plainText(1, F.pictureTitleChars),
  /** A short line under the picture, such as "Schematic, after John Snow's 1855 map". */
  caption: plainText(1, F.captionChars).optional(),
};

/** A typographic picture: the one picture every Scroll can have (decision D1). */
export const StatementBody = z.discriminatedUnion('form', [
  /** One number and what it is: "23.4°", "Earth's lean". */
  z.strictObject({
    form: z.literal('number'),
    value: plainText(1, F.valueChars),
    label: plainText(1, F.pictureTitleChars),
    tone: Tone.optional(),
  }),
  /** One quotation, set large, with who said it, where and when. */
  z.strictObject({
    form: z.literal('quote'),
    text: plainText(1, F.quoteChars),
    who: plainText(1, F.citeChars),
    work: plainText(1, F.citeChars).optional(),
    year: plainText(1, 12).optional(),
  }),
  /** A short labelled list. */
  z.strictObject({ form: z.literal('list'), items: z.array(PictureItem).min(2).max(5) }),
]);
export type StatementBody = z.infer<typeof StatementBody>;

export const StatementPicture = z.strictObject({ ...head, kind: z.literal('statement'), statement: StatementBody });

/** Steps in order, an arrow from each to the next: a process, or a chain of causes. */
export const FlowPicture = z.strictObject({
  ...head,
  kind: z.literal('flow'),
  steps: z.array(PictureItem).min(2).max(6),
});

/** Items around a ring, each leading to the next and the last back to the first, with an optional thing at the centre. */
export const CyclePicture = z.strictObject({
  ...head,
  kind: z.literal('cycle'),
  centre: PictureItem.optional(),
  items: z.array(PictureItem).min(3).max(8),
});

export const GRID_CELL_SIZES = ['small', 'large'] as const;

/**
 * A table of short cells under row and column headings: a 2 × 2 of choices, or a comparison. `size` lets one cell
 * outweigh the rest ("three small costs, one huge one"); it is a meaning the renderer draws, never a measurement.
 */
export const GridPicture = z.strictObject({
  ...head,
  kind: z.literal('grid'),
  columns: z
    .array(z.strictObject({ id: LocalId, label: plainText(1, F.itemLabelChars) }))
    .min(1)
    .max(3),
  rows: z
    .array(z.strictObject({ id: LocalId, label: plainText(1, F.itemLabelChars) }))
    .min(1)
    .max(4),
  cells: z
    .array(
      z.strictObject({
        id: LocalId,
        row: LocalId,
        column: LocalId,
        text: plainText(1, F.cellTextChars),
        size: z.enum(GRID_CELL_SIZES).optional(),
        tone: Tone.optional(),
        note: plainText(1, F.itemNoteChars).optional(),
      }),
    )
    .min(1)
    .max(12),
});

export const CHART_FORMS = ['bars', 'line'] as const;

/**
 * Bars or a line of cited numbers. Each value is a figure as its passage writes it (D-208), and the scale is code's.
 * `values: 'hidden'` draws the shape without printing the numbers, for a chart whose exact figures the text should
 * not stress; the text version still states them.
 */
export const ChartPicture = z.strictObject({
  ...head,
  kind: z.literal('chart'),
  form: z.enum(CHART_FORMS),
  unit: plainText(1, F.unitChars).optional(),
  values: z.enum(['shown', 'hidden']),
  points: z
    .array(
      z.strictObject({
        id: LocalId,
        label: plainText(1, 24),
        value: FigureText,
        tone: Tone.optional(),
        note: plainText(1, F.itemNoteChars).optional(),
      }),
    )
    .min(2)
    .max(16),
  /** Points the chart labels on the drawing itself ("Handle removed"). */
  marks: z.array(z.strictObject({ point: LocalId, label: plainText(1, F.itemLabelChars) })).max(3),
});

/** A cell of a plan's coarse grid. A plan is at most 12 × 12, so a cell names a block, never a point. */
export const PlanCell = z.strictObject({
  column: z.number().int().min(0).max(11),
  row: z.number().int().min(0).max(11),
});
export type PlanCell = z.infer<typeof PlanCell>;

export const PLAN_MARKS = ['dot', 'block', 'ring'] as const;

/**
 * A schematic plan on a coarse grid: straight ways (streets, rivers, wires), places on cells, tallies that pile up at
 * cells (deaths at a house) and can arrive step by step (day by day), regions code works out as "nearer to this place
 * than to any of these others", and routes from place to place. It is a diagram, never a map to scale; its caption
 * says what it is drawn after.
 */
export const PlanPicture = z.strictObject({
  ...head,
  kind: z.literal('plan'),
  size: z.strictObject({
    columns: z.number().int().min(6).max(12),
    rows: z.number().int().min(6).max(12),
  }),
  ways: z
    .array(
      z.strictObject({ id: LocalId, label: plainText(1, F.itemLabelChars).optional(), from: PlanCell, to: PlanCell }),
    )
    .max(12),
  places: z
    .array(
      z.strictObject({
        id: LocalId,
        label: plainText(1, F.itemLabelChars),
        at: PlanCell,
        mark: z.enum(PLAN_MARKS),
        tone: Tone.optional(),
        note: plainText(1, F.itemNoteChars).optional(),
      }),
    )
    .min(1)
    .max(12),
  tallies: z
    .array(
      z.strictObject({
        at: PlanCell,
        count: z.number().int().min(1).max(40),
        /** The step (an index of `steps`) at which these arrive; without one they are there from the start. */
        step: z.number().int().min(0).max(11).optional(),
      }),
    )
    .max(64),
  /** The names of the steps tallies arrive in ("31 Aug", "1 Sep" …), in order. */
  steps: z.array(plainText(1, 24)).min(2).max(12).optional(),
  regions: z
    .array(
      z.strictObject({
        id: LocalId,
        label: plainText(1, F.itemLabelChars),
        /** The place whose region it is: every cell nearer to it than to any other place in `among`. */
        nearest: LocalId,
        among: z.array(LocalId).min(2).max(8),
      }),
    )
    .max(3),
  routes: z
    .array(
      z.strictObject({ id: LocalId, label: plainText(1, F.itemLabelChars).optional(), from: LocalId, to: LocalId }),
    )
    .max(4),
});

export const Picture = z.discriminatedUnion('kind', [
  StatementPicture,
  FlowPicture,
  CyclePicture,
  GridPicture,
  ChartPicture,
  PlanPicture,
]);
export type Picture = z.infer<typeof Picture>;
export type PictureOfKind<Kind extends PictureKind> = Extract<Picture, { kind: Kind }>;

/**
 * Which items of a picture a beat shows, and how. One shape for every kind; each kind allows only some keys
 * (`STATE_KEYS`), checked by the validator:
 * - `upTo`: the first n items are drawn and the rest wait (steps of a flow, items of a ring, rows of a grid, points of
 *   a chart).
 * - `lit`: up to four items stand out; the rest recede.
 * - `step`: a plan's tallies up to this step have arrived.
 * - `region`: a plan's region is shaded.
 * An empty state shows the whole picture, nothing lit.
 */
export const PictureState = z.strictObject({
  upTo: z.number().int().min(1).max(16).optional(),
  lit: z.array(LocalId).min(1).max(4).optional(),
  step: z.number().int().min(0).max(11).optional(),
  region: LocalId.optional(),
});
export type PictureState = z.infer<typeof PictureState>;

/** The keys of {@link PictureState} each kind understands. */
export const STATE_KEYS: { readonly [Kind in PictureKind]: readonly (keyof PictureState)[] } = {
  statement: ['lit'],
  flow: ['upTo', 'lit'],
  cycle: ['upTo', 'lit'],
  grid: ['upTo', 'lit'],
  chart: ['upTo', 'lit'],
  plan: ['step', 'lit', 'region'],
};
