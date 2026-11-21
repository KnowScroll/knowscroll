/**
 * `@knowscroll/scroll-model/producer`: the backend-only producer contract — the authored shape the
 * writer model returns (`scroll-authoring.v1`) and its compilation, the canonical draft and its
 * compile input, staged draft validation and compilation into the consumer document plus its
 * internal provenance. Client packages must never import this entry (dependency-cruiser
 * `clients-never-import-scroll-internals`).
 */
export { compileAuthored } from './authoring.js';
export { type AuthoringEvidence } from './authoring-bind.js';
export { authoringReference } from './authoring-reference.js';
export { AuthoredScroll, SCROLL_AUTHORING_VERSION, type AuthoredBlockType } from './authoring-schema.js';
export { copiedRuns, copiedWordMask, copyMaterial, copyWords } from '../text.js';
export { DocumentTitle } from '../document.js';
export {
  COPY_RUN_WORDS,
  compileDraft,
  DRAFT_MAX_BYTES,
  SCROLL_CHECKS_VERSION,
  validateDraft,
  type CompileOutcome,
  type DraftOutcome,
} from './compile.js';
export {
  DraftBinding,
  DraftBlock,
  DraftProvenance,
  DraftSection,
  SCROLL_DRAFT_VERSION,
  ScrollDraft,
  scrollDraftJsonSchema,
} from './draft.js';
export { draftFromDocument } from './draft-from-document.js';
export { normaliseDraftInput } from './normalise.js';
export { DRAFT_STAGES, REPAIR_HINTS, repairItems, stageOf, type DraftStage } from './reasons.js';

/**
 * `scroll-authoring.v2` (D-120): the flat shape the v2 writer returns, its assembler into a
 * `scroll-document.v2`, the authoring rules and the writer-facing reference.
 */
export {
  AuthoredItemV2,
  AuthoredScrollV2,
  SCROLL_AUTHORING_V2_VERSION,
  type AuthoredStageFigure,
} from './v2/authoring-schema.js';
export {
  assembleScrollV2,
  recipeKit,
  shuffleOptions,
  type Assembly,
  type AssemblyMap,
  type PublicationV2,
  type RecipeDataV2,
  type StagePlanV2,
} from './v2/assemble.js';
export { stageFigureIsStated, type LeftOutFigure } from './v2/stage-figures.js';
export { compileAuthoredV2, type CompileV2Input, type CompileV2Outcome } from './v2/compile.js';
export { authoringReferenceV2 } from './v2/reference.js';
export { REPAIR_HINTS_V2 } from './v2/reasons.js';
export { unstatedFigures } from './v2/figures.js';
export { authoringIssuesV2, type AuthoringRulesInput } from './v2/rules.js';

/** `scroll-authoring.v3`: a hand-written `scroll-document.v3` and its compile into the stored document (#759). */
export {
  AuthoredBeatV3,
  AuthoredScrollV3,
  compileEditorialV3,
  SCROLL_AUTHORING_V3_VERSION,
  type EditorialV3Input,
  type EditorialV3Outcome,
  type EditorialV3Stage,
  type PublicationV3,
} from './v3/editorial.js';

/**
 * `scroll-writing-v3.v1`: what the model writer of a `scroll-document.v3` replies in (one reply, or prose and then
 * staging), the merge of the two, the compile into a stored document and provenance (or into findings one repair can
 * act on), its repair hints and its reference text (#771).
 */
export {
  SCROLL_WRITING_V3_VERSION,
  WrittenControlV3,
  WrittenItemV3,
  WrittenLinkV3,
  WrittenPictureV3,
  WrittenProseItemV3,
  WrittenProseV3,
  WrittenScrollV3,
  WrittenShowV3,
  WrittenStagingV3,
  WrittenStateV3,
} from './v3/written-schema.js';
export { mergeStagingV3, numberedProseText, stagingPathsV3, type MergedStagingV3 } from './v3/written-merge.js';
export {
  compileWrittenProseV3,
  compileWrittenV3,
  MACHINE_PHRASES_V3,
  type WrittenCodeFacts,
  type WrittenCompileInput,
  type WrittenCompileOutcome,
  type WrittenProseOutcome,
} from './v3/written.js';
export { REPAIR_HINTS_V3 } from './v3/reasons.js';
export { writtenReferenceV3, type WrittenArm } from './v3/written-reference.js';
