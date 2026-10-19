import { z } from 'zod';
import { FIELD_LIMITS } from '../limits.js';
import { LocalId, plainText } from '../primitives.js';

/**
 * Which gestures a block captures (blueprint §18 gesture arbitration). Set by code from the
 * block's data (`deriveGesture`), never by the model; the validator refuses a mismatch.
 * - `none`: taps only; vertical reading always passes through.
 * - `horizontal`: the block owns a horizontal drag once the axis locks (slider, code scroll).
 * - `two-axis`: the block owns a drag in both axes until release (drag-to-target diagram).
 */
export const GESTURES = ['none', 'horizontal', 'two-axis'] as const;
export const Gesture = z.enum(GESTURES);
export type Gesture = z.infer<typeof Gesture>;

/** Accessible name and optional description of a block. */
export const BlockA11y = z.strictObject({
  label: plainText(1, FIELD_LIMITS.a11yLabelChars),
  description: plainText(1, FIELD_LIMITS.a11yDescriptionChars).optional(),
});
export type BlockA11y = z.infer<typeof BlockA11y>;

/** Readable stand-in for the block: shown when it cannot render and read by "text version". */
export const FallbackText = plainText(1, FIELD_LIMITS.fallbackTextChars);

/**
 * The envelope every stored non-text block carries: stable id, type and version, accessibility
 * text, fallback text, whether the block is essential to the argument, its gesture declaration,
 * and its typed data.
 */
export function defineBlock<const T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({
    id: LocalId,
    type: z.literal(type),
    version: z.literal(1),
    a11y: BlockA11y,
    fallbackText: FallbackText,
    essential: z.boolean(),
    gesture: Gesture,
    data,
  });
}

/**
 * The envelope of a text block (paragraph, subheading, list, quote, callout). Its fallback text is
 * derived from its own text when it is needed (`fallbackTextOf`, at negotiation and render time),
 * never stored, so the document does not carry its prose twice. Its accessibility label is set by
 * code at compile time.
 */
export function defineTextBlock<const T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({
    id: LocalId,
    type: z.literal(type),
    version: z.literal(1),
    a11y: BlockA11y,
    essential: z.boolean(),
    gesture: Gesture,
    data,
  });
}
