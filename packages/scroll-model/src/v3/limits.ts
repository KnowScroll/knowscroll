/**
 * `scroll-limits.v3`: the bounds every stored `scroll-document.v3` satisfies (#759, decision J). A change to any value
 * is a new limits version; `scroll-limits.v2` is untouched and still governs v2 documents.
 */
export const SCROLL_LIMITS_V3_VERSION = 'scroll-limits.v3';

export const LIMITS_V3 = {
  /** Canonical JSON of the stored document, UTF-8 bytes (128 KiB). */
  documentBytes: 131_072,
  sections: { min: 2, max: 3 },
  beatsPerSection: { min: 2, max: 6 },
  /**
   * Beats in the whole document. The minimum also keeps a Scroll above coverage's three units
   * (`MIN_BODY_BLOCKS`), so a published document v3 can never be refused coverage for too few beats.
   */
  beats: { min: 9, max: 14 },
  /** The words of one beat's text. */
  beatWords: 70,
  /** The first beat is the cover's lede, so it must fit a cover. */
  firstBeatWords: 45,
  /** The words of the beats' text together: the essay itself, asides and the takeaway excluded. */
  mainWords: { min: 350, max: 700 },
  pictures: { min: 1, max: 3 },
  controls: 2,
  linksPerBeat: 3,
  asides: { min: 1, max: 4 },
  askSuggestions: 3,
  /** The takeaway is one to three plain sentences (decision F). */
  takeawaySentences: { min: 1, max: 3 },
} as const;

/**
 * Per-field character bounds. The word limits above are the product rule; these bound every string so a document stays
 * finite whatever the words are.
 */
export const FIELD_LIMITS_V3 = {
  sectionTitleChars: 60,
  beatChars: 600,
  simpleChars: 600,
  citeChars: 80,
  phraseChars: 80,
  controlLabelChars: 60,
  asideTitleChars: 60,
  asideChars: 600,
  takeawayChars: { min: 20, max: 300 },
  suggestionChars: 140,
  pictureTitleChars: 80,
  captionChars: 120,
  itemLabelChars: 40,
  itemNoteChars: 160,
  cellTextChars: 60,
  valueChars: 24,
  unitChars: 30,
  quoteChars: 280,
} as const;
