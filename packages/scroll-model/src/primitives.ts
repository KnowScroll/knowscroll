import { z } from 'zod';
import { FIELD_LIMITS } from './limits.js';

/**
 * Text and identifier primitives shared by every schema. Nothing here transforms input: schemas
 * accept or refuse, and the producer normalises before parsing (`producer/normalise.ts`).
 */

/**
 * C0/C1 controls, the Unicode line/paragraph separators (except the code units in `allowed`) and
 * lone surrogates. A lone surrogate is not text: it encodes as U+FFFD, so two different strings
 * would hash alike.
 */
function containsControl(text: string, allowed: ReadonlySet<number>): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    const control = unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029;
    if (control && !allowed.has(unit)) return true;
  }
  return false;
}
const NOTHING: ReadonlySet<number> = new Set();
/** Code may contain tabs and newlines, nothing else from the control ranges. */
const TAB_AND_NEWLINE: ReadonlySet<number> = new Set([0x09, 0x0a]);

/**
 * Readers never see sources (owner rule; carried forward from v1's checks). Any URL scheme,
 * `www.` or a host name on a common top-level domain is refused in reader-facing text.
 *
 * These checks are single scans with constant state per character, so they cost O(length) on any
 * input (a regular expression with nested quantifiers cost O(length²) on a long dotted string:
 * a 40,000-character title took 5.8 s). The text primitives below also run them only on text
 * within its length cap, so over-limit input is refused by the cap alone, without any scan.
 */
const HOST_SUFFIXES = ['com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'ai', 'uk', 'us', 'in'] as const;

/** Lower-case code of an ASCII letter, or the code itself. */
function lowered(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}
const isLetter = (code: number) => code >= 0x61 && code <= 0x7a;
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
/** `\w`: ASCII letters, digits and the underscore. */
const isWordCode = (code: number) => isLetter(lowered(code)) || isDigit(code) || code === 0x5f;

/** True when `needle` (lower-case ASCII) occurs at `at` in `text`, ignoring ASCII case. */
function startsWithFold(text: string, at: number, needle: string): boolean {
  if (at + needle.length > text.length) return false;
  for (let index = 0; index < needle.length; index += 1) {
    if (lowered(text.charCodeAt(at + index)) !== needle.charCodeAt(index)) return false;
  }
  return true;
}

/** True when a word starting with `needle` begins at a word boundary, e.g. `www.` or `mailto:`. */
function hasWordStart(text: string, needle: string): boolean {
  const first = needle.charCodeAt(0);
  for (let index = 0; index < text.length; index += 1) {
    if (lowered(text.charCodeAt(index)) !== first) continue;
    if (index > 0 && isWordCode(text.charCodeAt(index - 1))) continue;
    if (startsWithFold(text, index, needle)) return true;
  }
  return false;
}

/** True when `://` follows a run of scheme characters (`[a-z0-9+.-]`) that holds a letter. */
function hasSchemeSeparator(text: string): boolean {
  let letterInRun = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x3a && letterInRun && text.startsWith('//', index + 1)) return true;
    if (isLetter(lowered(code))) letterInRun = true;
    else if (!(isDigit(code) || code === 0x2b || code === 0x2d || code === 0x2e)) letterInRun = false;
  }
  return false;
}

/** True when a listed top-level domain starts at `at` and ends the word. */
function suffixAt(text: string, at: number): boolean {
  return HOST_SUFFIXES.some((suffix) => {
    if (!startsWithFold(text, at, suffix)) return false;
    const next = at + suffix.length;
    return next >= text.length || !isWordCode(text.charCodeAt(next));
  });
}

/**
 * True when the text holds `label(.label)*.suffix`: labels of `[a-z0-9-]` joined by single dots,
 * the first containing a letter or digit, then a listed suffix (`science.nasa.gov`, `example.org`).
 */
