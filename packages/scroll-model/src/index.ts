/**
 * `@knowscroll/scroll-model`: the canonical declarative Scroll document, `scroll-document.v1`.
 * Pure TypeScript and Zod, no platform APIs: the API, the worker and the Expo app (web and native)
 * run this same code. Internal provenance and the producer contract are separate, backend-only
 * entries (`./internal`, `./producer`).
 *
 * Validation has two entry points (coordinator ruling on M1). ADMISSION, for the server, worker
 * and producer: `admitDocument`, `admitBlock`, `validateDocument` (either purpose always verifies
 * the measures and the hash; `'stored'` also proves every simulation over its whole grid), and the
 * producer's `validateDraft` and `compileDraft`. CLIENT, for the device: `parseDocument` (may skip
 * the measures and hash), `parseBlock` and `negotiate`; they never walk a grid. Admission computes
 * each simulation's display scale once, in the grid proof, and stores it (`SimulationData.display`);
 * a client reads it with `displayScale` / `displayRange` and guards a single evaluated point with
 * `outputsUsable`. No grid-walking function is exported from this entry except through the
 * admission functions above; a client must not call an admission function. Server code imports
 * them from `@knowscroll/scroll-model/admission` (which dependency-cruiser keeps out of client
 * code); they are still exported here for code written before that entry existed, and ESLint
 * refuses their import by name in the client packages.
 */
export { FIELD_LIMITS, LIMITS, SCROLL_LIMITS_VERSION } from './limits.js';
export {
  BlockTypeName,
  BlockVersionNumber,
  LocalId,
  MediaRef,
  OpaqueId,
  ParamKey,
  plainText,
  Revision,
  Sha256Hex,
} from './primitives.js';
export {
  INLINE_MARKS,
  InlineMark,
  isGraphemeBoundary,
  numericTokens,
  richTextPlain,
  Span,
  type RichText,
} from './text.js';
export { BlockA11y, FallbackText, Gesture, GESTURES } from './blocks/envelope.js';
export { CALLOUT_KINDS } from './blocks/text.js';
export { CODE_LANGUAGES } from './blocks/reference.js';
export { DIAGRAM_LAYOUTS } from './blocks/diagram.js';
export {
  FORMULA_KINDS,
  Formula,
  ILLUSTRATIVE_NOTICE,
  isIllustrative,
  NumberFormat,
  Operand,
  SIMULATION_VIEWS,
  SimulationConstant,
  SimulationData,
  SimulationDisplay,
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
  Rendition,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  SCROLL_MEASURES_VERSION,
  ScrollDocument,
  Section,
  SeriesRef,
  TEMPLATES,
  THEME_FAMILIES,
  walkBlocks,
  type BlockVisit,
} from './document.js';
export { isReasonCode, REASON_CODES, type Issue, type ReasonCode } from './issues.js';
export {
  BASELINE_TYPES,
  deriveGesture,
  fallbackTextOf,
  INTERACTION_KINDS,
  isInteractiveBlock,
  isTextBlockType,
  projectText,
  REDUCED_MOTION,
  TEXT_BLOCK_TYPES,
  textFields,
  visibleTexts,
  type TextField,
} from './registry.js';
export { fallbackBlockFor } from './fallback.js';
export {
  blockWeight,
  computeMeasures,
  coverageOf,
  WORDS_PER_MINUTE,
  type CoverageResult,
  type SectionCoverage,
} from './measures.js';
export {
  admitBlock,
  admitDocument,
  computeIntegrity,
  parseBlock,
  parseDocument,
  readEnvelope,
  validateDocument,
  worstGrowthBytes,
  worstVisibleChars,
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
  parseCapabilities,
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
  curveSamples,
  curveUsable,
  evaluateSimulation,
  formatNumber,
  formatWithUnit,
  gridSize,
  gridValues,
  isOnGrid,
  outputsUsable,
  readoutBand,
  renderTemplate,
  resolveParams,
  sampleCurve,
  simulationGridPoints,
  snapToGrid,
  type SimulationValues,
} from './simulation/evaluate.js';
export { displayFraction, displayRange, displayScale } from './simulation/display.js';
export { simulationNumbers, type SimulationNumber } from './simulation/numbers.js';
export { canonicalJson, canonicalSha256, utf8ByteLength } from './canonical.js';
export { sha256Hex } from './sha256.js';

/** `scroll-document.v2`, beside v1 (D-120). */
export * from './v2/index.js';
