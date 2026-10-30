/**
 * `scroll-limits.v2`: the bounds every stored `scroll-document.v2` satisfies. It replaces the v1
 * count of interactive blocks with a budget per Scroll: at most one stage, at most four calls (the
 * Final call included) and at most two other interactives. A change to any value is a new limits
 * version. `scroll-limits.v1` is untouched and still governs v1 documents.
 */
export const SCROLL_LIMITS_V2_VERSION = 'scroll-limits.v2';

export const LIMITS_V2 = {
  /** Canonical JSON of the stored document, UTF-8 bytes (128 KiB). */
  documentBytes: 131_072,
  /** Stops of all kinds: the dots of the spine. */
  minStops: 6,
  /**
   * Read stops a Scroll must have. They are what its facets bind to (coverage v2 needs three), so a
   * Scroll of calls and almost nothing else could be published and then never form a place.
   */
  minReadStops: 3,
  maxStops: 14,
  /** The words of one stop's text (heading excluded). */
  stopWords: 60,
  /** The words of a line that stands alone. */
  lineWords: 12,
  /** One stage per Scroll. */
  stages: 1,
  /** Calls, the Final call included. */
  calls: 4,
  /** Interactives other than a stage or a call (scene, sort, fork, scale, simulation, chart). None is built yet. */
  otherInteractives: 2,
  asides: 4,
  askSuggestions: 3,
  optionsPerCall: { min: 2, max: 3 },
  recapCaptions: { min: 2, max: 3 },
  /** A stage that changes fewer times than this is a picture, not a stage. */
  minStageStates: 3,
} as const;

/**
 * Per-field character bounds. The word limits above are the product rule; these bound every string
 * so a document stays finite whatever the words are.
 */
export const FIELD_LIMITS_V2 = {
  headingChars: 60,
  paragraphChars: 600,
  lineChars: 100,
  promptChars: 200,
  optionChars: 120,
  explainChars: 600,
  twistChars: 600,
  simpleChars: 600,
  asideTitleChars: 60,
  asideChars: 600,
  captionChars: 100,
  suggestionChars: 140,
  stateDescriptionChars: 600,
  claimChars: 160,
  sourceLabelChars: 120,
} as const;
