/**
 * `@knowscroll/scroll-model`: the canonical declarative Scroll document, `scroll-document.v1`.
 * Pure TypeScript and Zod, no platform APIs: the API, the worker and the Expo app (web and native)
 * run this same code. Internal provenance and the producer contract are separate, backend-only
 * entries (`./internal`, `./producer`).
 */
export { FIELD_LIMITS, LIMITS, SCROLL_LIMITS_VERSION } from './limits.js';
export {
  BlockTypeName,
  BlockVersionNumber,
  LocalId,
  MediaRef,
  OpaqueId,
  ParamKey,
  Revision,
  Sha256Hex,
} from './primitives.js';
export { INLINE_MARKS, InlineMark, richTextPlain, Span, type RichText } from './text.js';
export { BlockA11y, FallbackText, Gesture, GESTURES } from './blocks/envelope.js';
export { CALLOUT_KINDS } from './blocks/text.js';
export { CODE_LANGUAGES } from './blocks/reference.js';
export { DIAGRAM_LAYOUTS } from './blocks/diagram.js';
export {
  FORMULA_KINDS,
  Formula,
  NumberFormat,
  Operand,
  SIMULATION_VIEWS,
  SimulationConstant,
  SimulationData,
  SimulationOutput,
  SimulationParam,
  SimulationReadout,
  SimulationView,
} from './blocks/simulation.js';
export {
  AUTHORED_BLOCK_TYPES,
  Block,
  BLOCK_TYPES,
  BLOCK_VERSIONS,
  CalloutBlock,
  ChartBlock,
  CodeBlock,
  ComparisonBlock,
  DiagramBlock,
  DisclosureBlock,
  FallbackBlock,
  FigureBlock,
  isBlockType,
  ListBlock,
  MediaBlock,
  NESTABLE_BLOCK_TYPES,
  NestedBlock,
  ParagraphBlock,
  QuoteBlock,
  SequenceBlock,
  SimulationBlock,
  SubheadingBlock,
  TableBlock,
  TimelineBlock,
  type AnyBlock,
  type AuthoredBlockType,
  type BlockOfType,
  type BlockType,
} from './blocks/catalog.js';
export {
  Correction,
  findBlock,
  Framing,
  INTEGRITY_METHOD,
  Measures,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  SCROLL_MEASURES_VERSION,
  ScrollDocument,
  Section,
  TEMPLATES,
  THEME_FAMILIES,
  walkBlocks,
  type BlockVisit,
} from './document.js';
export { isReasonCode, REASON_CODES, type Issue, type ReasonCode } from './issues.js';
export {
  deriveGesture,
  INTERACTION_KINDS,
  isInteractiveBlock,
  isTextBlockType,
  projectText,
  REDUCED_MOTION,
  TEXT_BLOCK_TYPES,
  visibleTexts,
} from './registry.js';
export {
  blockWeight,
  computeMeasures,
  coverageOf,
  WORDS_PER_MINUTE,
  type CoverageResult,
  type SectionCoverage,
} from './measures.js';
export {
  computeIntegrity,
  parseBlock,
  readEnvelope,
  validateDocument,
  type BlockEnvelopeView,
  type BlockOutcome,
  type DocumentOutcome,
  type ValidateOptions,
} from './validate.js';
export {
  BASELINE_BLOCKS,
  ClientCapabilities,
  FULL_V1_CAPABILITIES,
  negotiate,
  type NegotiationOutcome,
  type Substitution,
} from './negotiation.js';
export {
  BlockInteractionPayload,
  blockInteractionPayload,
  BlockState,
  BlockStateSnapshot,
  blockStateProblems,
  buildBlockStateSnapshot,
  defaultBlockState,
  describeBlockState,
  personalParamKeys,
  type SnapshotOutcome,
  type StateProblem,
} from './state.js';
export {
  ANCHOR_CHANGES,
  AnchorMap,
  createPassageLocator,
  deriveAnchorMap,
  quoteHash,
  repointLocator,
  ScrollBlockLocator,
  ScrollLocator,
  ScrollPassageLocator,
  validateLocator,
  type AnchorChange,
  type AnchorMapOutcome,
  type LocatorOutcome,
  type LocatorRejection,
  type RepointOutcome,
} from './locators.js';
export {
  curveSampleCount,
  evaluateFormula,
  evaluateSimulation,
  formatNumber,
  formatWithUnit,
  isOnGrid,
  readoutBand,
  renderTemplate,
  resolveParams,
  sampleCurve,
  snapToGrid,
  type SimulationValues,
} from './simulation/evaluate.js';
export { canonicalJson, canonicalSha256, utf8ByteLength } from './canonical.js';
export { sha256Hex } from './sha256.js';
