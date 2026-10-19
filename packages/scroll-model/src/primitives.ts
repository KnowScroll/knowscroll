import { z } from 'zod';
import { FIELD_LIMITS } from './limits.js';

/**
 * Text and identifier primitives shared by every schema. Nothing here transforms input: schemas
 * accept or refuse, and the producer normalises before parsing (`producer/normalise.ts`).
 */

/** C0/C1 controls and the Unicode line/paragraph separators, except the code units in `allowed`. */
function containsControl(text: string, allowed: ReadonlySet<number>): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
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
 */
const WEB_ADDRESS =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:\bmailto:)|(?:\bwww\.)|(?:\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|mil|int|io|ai|uk|us|in)\b)/iu;
/** In code only schemes and `www.` count: `np.in` style member access must stay legal. */
const CODE_WEB_ADDRESS = /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:\bwww\.)/iu;

export function hasControlCharacters(text: string): boolean {
  return containsControl(text, NOTHING);
}

export function mentionsWebAddress(text: string): boolean {
  return WEB_ADDRESS.test(text);
}

function isNfc(text: string): boolean {
  return text.normalize('NFC') === text;
}

/** Single-line display text: trimmed, NFC, no control characters, no web address. */
export function plainText(min: number, max: number) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((text) => text === text.trim() && isNfc(text) && !hasControlCharacters(text), {
      message: 'text_not_plain',
    })
    .refine((text) => !mentionsWebAddress(text), { message: 'text_mentions_web_address' });
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
    .refine((text) => isNfc(text) && !hasControlCharacters(text), { message: 'text_not_plain' })
    .refine((text) => !mentionsWebAddress(text), { message: 'text_mentions_web_address' });
}

/** Displayed source code: never executed. Tabs and newlines allowed; no carriage returns. */
export function codeText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !containsControl(text, TAB_AND_NEWLINE), { message: 'code_not_plain' })
    .refine((text) => !CODE_WEB_ADDRESS.test(text), { message: 'text_mentions_web_address' });
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
