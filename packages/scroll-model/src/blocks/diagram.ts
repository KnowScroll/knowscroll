import { z } from '../zod.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import { LocalId, plainText } from '../primitives.js';

const Weight = z.number().min(0).max(1);

export const DiagramNode = z.strictObject({
  id: LocalId,
  label: plainText(1, FIELD_LIMITS.diagramLabelChars),
  kind: z.enum(['entity', 'process', 'store', 'actor', 'note', 'token']),
  group: LocalId.optional(),
  /** Position on a 6 × 6 grid; required for the `grid` layout and only allowed there. */
  cell: z.strictObject({ column: z.number().int().min(0).max(5), row: z.number().int().min(0).max(5) }).optional(),
});

export const DiagramEdge = z.strictObject({
  id: LocalId,
  from: LocalId,
  to: LocalId,
  label: plainText(1, FIELD_LIMITS.diagramLabelChars).optional(),
  directed: z.boolean(),
  style: z.enum(['solid', 'dashed']),
  /** Stroke emphasis in [0, 1]; an authored teaching value, not a measurement. */
  weight: Weight.optional(),
});

/**
 * One authored state of the diagram. Frames are switched, never animated by physics: a frame
 * emphasises or hides nodes and edges and may override edge weights.
 */
export const DiagramFrame = z.strictObject({
  id: LocalId,
  label: plainText(1, 40),
  /** Announced when the frame becomes current, and used by the text version. */
  description: plainText(10, FIELD_LIMITS.frameDescriptionChars),
  emphasis: z.array(LocalId).max(LIMITS.diagramNodes + LIMITS.diagramEdges),
  hidden: z.array(LocalId).max(LIMITS.diagramNodes + LIMITS.diagramEdges),
  weights: z.array(z.strictObject({ edge: LocalId, weight: Weight })).max(LIMITS.diagramEdges),
});

/**
 * How the reader moves between frames.
 * - `static`: no frames.
 * - `steps`: Previous/Next through the frames in order.
 * - `toggle`: one labelled button per frame; exactly one is current.
 * - `drag-to-target`: drag the token node onto a target node; that target selects a frame.
 *   Dropping elsewhere returns to the current frame. Keyboard and screen-reader users get the same
 *   choice as a list of targets.
 */
export const DiagramInteraction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('static') }),
  z.strictObject({ kind: z.literal('steps') }),
  z.strictObject({ kind: z.literal('toggle') }),
  z.strictObject({
    kind: z.literal('drag-to-target'),
    token: LocalId,
    targets: z
      .array(z.strictObject({ node: LocalId, frame: LocalId }))
      .min(2)
      .max(6),
    initialFrame: LocalId,
  }),
]);

export const DIAGRAM_LAYOUTS = ['flow-lr', 'flow-tb', 'radial', 'cycle', 'layers', 'grid'] as const;

export const DiagramData = z.strictObject({
  title: plainText(1, 100),
  instruction: plainText(1, 120).optional(),
  layout: z.enum(DIAGRAM_LAYOUTS),
  nodes: z.array(DiagramNode).min(2).max(LIMITS.diagramNodes),
  edges: z.array(DiagramEdge).max(LIMITS.diagramEdges),
  groups: z
    .array(z.strictObject({ id: LocalId, label: plainText(1, FIELD_LIMITS.diagramLabelChars) }))
    .max(FIELD_LIMITS.diagramGroups),
  frames: z.array(DiagramFrame).max(LIMITS.diagramFrames),
  interaction: DiagramInteraction,
});
