/**
 * How much a Scroll asks of the reader beyond reading it (D-192). `plain`: reading only (every v1 Scroll,
 * every Reel and a v2 Scroll with no stage and no call). `stage`: a pinned picture, or a single call. `game`:
 * several calls ending in a Final call. The level is a fact of the stored document and is the same for every
 * reader; it says nothing about what anyone did with it.
 */
export const PLAY_LEVELS = ['plain', 'stage', 'game'] as const;
export type PlayLevel = (typeof PLAY_LEVELS)[number];

/**
 * Public facts of a revision that ranking and the Jev prompt read. Content derives them from the stored
 * document; nothing here is personal, and nothing here is a play result.
 */
export interface EncounterTraits {
  readonly playLevel: PlayLevel;
  /** Estimated reading time in minutes, as the document's own measures state it. */
  readonly readingMinutes?: number;
  /** The public text of the common wrong idea the Scroll is built to meet; absent when it has none. */
  readonly misconceptionClaim?: string;
  /** Parts in the Scroll's series, when it is in one. Counted by the series read, never declared. */
  readonly seriesTotal?: number;
}

const V2_SCHEMA = 'scroll-document.v2';

/** The least a Scroll with calls needs to be a game: two calls, one of them the Final call. */
const GAME_MIN_CALLS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The play level of a v2 document's stops and stage; the caller has checked it is a v2 document. */
function playLevelOfV2(document: Record<string, unknown>): PlayLevel {
  const stops = Array.isArray(document['stops']) ? document['stops'] : [];
  const kinds = stops.map((stop) => (isRecord(stop) ? stop['kind'] : undefined));
  const calls = kinds.filter((kind) => kind === 'call_it' || kind === 'final_call').length;
  if (calls >= GAME_MIN_CALLS && kinds.includes('final_call')) return 'game';
  return document['stage'] !== undefined || calls > 0 ? 'stage' : 'plain';
}

/**
 * The traits of a stored document of any format, read structurally. Admission already proved the document
 * valid, so this does not validate again; anything it does not recognise reads as plain with no extras,
 * which is what every Scroll was before traits existed.
 */
export function traitsOfDocument(document: unknown): EncounterTraits {
  if (!isRecord(document)) return { playLevel: 'plain' };
  const measures = document['measures'];
  const readingMinutes = isRecord(measures) ? positiveNumber(measures['readingMinutes']) : undefined;
  if (document['schemaVersion'] !== V2_SCHEMA)
    return { playLevel: 'plain', ...(readingMinutes !== undefined ? { readingMinutes } : {}) };
  const misconception = document['misconception'];
  const claim =
    isRecord(misconception) && misconception['kind'] === 'myth' && typeof misconception['claim'] === 'string'
      ? misconception['claim']
      : undefined;
  return {
    playLevel: playLevelOfV2(document),
    ...(readingMinutes !== undefined ? { readingMinutes } : {}),
    ...(claim !== undefined ? { misconceptionClaim: claim } : {}),
  };
}
