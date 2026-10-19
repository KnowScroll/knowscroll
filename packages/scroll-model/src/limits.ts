/**
 * `scroll-limits.v1`: the bounds every stored Scroll document satisfies. These are bench values
 * chosen for phone reading and one cacheable fetch, not measured optima; changing any value is a
 * new limits version (and a new `limitsVersion` literal in the document).
 */
export const SCROLL_LIMITS_VERSION = 'scroll-limits.v1';

/** The document-level limits ruled for scroll-document.v1 (D-012). */
export const LIMITS = {
  /** Canonical JSON of the stored document, UTF-8 bytes (128 KiB). */
  documentBytes: 131_072,
  sections: 12,
  /** Every block, nested disclosure children included. */
  blocks: 80,
  /** Blocks that hold reader state or play media (see `isInteractiveBlock`). */
  interactiveBlocks: 8,
  /** Reader-visible characters (UTF-16 code units) in the main rendition. */
  visibleChars: 24_000,
  paramsPerBlock: 4,
  paramsTotal: 16,
  /** Data points per chart: bar categories × series, line/scatter points, heatmap cells. */
  chartPoints: 200,
  diagramNodes: 16,
  diagramEdges: 24,
  diagramFrames: 8,
  tableColumns: 5,
  tableRows: 12,
  codeChars: 4_000,
  /** UTF-16 code units in a `scroll_passage` locator's range. */
  passageChars: 600,
  /** Canonical JSON of a block-state snapshot, UTF-8 bytes (1 KiB). */
  blockStateBytes: 1_024,
} as const;

/**
 * Per-field bounds that keep every string and list in the document finite. They are part of
 * scroll-limits.v1 (so a change is a new limits version) but were not separately ruled.
 */
export const FIELD_LIMITS = {
  kickerChars: 40,
  titleChars: 90,
  dekChars: 200,
  headingChars: 80,
  a11yLabelChars: 120,
  a11yDescriptionChars: 600,
  fallbackTextChars: 1_200,
  /** Authored (non-text) blocks need a fallback that stands on its own. */
  fallbackTextMinChars: 40,
  spansPerText: 40,
  paragraphChars: 1_200,
  listItems: 8,
  listItemChars: 400,
  quoteChars: 400,
  calloutTitleChars: 60,
  calloutChars: 600,
  disclosureSummaryChars: 100,
  disclosureBlocks: 6,
  codeLines: 120,
  codeLineChars: 160,
  codeHighlights: 12,
  captionChars: 300,
  tableCellChars: 120,
  altChars: 300,
  transcriptChars: 1_200,
  mediaDurationMs: 60_000,
  comparisonColumns: 3,
  comparisonPoints: 5,
  comparisonPointChars: 240,
  timelineEvents: 12,
  sequenceSteps: 8,
  stepChars: 500,
  diagramGroups: 4,
  diagramLabelChars: 32,
  frameDescriptionChars: 400,
  chartSeries: 4,
  barCategories: 24,
  heatmapSide: 12,
  constants: 12,
  outputs: 6,
  lookupEntries: 12,
  cards: 8,
  readoutBands: 6,
  templateChars: 160,
  /** (max − min) / step of a simulation parameter. */
  sliderPositions: 1_000,
  /** Absolute magnitude of any number in a document and of any evaluated output. */
  numberMagnitude: 1e15,
  corrections: 10,
  /** Parameter combinations the validator evaluates to prove outputs stay finite. */
  validationCombinations: 256,
} as const;
