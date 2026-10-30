/**
 * `scroll-document.v2` (public entry, shared by server, worker and, later, clients): the document,
 * its limits and measures, the kit (the words a writer may choose, and the physics code derives from them) and the admission validator. Added beside v1, which keeps
 * its own schema, limits and measures untouched (D-120).
 */
export {
  applyStagePatch,
  AXIAL_TILT_DEGREES,
  describeStageState,
  EARTH_SKY_KIT,
  INITIAL_STAGE_STATE,
  settleStageState,
  STAGE_ENUMS,
  STAGE_KEYS,
  stageParts,
  stagePhysics,
  StageStateSchema,
  type HemispherePhysics,
  type PinMark,
  type StageKey,
  type StagePart,
  type StagePatch,
  type StagePhysics,
  type StageState,
  type SunHeight,
} from './kit.js';
export { FIELD_LIMITS_V2, LIMITS_V2, SCROLL_LIMITS_V2_VERSION } from './limits.js';
export {
  Aside,
  ASIDE_KINDS,
  callsOf,
  CallItStop,
  FinalCallStop,
  MeasuresV2,
  Misconception,
  ReadStop,
  Recap,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_MEASURES_V2_VERSION,
  ScrollDocumentV2,
  SourceLabel,
  Stage,
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
  readingWords,
  SECONDS_PER_CALL,
  stopWeight,
  stopWords,
  WORDS_PER_MINUTE_V2,
} from './measures.js';
export { computeIntegrityV2, validateDocumentV2, type DocumentV2Outcome } from './validate.js';
