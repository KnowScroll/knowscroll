import { z } from '../zod.js';
import { Formula } from '../blocks/simulation.js';
import { CALLOUT_KINDS } from '../blocks/text.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';

/**
 * `scroll-authoring.v1`: the forgiving shape a writer model authors. Plain strings stand in for
 * rich text, diagrams name nodes by short ids, simulations list parameters and outputs, and every
 * block says which offered evidence passages it rests on (`cites`). Deterministic code converts
 * it into the canonical `scroll-draft.v1` (`convertAuthored`) and then runs every canonical check;
 * nothing here is trusted beyond its structure and bounds.
 *
 * The schema is deliberately plain objects, arrays and unions so the harness can name the path of
 * every finding (`sections[1].blocks[2].items`) without reading the rejected values.
 */
export const SCROLL_AUTHORING_VERSION = 'scroll-authoring.v1';

/** Trimmed text of bounded length; control characters and line breaks are cleaned by the converter. */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
/**
 * Titles, labels and other single-line text a layout shortens anyway: up to twice the canonical
 * length is accepted and the converter cuts it to the limit at a word boundary, so a label that is
 * a little long does not cost the whole Scroll. Prose and anything with placeholders stays strict.
 */
const short = (max: number) => text(1, max * 2);
/** Optional text; an empty string means "none" (the converter drops it). */
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalShort = (max: number) => optionalText(max * 2);
const evidenceHandle = text(1, 12);

/** Offered evidence passages (`e1`, `e2`, …) this block rests on. */
const cites = z.array(evidenceHandle).min(1).max(12);

const paragraph = z.object({ type: z.literal('paragraph'), cites, text: text(1, FIELD_LIMITS.paragraphChars) });

const list = z.object({
  type: z.literal('list'),
  cites,
  style: z.enum(['bullet', 'number']).optional(),
  items: z.array(text(1, FIELD_LIMITS.listItemChars)).min(2).max(FIELD_LIMITS.listItems),
});

const callout = z.object({
  type: z.literal('callout'),
  cites,
  kind: z.enum(CALLOUT_KINDS),
  title: optionalShort(FIELD_LIMITS.calloutTitleChars),
  text: text(1, FIELD_LIMITS.calloutChars),
});

const comparison = z.object({
  type: z.literal('comparison'),
  cites,
  title: short(100),
  columns: z
    .array(
      z.object({
        label: short(60),
        points: z.array(text(1, FIELD_LIMITS.comparisonPointChars)).min(1).max(FIELD_LIMITS.comparisonPoints),
      }),
    )
    .min(2)
    .max(FIELD_LIMITS.comparisonColumns),
});

const timeline = z.object({
  type: z.literal('timeline'),
  cites,
  title: short(100),
  events: z
    .array(z.object({ when: short(32), title: short(80), detail: optionalText(400) }))
    .min(2)
    .max(FIELD_LIMITS.timelineEvents),
});

const sequence = z.object({
  type: z.literal('sequence'),
  cites,
  title: short(100),
  steps: z
    .array(z.object({ title: short(80), text: text(1, FIELD_LIMITS.stepChars) }))
    .min(2)
    .max(FIELD_LIMITS.sequenceSteps),
});

/** Layouts a model can use without grid coordinates: code places the nodes. */
export const AUTHORED_DIAGRAM_LAYOUTS = ['flow-lr', 'flow-tb', 'radial', 'cycle', 'layers'] as const;
export const AUTHORED_NODE_KINDS = ['entity', 'process', 'store', 'actor', 'note'] as const;

const diagram = z.object({
  type: z.literal('diagram'),
  cites,
  title: short(100),
  instruction: optionalShort(120),
  layout: z.enum(AUTHORED_DIAGRAM_LAYOUTS).optional(),
  /** `toggle`: one button per frame (default). `steps`: Previous and Next through the frames. */
  interaction: z.enum(['toggle', 'steps']).optional(),
  nodes: z
    .array(
      z.object({
        id: text(1, 40).optional(),
        label: short(FIELD_LIMITS.diagramLabelChars),
        kind: z.enum(AUTHORED_NODE_KINDS).optional(),
      }),
    )
    .min(2)
    .max(LIMITS.diagramNodes),
  edges: z
    .array(
      z.object({
        id: text(1, 40).optional(),
        from: text(1, 40),
        to: text(1, 40),
        label: optionalShort(FIELD_LIMITS.diagramLabelChars),
        dashed: z.boolean().optional(),
      }),
    )
    .max(LIMITS.diagramEdges),
  frames: z
    .array(
      z.object({
        label: short(40),
        description: text(10, FIELD_LIMITS.frameDescriptionChars),
        /** Node or edge ids this state draws attention to. */
        highlight: z
          .array(text(1, 40))
          .max(LIMITS.diagramNodes + LIMITS.diagramEdges)
          .optional(),
        /** Node or edge ids this state hides. */
        hide: z
          .array(text(1, 40))
          .max(LIMITS.diagramNodes + LIMITS.diagramEdges)
          .optional(),
      }),
    )
    .min(2)
    .max(LIMITS.diagramFrames),
});

