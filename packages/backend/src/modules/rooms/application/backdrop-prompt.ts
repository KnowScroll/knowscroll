import type { RoomEmblemGlyph, RoomKit, RoomMotif, RoomSwatch } from '@knowscroll/contracts';

/**
 * The prompt of a painted backdrop, built by code from the room's library topic and its kit (D-166). Nothing a member
 * typed is in it: the topic is a library label and the rest are words chosen from the kit's closed vocabulary.
 */

const HOUSE_STYLE =
  "Screenprint, two to three flat inks, bold ink outlines, flat shapes, wide band composition. No text, no letters, no numbers, no faces, no people, no logos. No signature, no artist's mark, no monogram, no stamp, nothing written in the corners.";

const SCENES: Record<RoomEmblemGlyph, string> = {
  'ringed-planet': 'a ringed planet',
  star: 'a bright star',
  atom: 'an atom with orbiting electrons',
  leaf: 'a leaf',
  wave: 'rolling waves',
  flame: 'a flame',
  layers: 'stacked layers',
  hourglass: 'an hourglass',
  pot: 'a cooking pot with steam',
  'centre-circle': 'a pitch with a centre circle',
  book: 'an open book',
  gear: 'interlocking gears',
  mountain: 'a mountain range',
  spiral: 'a spiral',
  globe: 'the Earth seen from space',
  cell: 'a living cell',
};

const PATTERNS: Record<RoomMotif, string> = {
  'star-field': 'a field of small stars',
  constellation: 'faint constellation lines between stars',
  'chalk-lines': 'chalk lines on a board',
  circuit: 'thin circuit traces',
  waves: 'gentle wave lines',
  grid: 'a fine grid',
  rings: 'concentric rings',
  rays: 'rays fanning out',
};

const COLOURS: Record<RoomSwatch, string> = {
  midnight: 'deep midnight blue',
  soot: 'near black',
  forest: 'deep forest green',
  plum: 'dark plum',
  ember: 'dark ember brown',
  navy: 'navy blue',
  cream: 'warm cream',
  paper: 'old paper beige',
  mist: 'pale mist blue',
  sun: 'sun yellow',
  amber: 'amber orange',
  mint: 'mint green',
  coral: 'coral red',
  rust: 'rust brown',
  cobalt: 'cobalt blue',
  lilac: 'lilac',
  sea: 'sea teal',
};

/** A library label reduced to plain words: letters, digits, spaces, ampersand, apostrophe and hyphen, at most 60. */
function plainWords(label: string): string {
  return label
    .replace(/[^\p{L}\p{N} &'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

/** The prompt for one room's backdrop. The same room and kit always give the same prompt. */
export function backdropPrompt(input: { readonly topicLabel: string; readonly kit: RoomKit }): string {
  const { kit } = input;
  const theme = plainWords(input.topicLabel);
  return [
    HOUSE_STYLE,
    `Subject: ${SCENES[kit.emblem.glyph]}${theme === '' ? '' : `, for the theme ${theme}`}.`,
    `Behind it: ${PATTERNS[kit.motif]}.`,
    `Inks: ${COLOURS[kit.palette.ground]} ground, ${COLOURS[kit.palette.accent]} accent, ${COLOURS[kit.palette.ink]} lines.`,
  ].join(' ');
}
