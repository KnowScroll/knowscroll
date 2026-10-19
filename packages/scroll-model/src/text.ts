import { z } from 'zod';
import { FIELD_LIMITS } from './limits.js';
import { spanText } from './primitives.js';

/** The closed set of inline marks. No links: sources stay hidden and nothing leaves the document. */
export const INLINE_MARKS = ['em', 'strong', 'code'] as const;
export const InlineMark = z.enum(INLINE_MARKS);
export type InlineMark = z.infer<typeof InlineMark>;

/** One run of text with the same marks. */
export const Span = z.strictObject({
  text: spanText(FIELD_LIMITS.paragraphChars),
  marks: z
    .array(InlineMark)
    .min(1)
    .max(INLINE_MARKS.length)
    .refine((marks) => new Set(marks).size === marks.length, { message: 'marks_duplicate' })
    .optional(),
});
export type Span = z.infer<typeof Span>;

/** Inline text: a list of spans whose concatenation is the block's plain text. */
export type RichText = readonly Span[];

/** The plain text of inline text: the concatenation of its spans (no separators). */
export function richTextPlain(spans: RichText): string {
  let text = '';
  for (const span of spans) text += span.text;
  return text;
}

/** Inline text of at most `maxChars` UTF-16 code units, trimmed as a whole. */
export function richText(maxChars: number) {
  return z
    .array(Span)
    .min(1)
    .max(FIELD_LIMITS.spansPerText)
    .refine((spans) => richTextPlain(spans).length <= maxChars, { message: 'text_too_long' })
    .refine(
      (spans) => {
        const text = richTextPlain(spans);
        return text.length > 0 && text === text.trim();
      },
      { message: 'text_not_plain' },
    );
}

/** Whitespace-separated words, as used by reading measures. */
export function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (const character of text) {
    const space = /\s/u.test(character);
    if (!space && !inWord) count += 1;
    inWord = !space;
  }
  return count;
}

/**
 * Sentence ranges `[start, end)` over UTF-16 code units. A sentence ends at a line break or at
 * `.`, `!` or `?` followed by whitespace or the end, so decimals (`1.46`) stay inside a sentence.
 * Leading whitespace is excluded from each range.
 */
export function sentenceRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let start = 0;
  const push = (end: number) => {
    let from = start;
    while (from < end && /\s/u.test(text.charAt(from))) from += 1;
    if (from < end) ranges.push([from, end] as const);
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '\n') {
      push(index);
      start = index + 1;
    } else if (character === '.' || character === '!' || character === '?') {
      const next = text.charAt(index + 1);
      if (next === '' || /\s/u.test(next)) {
        push(index + 1);
        start = index + 1;
      }
    }
  }
  push(text.length);
  return ranges;
}

export function containsDigit(text: string): boolean {
  return /\p{Nd}/u.test(text);
}

/** True when a UTF-16 offset falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Shortens text to at most `max` code units at a word boundary, ending with an ellipsis. Never
 * splits a surrogate pair. Text that fits is returned unchanged.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  if (splitsSurrogatePair(text, cut)) cut -= 1;
  const space = text.lastIndexOf(' ', cut);
  if (space > max / 2) cut = space;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** Word shingles used by the copy check (`copied_passage`): lower-case letters and digits only. */
export function wordShingles(text: string, size: number): Set<string> {
  const words = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const shingles = new Set<string>();
  for (let index = 0; index + size <= words.length; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '));
  }
  return shingles;
}