const axisLabel = short(40);
const unit = optionalShort(16);

const barChart = z.object({
  type: z.literal('bar-chart'),
  cites,
  title: short(100),
  caption: optionalShort(FIELD_LIMITS.captionChars),
  horizontal: z.boolean().optional(),
  categories: z.array(short(24)).min(1).max(FIELD_LIMITS.barCategories),
  series: z
    .array(z.object({ label: short(40), values: z.array(z.number()).min(1).max(FIELD_LIMITS.barCategories) }))
    .min(1)
    .max(FIELD_LIMITS.chartSeries),
  axisLabel,
  axisUnit: unit,
});

const lineChart = z.object({
  type: z.literal('line-chart'),
  cites,
  title: short(100),
  caption: optionalShort(FIELD_LIMITS.captionChars),
  xLabel: axisLabel,
  xUnit: unit,
  yLabel: axisLabel,
  yUnit: unit,
  series: z
    .array(
      z.object({
        label: short(40),
        points: z
          .array(z.tuple([z.number(), z.number()]))
          .min(2)
          .max(LIMITS.chartPoints),
      }),
    )
    .min(1)
    .max(FIELD_LIMITS.chartSeries),
});

const simulation = z.object({
  type: z.literal('simulation'),
  cites,
  title: short(100),
  prompt: optionalShort(120),
  params: z
    .array(
      z.object({
        key: text(1, 24),
        label: short(60),
        unit,
        min: z.number(),
        max: z.number(),
        step: z.number(),
        default: z.number(),
      }),
    )
    .min(1)
    .max(LIMITS.paramsPerBlock),
  constants: z
    .array(z.object({ key: text(1, 24), label: short(60), value: z.number(), unit }))
    .max(FIELD_LIMITS.constants)
    .optional(),
  outputs: z
    .array(
      z.object({
        key: text(1, 24),
        label: short(60),
        unit,
        decimals: z.number().int().min(0).max(4).optional(),
        formula: Formula,
      }),
    )
    .min(1)
    .max(FIELD_LIMITS.outputs),
  /** What the reader sees: one large number (default), the output as a curve over the first parameter, or every output side by side. */
  view: z.enum(['readout', 'plot', 'cards']).optional(),
  /** A sentence with `{key}` placeholders for parameters and outputs. */
  readout: optionalText(FIELD_LIMITS.templateChars),
  /** Units, assumptions and limits of this simplified model. */
  note: text(10, 240),
});

/** Starts a new section. Blocks before the first heading form an opening section without one. */
const heading = z.object({ type: z.literal('heading'), text: short(FIELD_LIMITS.headingChars) });

export const AuthoredBlock = z.discriminatedUnion('type', [
  heading,
  paragraph,
  list,
  callout,
  comparison,
  timeline,
  sequence,
  diagram,
  barChart,
  lineChart,
  simulation,
]);
export type AuthoredBlock = z.infer<typeof AuthoredBlock>;
export type AuthoredBlockType = AuthoredBlock['type'];

/**
 * The whole document is one flat list of blocks: a heading block starts a new section. Flat on
 * purpose: a model that writes long nested JSON tends to lose count of the closing brackets
 * between sections.
 */
export const AuthoredScroll = z.object({
  title: short(FIELD_LIMITS.titleChars),
  dek: z
    .string()
    .trim()
    .min(10)
    .max(FIELD_LIMITS.dekChars * 2),
  blocks: z.array(AuthoredBlock).min(1).max(LIMITS.blocks),
});
export type AuthoredScroll = z.infer<typeof AuthoredScroll>;
