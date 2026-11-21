import { z } from '../../zod.js';
import { plainText } from '../../primitives.js';
import { ASIDE_KINDS, STOP_EMPHASES } from '../../v2/document.js';
import { FIELD_LIMITS_V3 as F, LIMITS_V3 as L } from '../../v3/limits.js';
import { CHART_FORMS, FigureText, GRID_CELL_SIZES, PLAN_MARKS, PlanCell, Tone } from '../../v3/pictures.js';

/**
 * `scroll-writing-v3.v1`: the shapes a model replies in when it writes a `scroll-document.v3` (#771, WRITER_DESIGN
 * sections 1 to 3). Like the v2 writer's (D-120) they are flat and carry no id: code assigns every id, so the model
 * fills labels, notes and cited values and names things by number or by exact label. Every object is strict and every
 * string has the bound the stored document has, so an oversize or odd field is refused at the model's own path before
 * anything else is read.
 *
 * Three replies use them: arm (a) writes the whole Scroll in one (`WrittenScrollV3`); arm (b) writes the prose first
 * (`WrittenProseV3`) and a second reply stages it (`WrittenStagingV3`: the pictures, and which paragraph shows what).
 */
export const SCROLL_WRITING_V3_VERSION = 'scroll-writing-v3.v1';

/** A model's string: trimmed, then held to the same plain-text rule and bounds as the document's own. */
const written = (min: number, max: number) => z.string().trim().pipe(plainText(min, max));

/** An evidence handle (`e1` … `e99`) naming one offered passage. */
const Handle = z.string().regex(/^e[1-9][0-9]?$/u, { message: 'id_format' });
const Cites = z.array(Handle).min(1).max(8);

/** A reference to a part of a picture by its exact label (a grid cell by its text, so the longest bound applies). */
const Label = written(1, F.cellTextChars);

/** A chart's own labels are shorter than other labels, so the axis stays readable. */
const POINT_LABEL_CHARS = 24;
const STEP_NAME_CHARS = 24;

const itemFields = {
  label: written(1, F.itemLabelChars),
  note: written(1, F.itemNoteChars).optional(),
  tone: Tone.optional(),
};
const Item = z.strictObject(itemFields);

const head = {
  title: written(1, F.pictureTitleChars),
  caption: written(1, F.captionChars).optional(),
  cites: Cites,
};

const StatementBody = z.discriminatedUnion('form', [
  z.strictObject({
    form: z.literal('number'),
    value: written(1, F.valueChars),
    label: written(1, F.pictureTitleChars),
    tone: Tone.optional(),
  }),
  z.strictObject({
    form: z.literal('quote'),
    text: written(1, F.quoteChars),
    who: written(1, F.citeChars),
    work: written(1, F.citeChars).optional(),
    year: written(1, 12).optional(),
  }),
  z.strictObject({ form: z.literal('list'), items: z.array(Item).min(2).max(5) }),
]);

/**
 * A picture as the model writes it: `v3/pictures.ts` without any `id`, with every reference to another part by that
 * part's label (a cell's row and column, a chart mark's point, a region's and a route's places) and with the handles
 * of the passages it rests on. Labels are unique within one picture (`picture_label_duplicate`).
 */
export const WrittenPictureV3 = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('statement'), ...head, statement: StatementBody }),
  z.strictObject({ kind: z.literal('flow'), ...head, steps: z.array(Item).min(2).max(6) }),
  z.strictObject({
    kind: z.literal('cycle'),
    ...head,
    centre: Item.optional(),
    items: z.array(Item).min(3).max(8),
  }),
  z.strictObject({
    kind: z.literal('grid'),
    ...head,
    columns: z
      .array(z.strictObject({ label: written(1, F.itemLabelChars) }))
      .min(1)
      .max(3),
    rows: z
      .array(z.strictObject({ label: written(1, F.itemLabelChars) }))
      .min(1)
      .max(4),
    cells: z
      .array(
        z.strictObject({
          row: Label,
          column: Label,
          text: written(1, F.cellTextChars),
          size: z.enum(GRID_CELL_SIZES).optional(),
          tone: Tone.optional(),
          note: written(1, F.itemNoteChars).optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.strictObject({
    kind: z.literal('chart'),
    ...head,
    form: z.enum(CHART_FORMS),
    unit: written(1, F.unitChars).optional(),
    values: z.enum(['shown', 'hidden']),
    points: z
      .array(
        z.strictObject({
          label: written(1, POINT_LABEL_CHARS),
          value: z.string().trim().pipe(FigureText),
          tone: Tone.optional(),
          note: written(1, F.itemNoteChars).optional(),
        }),
      )
      .min(2)
      .max(16),
    marks: z
      .array(z.strictObject({ point: written(1, POINT_LABEL_CHARS), label: written(1, F.itemLabelChars) }))
      .max(3),
  }),
  z.strictObject({
    kind: z.literal('plan'),
    ...head,
    size: z.strictObject({
      columns: z.number().int().min(6).max(12),
      rows: z.number().int().min(6).max(12),
    }),
    ways: z
      .array(z.strictObject({ label: written(1, F.itemLabelChars).optional(), from: PlanCell, to: PlanCell }))
      .max(12),
    places: z
      .array(
        z.strictObject({
          label: written(1, F.itemLabelChars),
          at: PlanCell,
          mark: z.enum(PLAN_MARKS),
          tone: Tone.optional(),
          note: written(1, F.itemNoteChars).optional(),
        }),
      )
      .min(1)
      .max(12),
    tallies: z
      .array(
        z.strictObject({
          at: PlanCell,
          count: z.number().int().min(1).max(40),
          step: z.number().int().min(0).max(11).optional(),
        }),
      )
      .max(64),
    steps: z.array(written(1, STEP_NAME_CHARS)).min(2).max(12).optional(),
    regions: z
      .array(
        z.strictObject({
          label: written(1, F.itemLabelChars),
          nearest: Label,
          among: z.array(Label).min(2).max(8),
        }),
      )
      .max(3),
    routes: z.array(z.strictObject({ label: written(1, F.itemLabelChars).optional(), from: Label, to: Label })).max(4),
  }),
]);
export type WrittenPictureV3 = z.infer<typeof WrittenPictureV3>;

/** The keys of a picture state, with labels in place of ids (`PictureState`). */
const stateFields = {
  upTo: z.number().int().min(1).max(16).optional(),
  lit: z.array(Label).min(1).max(4).optional(),
  step: z.number().int().min(0).max(11).optional(),
  region: Label.optional(),
};
export const WrittenStateV3 = z.strictObject(stateFields);
export type WrittenStateV3 = z.infer<typeof WrittenStateV3>;

/** The figure after a paragraph: picture number `picture` (counted from 1 in `pictures`), in the state the other keys give. */
export const WrittenShowV3 = z.strictObject({
  picture: z.number().int().min(1).max(L.pictures.max),
  ...stateFields,
});
export type WrittenShowV3 = z.infer<typeof WrittenShowV3>;

/** A phrase of the paragraph (its exact words, once) that names a part of the picture on screen, by label. */
export const WrittenLinkV3 = z.strictObject({ phrase: written(1, F.phraseChars), part: Label });
export type WrittenLinkV3 = z.infer<typeof WrittenLinkV3>;

export const WrittenControlV3 = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('scrub'),
    label: written(1, F.controlLabelChars),
    along: z.enum(['steps', 'items']),
  }),
  z.strictObject({ kind: z.literal('switch'), label: written(1, F.controlLabelChars), to: WrittenStateV3 }),
  z.strictObject({ kind: z.literal('pick'), label: written(1, F.controlLabelChars) }),
]);
export type WrittenControlV3 = z.infer<typeof WrittenControlV3>;

