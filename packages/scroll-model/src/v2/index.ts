/**
 * `scroll-document.v2` (public entry, shared by server, worker and, later, clients): the document,
 * its limits and measures and the admission validator. Added beside v1, which keeps
 * its own schema, limits and measures untouched (D-120).
 */
export {
  CHART_SHAPES,
  GrowingChart,
  describeChart,
  describeFork,
  describePoint,
  describeScale,
  formatFigure,
  ForkBlock,
  Guide,
  GUIDE_CHARACTERS,
  GUIDE_POSES,
  Interactive,
  INTERACTIVE_KINDS,
  interactiveWords,
  isSortRight,
  SCALE_AXES,
  ScaleBlock,
  SeriesPoint,
  SortBlock,
  sortedItems,
  sortPlacedRight,
  type GuideCharacter,
  type InteractiveKind,
} from './blocks.js';
export { FIELD_LIMITS_V2, LIMITS_V2, SCROLL_LIMITS_V2_VERSION } from './limits.js';
export {
  Aside,
  ASIDE_KINDS,
  callsOf,
  CallItStop,
  FinalCallBinding,
  FinalCallStop,
  Landmark,
  MeasuresV2,
  Misconception,
  ReadStop,
  Recap,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_MEASURES_V2_VERSION,
  ScrollDocumentV2,
  SourceLabel,
  Stage,
  StageFrame,
  Stop,
  STOP_EMPHASES,
  StopBlock,
  StopHeading,
  StopLine,
  StopParagraph,
} from './document.js';
export { V2_REASON_CODES, uniqueIssuesV2, type IssueV2, type V2ReasonCode } from './issues.js';
export {
  computeMeasuresV2,
  READING_SECONDS_V2,
  SECONDS_PER_INTERACTIVE,
  readingWords,
  SECONDS_PER_CALL,
  stopWeight,
  stopWords,
  WORDS_PER_MINUTE_V2,
} from './measures.js';
export { anchorIsMoment, momentAnchorOf, momentOf, whyNoMoment, type Moment, type NoMoment } from './moment.js';
export { computeIntegrityV2, validateDocumentV2, type DocumentV2Outcome, type ValidateV2Options } from './validate.js';
export { negotiateV2, parseDocumentV2, type NegotiationV2Outcome } from './delivery.js';
export { CALL_READ_INTERACTIONS, INTERACTION_KINDS_V2 } from './interactions.js';
export {
  afterLock,
  COMBO_FOR_FINAL_BONUS,
  finalBonusReady,
  landmarkTier,
  NO_TALLY,
  sparksEarned,
  talliesAfterEach,
  tallyOf,
  type CallTally,
  type LandmarkTier,
  type LockedCall,
} from './play.js';
