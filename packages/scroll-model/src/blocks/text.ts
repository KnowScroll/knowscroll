import { z } from '../zod.js';
import { FIELD_LIMITS } from '../limits.js';
import { plainText } from '../primitives.js';
import { richText } from '../text.js';

/** Prose. Passage offsets index the concatenation of its spans (`text-projection.v1`). */
export const ParagraphData = z.strictObject({
  spans: richText(FIELD_LIMITS.paragraphChars),
});

/** A heading inside a section (section headings live on the section). */
export const SubheadingData = z.strictObject({
  text: plainText(1, FIELD_LIMITS.headingChars),
});

export const ListData = z.strictObject({
  style: z.enum(['bullet', 'number']),
  items: z.array(richText(FIELD_LIMITS.listItemChars)).min(2).max(FIELD_LIMITS.listItems),
});

/** `pull` repeats the article's own words; `quotation` quotes someone and may name them. */
export const QuoteData = z.strictObject({
  kind: z.enum(['pull', 'quotation']),
  spans: richText(FIELD_LIMITS.quoteChars),
  attribution: plainText(1, 80).optional(),
});

export const CALLOUT_KINDS = ['note', 'example', 'limit', 'key-idea', 'try-it'] as const;

/** An aside. `limit` states what the explanation cannot do; `try-it` invites using the block above. */
export const CalloutData = z.strictObject({
  kind: z.enum(CALLOUT_KINDS),
  title: plainText(1, FIELD_LIMITS.calloutTitleChars).optional(),
  spans: richText(FIELD_LIMITS.calloutChars),
});
