import { z } from 'zod';
import { FIELD_LIMITS } from '../limits.js';
import { LocalId, MediaRef, plainText } from '../primitives.js';
import { richText } from '../text.js';

/** Two or three ways of seeing something, side by side. */
export const ComparisonData = z.strictObject({
  title: plainText(1, 100),
  columns: z
    .array(
      z.strictObject({
        label: plainText(1, 60),
        points: z.array(richText(FIELD_LIMITS.comparisonPointChars)).min(1).max(FIELD_LIMITS.comparisonPoints),
      }),
    )
    .min(2)
    .max(FIELD_LIMITS.comparisonColumns),
  caption: plainText(1, FIELD_LIMITS.captionChars).optional(),
});

/** Ordered events; the array order is the time order. */
export const TimelineData = z.strictObject({
  title: plainText(1, 100),
  events: z
    .array(
      z.strictObject({
        id: LocalId,
        when: plainText(1, 32),
        title: plainText(1, 80),
        detail: richText(400).optional(),
      }),
    )
    .min(2)
    .max(FIELD_LIMITS.timelineEvents),
});

/** A stepper: one step at a time with Previous/Next; the text version lists every step. */
export const SequenceData = z.strictObject({
  title: plainText(1, 100),
  steps: z
    .array(
      z.strictObject({
        id: LocalId,
        title: plainText(1, 80),
        spans: richText(FIELD_LIMITS.stepChars),
        figure: z.strictObject({ media: MediaRef, alt: plainText(10, FIELD_LIMITS.altChars) }).optional(),
      }),
    )
    .min(2)
    .max(FIELD_LIMITS.sequenceSteps),
});
