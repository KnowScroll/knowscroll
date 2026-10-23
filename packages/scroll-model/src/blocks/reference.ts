import { z } from '../zod.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import { codeText, FiniteNumber, MediaRef, plainText } from '../primitives.js';

export const CODE_LANGUAGES = [
  'python',
  'javascript',
  'typescript',
  'sql',
  'shell',
  'json',
  'rust',
  'go',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'r',
  'text',
] as const;

/** Source code shown as text: never executed, scrolls horizontally inside the block. */
export const CodeData = z.strictObject({
  language: z.enum(CODE_LANGUAGES),
  title: plainText(1, 60).optional(),
  code: codeText(LIMITS.codeChars),
  caption: plainText(1, FIELD_LIMITS.captionChars).optional(),
  /** 1-based line numbers to highlight. */
  highlightLines: z
    .array(z.number().int().min(1).max(FIELD_LIMITS.codeLines))
    .min(1)
    .max(FIELD_LIMITS.codeHighlights)
    .optional(),
});

/** A table cell: empty, text or a number (numbers are formatted by the renderer). */
export const TableCell = z.union([z.literal(''), plainText(1, FIELD_LIMITS.tableCellChars), FiniteNumber]);

export const TableData = z.strictObject({
  caption: plainText(1, 160),
  columns: z
    .array(
      z.strictObject({
        label: plainText(1, 40),
        align: z.enum(['start', 'end']),
        unit: plainText(1, 16).optional(),
      }),
    )
    .min(1)
    .max(LIMITS.tableColumns),
  rows: z.array(z.array(TableCell).min(1).max(LIMITS.tableColumns)).min(1).max(LIMITS.tableRows),
  /** The first cell of each row labels the row. */
  rowHeader: z.boolean(),
});

/** An admitted illustration: a still image or a silent loop (whose poster shows under reduced motion). */
export const FigureData = z.strictObject({
  media: MediaRef,
  motion: z.enum(['still', 'loop']),
  alt: plainText(10, FIELD_LIMITS.altChars),
  caption: plainText(1, FIELD_LIMITS.captionChars).optional(),
});

/**
 * An admitted short clip. Never autoplays with sound. Video needs a poster and a captions track;
 * both kinds need a transcript, which is also the text version.
 */
export const MediaData = z.strictObject({
  kind: z.enum(['video', 'audio']),
  media: MediaRef,
  poster: MediaRef.optional(),
  captions: MediaRef.optional(),
  alt: plainText(10, FIELD_LIMITS.altChars),
  transcript: plainText(1, FIELD_LIMITS.transcriptChars),
  durationMs: z.number().int().min(1_000).max(FIELD_LIMITS.mediaDurationMs),
});