const STAGING_FIELDS = {
  show: WrittenShowV3.optional(),
  links: z.array(WrittenLinkV3).max(L.linksPerBeat).optional(),
};

const paraFields = {
  text: written(1, F.beatChars),
  simple: written(1, F.simpleChars),
  cites: Cites,
};
const quoteFields = {
  ...paraFields,
  who: written(1, F.citeChars),
  work: written(1, F.citeChars).optional(),
  year: written(1, 12).optional(),
};

const section = z.strictObject({ type: z.literal('section'), title: written(1, F.sectionTitleChars) });
const aside = z.strictObject({
  type: z.literal('aside'),
  kind: z.enum(ASIDE_KINDS),
  title: written(1, F.asideTitleChars),
  text: written(1, F.asideChars),
  cites: Cites,
});

/** One item of the prose reply: no picture, show, link, control or emphasis. */
export const WrittenProseItemV3 = z.discriminatedUnion('type', [
  section,
  z.strictObject({ type: z.literal('para'), ...paraFields }),
  z.strictObject({ type: z.literal('quote'), ...quoteFields }),
  aside,
]);
export type WrittenProseItemV3 = z.infer<typeof WrittenProseItemV3>;

/** One item of the whole-Scroll reply: a paragraph may show a picture, link its parts, carry a control and stress. */
export const WrittenItemV3 = z.discriminatedUnion('type', [
  section,
  z.strictObject({
    type: z.literal('para'),
    ...paraFields,
    ...STAGING_FIELDS,
    control: WrittenControlV3.optional(),
    emphasis: z.enum(STOP_EMPHASES).optional(),
  }),
  z.strictObject({ type: z.literal('quote'), ...quoteFields, ...STAGING_FIELDS }),
  aside,
]);
export type WrittenItemV3 = z.infer<typeof WrittenItemV3>;

/** Sections, beats and asides at most, in one flat list. */
const ITEMS_MAX = L.sections.max + L.beats.max + L.asides.max;

const essayFields = {
  title: written(4, 90),
  dek: written(10, 200),
  takeaway: z.strictObject({ text: written(F.takeawayChars.min, F.takeawayChars.max), cites: Cites }),
  askSuggestions: z.array(written(8, F.suggestionChars)).min(1).max(L.askSuggestions),
};

/** Arm (a): the whole Scroll in one reply. */
export const WrittenScrollV3 = z.strictObject({
  ...essayFields,
  pictures: z.array(WrittenPictureV3).min(L.pictures.min).max(L.pictures.max),
  items: z.array(WrittenItemV3).min(1).max(ITEMS_MAX),
});
export type WrittenScrollV3 = z.infer<typeof WrittenScrollV3>;

/** Arm (b), first reply: the essay without a picture. */
export const WrittenProseV3 = z.strictObject({
  ...essayFields,
  items: z.array(WrittenProseItemV3).min(1).max(ITEMS_MAX),
});
export type WrittenProseV3 = z.infer<typeof WrittenProseV3>;

/**
 * Arm (b), second reply: what a paragraph (counted `P1…Pn` over paragraphs and quotations, in reading order) shows,
 * links, controls and stresses, and the pictures themselves. It changes no word. A paragraph not listed shows nothing
 * new, and a paragraph is listed once.
 */
export const WrittenStagingV3 = z.strictObject({
  pictures: z.array(WrittenPictureV3).min(L.pictures.min).max(L.pictures.max),
  stage: z
    .array(
      z.strictObject({
        para: z.number().int().min(1).max(L.beats.max),
        ...STAGING_FIELDS,
        control: WrittenControlV3.optional(),
        emphasis: z.enum(STOP_EMPHASES).optional(),
      }),
    )
    .max(L.beats.max),
});
export type WrittenStagingV3 = z.infer<typeof WrittenStagingV3>;