function hasHostName(text: string): boolean {
  let labelLength = 0;
  let segmentHasWord = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isLetter(lowered(code)) || isDigit(code)) {
      labelLength += 1;
      segmentHasWord = true;
    } else if (code === 0x2d) labelLength += 1;
    else if (code === 0x2e) {
      if (labelLength > 0 && segmentHasWord && suffixAt(text, index + 1)) return true;
      // A dot after an empty label ends the run of labels; otherwise the next label begins.
      if (labelLength === 0) segmentHasWord = false;
      labelLength = 0;
    } else {
      labelLength = 0;
      segmentHasWord = false;
    }
  }
  return false;
}

/** In code only schemes and `www.` count: `np.in` style member access must stay legal. */
function mentionsCodeWebAddress(text: string): boolean {
  return hasSchemeSeparator(text) || hasWordStart(text, 'www.');
}

/** True for control characters, line/paragraph separators and lone surrogates. */
export function hasControlCharacters(text: string): boolean {
  return containsControl(text, NOTHING);
}

export function mentionsWebAddress(text: string): boolean {
  return hasSchemeSeparator(text) || hasWordStart(text, 'mailto:') || hasWordStart(text, 'www.') || hasHostName(text);
}

function isNfc(text: string): boolean {
  return text.normalize('NFC') === text;
}

/**
 * Single-line display text: trimmed, NFC, no control characters or lone surrogates, no web address.
 * Every refinement passes text over `max` unexamined (the length check already refuses it), so
 * over-limit input costs no scan.
 */
export function plainText(min: number, max: number) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((text) => text.length > max || (text === text.trim() && isNfc(text) && !hasControlCharacters(text)), {
      message: 'text_not_plain',
    })
    .refine((text) => text.length > max || !mentionsWebAddress(text), { message: 'text_mentions_web_address' });
}

/**
 * One run of inline text. Not trimmed (spaces between spans are meaningful); otherwise the same
 * rules as plain text.
 */
export function spanText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.length > max || (isNfc(text) && !hasControlCharacters(text)), {
      message: 'text_not_plain',
    })
    .refine((text) => text.length > max || !mentionsWebAddress(text), { message: 'text_mentions_web_address' });
}

/** Displayed source code: never executed. Tabs and newlines allowed; no carriage returns or lone surrogates. */
export function codeText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.length > max || !containsControl(text, TAB_AND_NEWLINE), { message: 'code_not_plain' })
    .refine((text) => text.length > max || !mentionsCodeWebAddress(text), { message: 'text_mentions_web_address' });
}

/** Document-local identifier of a section, block, node, edge, frame, step, event or card. */
export const LocalId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, { message: 'id_format' });
export type LocalId = z.infer<typeof LocalId>;

/** Names an object's own properties could collide with; never allowed as keys. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** Key of a simulation parameter, constant or output (camelCase, referenced from formulas). */
export const ParamKey = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,23}$/, { message: 'key_format' })
  .refine((key) => !RESERVED_KEYS.has(key), { message: 'key_reserved' });
export type ParamKey = z.infer<typeof ParamKey>;

/** Opaque public identifier (asset, explanation unit, media, claim, source, run). */
export const OpaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/, { message: 'id_format' });

export const Revision = z.number().int().min(1).max(1_000_000);

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, { message: 'sha256_format' });

/** Calendar date (YYYY-MM-DD) that exists. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date_format' })
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    },
    { message: 'date_format' },
  );

/** A BCP 47 subset: language, optional script, optional region (`en`, `en-GB`, `zh-Hant-TW`). */
export const LanguageTag = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/, { message: 'language_format' });

/** A finite number within the document's magnitude bound. */
export const FiniteNumber = z
  .number()
  .refine((value) => Number.isFinite(value) && Math.abs(value) <= FIELD_LIMITS.numberMagnitude, {
    message: 'number_out_of_range',
  });

/** Admitted media (image, loop, video, audio, captions) by asset id and revision. */
export const MediaRef = z.strictObject({ mediaId: OpaqueId, revision: Revision });
export type MediaRef = z.infer<typeof MediaRef>;

/** Block type names, including ones this version does not know (capability lists, locators). */
export const BlockTypeName = z.string().regex(/^[a-z][a-z-]{1,31}$/, { message: 'block_type_format' });

export const BlockVersionNumber = z.number().int().min(1).max(99);
