import { z } from 'zod';

/**
 * A room's face (v3 R-4, D-170): the identity every room has. It is a closed vocabulary of words, never markup: a
 * model may propose a kit, code validates it against these lists (and for contrast), an operator reviews it, and the
 * app draws it. Nothing in a kit is free text, a colour code a model chose, an address or a piece of drawing.
 */

/** Written on every stored kit; a kit of another version is not drawn. */
export const ROOM_KIT_VERSION = 'station-kit.v1';

/**
 * The inks a kit may use, by name. The colours are fixed here so a model picks a word, not a code, and contrast is
 * judged on values that code owns. Any swatch may fill any slot; the contrast rule decides which pairs may.
 */
export const ROOM_SWATCHES = {
  midnight: '#040A17',
  soot: '#111111',
  forest: '#0F2A22',
  plum: '#24122E',
  ember: '#2B1410',
  navy: '#0B1F4B',
  cream: '#FFFBF0',
  paper: '#F4EDD8',
  mist: '#E6EEF8',
  sun: '#FFE44D',
  amber: '#FFB020',
  mint: '#14C79B',
  coral: '#D9442B',
  rust: '#B23A0B',
  cobalt: '#2C46E8',
  lilac: '#A58BFF',
  sea: '#1B8FA6',
} as const;
export type RoomSwatch = keyof typeof ROOM_SWATCHES;
/** The swatch names in a fixed order, for the model's instructions and for the enum. */
export const ROOM_SWATCH_NAMES = [
  'midnight',
  'soot',
  'forest',
  'plum',
  'ember',
  'navy',
  'cream',
  'paper',
  'mist',
  'sun',
  'amber',
  'mint',
  'coral',
  'rust',
  'cobalt',
  'lilac',
  'sea',
] as const satisfies readonly RoomSwatch[];

/** The shape an emblem sits in; R3 chooses it by the topic's family (science circle, sport shield, tech hexagon, history arch, food rounded square). */
export const ROOM_EMBLEM_FRAMES = ['circle', 'shield', 'hexagon', 'arch', 'rounded-square', 'diamond'] as const;
/** What an emblem shows inside its frame; the same marks stand for a resident (a cast skin), so none draws a person. */
export const ROOM_EMBLEM_GLYPHS = [
  'ringed-planet',
  'star',
  'atom',
  'leaf',
  'wave',
  'flame',
  'layers',
  'hourglass',
  'pot',
  'centre-circle',
  'book',
  'gear',
  'mountain',
  'spiral',
] as const;
/** The faint pattern behind a room's band. */
export const ROOM_MOTIFS = [
  'star-field',
  'constellation',
  'chalk-lines',
  'circuit',
  'waves',
  'grid',
  'rings',
  'rays',
] as const;
/** The one slow loop in a room's band (R3: picked from six). Reduced motion shows a still frame instead. */
export const ROOM_MOTIONS = ['twinkle', 'draw', 'blink', 'pan', 'rise', 'ripple'] as const;

export type RoomEmblemFrame = (typeof ROOM_EMBLEM_FRAMES)[number];
export type RoomEmblemGlyph = (typeof ROOM_EMBLEM_GLYPHS)[number];
export type RoomMotif = (typeof ROOM_MOTIFS)[number];
export type RoomMotion = (typeof ROOM_MOTIONS)[number];

const Swatch = z.enum(ROOM_SWATCH_NAMES);

/** What a model proposes: everything but the version, which code adds. */
export const RoomKitDraftSchema = z.strictObject({
  palette: z.strictObject({ ground: Swatch, accent: Swatch, ink: Swatch }),
  emblem: z.strictObject({ frame: z.enum(ROOM_EMBLEM_FRAMES), glyph: z.enum(ROOM_EMBLEM_GLYPHS) }),
  motif: z.enum(ROOM_MOTIFS),
  motion: z.enum(ROOM_MOTIONS),
  /** The mark each resident wears in this room: a skin, never a face. Their names stay the catalogue's (D-163). */
  cast: z.strictObject({ explainer: z.enum(ROOM_EMBLEM_GLYPHS), skeptic: z.enum(ROOM_EMBLEM_GLYPHS) }),
});
export type RoomKitDraft = z.infer<typeof RoomKitDraftSchema>;

export const RoomKitSchema = RoomKitDraftSchema.extend({ version: z.literal(ROOM_KIT_VERSION) });
export type RoomKit = z.infer<typeof RoomKitSchema>;

/** Where an approved painted backdrop is served. It is read with the session, like other media. */
export const ROOM_BACKDROP_PATH = /^\/media\/room\/[0-9a-f]{64}$/;

/**
 * A room's face as lists, previews and the room itself carry it. The kit is always there: a room whose kit nobody
 * approved wears the one its ID gives it. `backdrop` is present only when an operator approved a painted image.
 */
export const RoomIdentitySchema = z.strictObject({
  kit: RoomKitSchema,
  backdrop: z.strictObject({ path: z.string().regex(ROOM_BACKDROP_PATH) }).optional(),
});
export type RoomIdentity = z.infer<typeof RoomIdentitySchema>;
