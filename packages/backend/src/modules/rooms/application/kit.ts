import type { z } from 'zod';
import {
  ROOM_EMBLEM_FRAMES,
  ROOM_EMBLEM_GLYPHS,
  ROOM_KIT_VERSION,
  ROOM_MOTIFS,
  ROOM_MOTIONS,
  ROOM_SWATCHES,
  RoomKitDraftSchema,
  RoomKitSchema,
  type RoomKit,
  type RoomKitDraft,
  type RoomSwatch,
} from '@knowscroll/contracts';

/**
 * A room's kit: the closed-vocabulary identity a room wears (D-170). The vocabulary and the shape are the wire
 * contract's; this file holds the rules that need arithmetic (contrast) and the default every room has without a model.
 * It is pure, but it lives in `application/` because the layering allows `domain/` no wire contract beyond IDs.
 */

/** Ink on ground must read as body text (WCAG AA); an accent must at least read as a large mark. */
export const INK_CONTRAST_MIN = 4.5;
export const ACCENT_CONTRAST_MIN = 3;

/** Why a draft is refused. The codes are fixed words, so a repair hint never carries anything a model wrote. */
export type KitProblem = 'ink_contrast' | 'accent_contrast' | 'same_swatch';

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(swatch: RoomSwatch): number {
  const rgb = Number.parseInt(ROOM_SWATCHES[swatch].slice(1), 16);
  return 0.2126 * channel(rgb >> 16) + 0.7152 * channel((rgb >> 8) & 255) + 0.0722 * channel(rgb & 255);
}

/** The WCAG contrast ratio of two swatches, from 1 to 21. */
export function contrastRatio(first: RoomSwatch, second: RoomSwatch): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** The first rule a draft breaks, or `undefined`. Judged on the swatches' fixed values, never on anything a model sent. */
export function kitProblem(draft: RoomKitDraft): KitProblem | undefined {
  const { ground, accent, ink } = draft.palette;
  if (ground === ink || ground === accent) return 'same_swatch';
  if (contrastRatio(ground, ink) < INK_CONTRAST_MIN) return 'ink_contrast';
  if (contrastRatio(ground, accent) < ACCENT_CONTRAST_MIN) return 'accent_contrast';
  return undefined;
}

/** The fixed words a repair may carry for each problem. */
export const KIT_HINTS = {
  ink_contrast: 'Pick an "ink" swatch that is much lighter or much darker than the "ground" swatch.',
  accent_contrast: 'Pick an "accent" swatch that stands out clearly from the "ground" swatch.',
  same_swatch: 'Use three different swatches for "ground", "accent" and "ink".',
} as const satisfies Record<KitProblem, string>;

/** What a model may answer: the closed vocabulary, and a palette that reads. A refusal carries one fixed hint. */
export function kitAnswerSchema(): z.ZodType<RoomKitDraft> {
  return RoomKitDraftSchema.superRefine((draft, context) => {
    const problem = kitProblem(draft);
    if (problem !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['palette'],
        message: 'Invalid palette',
        params: { safeCode: problem },
      });
  });
}

/** Palettes that pass the contrast rule, by construction and by test. A room's default takes one by its ID. */
const PALETTES: readonly (readonly [RoomSwatch, RoomSwatch, RoomSwatch])[] = [
  ['midnight', 'sun', 'cream'],
  ['soot', 'mint', 'cream'],
  ['navy', 'mint', 'cream'],
  ['paper', 'rust', 'soot'],
  ['mist', 'coral', 'soot'],
  ['forest', 'amber', 'cream'],
  ['plum', 'lilac', 'cream'],
  ['ember', 'amber', 'cream'],
  ['cream', 'cobalt', 'soot'],
  ['navy', 'amber', 'mist'],
  ['forest', 'mint', 'paper'],
];

/** FNV-1a over the ID's characters: stable across processes and versions, so a room keeps its default look. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function pick<T>(list: readonly T[], seed: number, step: number): T {
  return list[Math.floor(seed / step) % list.length] as T;
}

/**
 * The kit a room wears when no approved model kit exists, or when the stored one does not validate. Chosen from the
 * room's ID alone, so it is the same on every server and every read, needs no model and no review, and passes the
 * same rules as a proposed kit.
 */
export function defaultKit(roomId: string): RoomKit {
  const seed = hashOf(roomId);
  const [ground, accent, ink] = pick(PALETTES, seed, 1);
  const explainer = pick(ROOM_EMBLEM_GLYPHS, seed, 7);
  // The Skeptic's mark is never the Explainer's.
  const skepticIndex =
    (ROOM_EMBLEM_GLYPHS.indexOf(explainer) + 1 + (Math.floor(seed / 13) % 5)) % ROOM_EMBLEM_GLYPHS.length;
  return {
    version: ROOM_KIT_VERSION,
    palette: { ground, accent, ink },
    emblem: { frame: pick(ROOM_EMBLEM_FRAMES, seed, 3), glyph: pick(ROOM_EMBLEM_GLYPHS, seed, 5) },
    motif: pick(ROOM_MOTIFS, seed, 11),
    motion: pick(ROOM_MOTIONS, seed, 17),
    cast: { explainer, skeptic: ROOM_EMBLEM_GLYPHS[skepticIndex] ?? explainer },
  };
}

/**
 * The kit to show for a room: the stored approved one if it still validates against today's vocabulary and contrast
 * rule, else the room's default. A stored value never reaches a client unchecked.
 */
export function kitToShow(stored: unknown, roomId: string): RoomKit {
  const parsed = RoomKitSchema.safeParse(stored);
  return parsed.success && kitProblem(parsed.data) === undefined ? parsed.data : defaultKit(roomId);
}

/** Whether a stored kit still passes today's vocabulary and contrast rule: what an operator may approve. */
export function kitIsValid(stored: unknown): boolean {
  const parsed = RoomKitSchema.safeParse(stored);
  return parsed.success && kitProblem(parsed.data) === undefined;
}

/** Adds the version a stored kit carries to a validated draft. */
export function kitOfDraft(draft: RoomKitDraft): RoomKit {
  return { ...draft, version: ROOM_KIT_VERSION };
}
