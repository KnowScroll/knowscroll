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
export { copiedRuns } from '../text.js';
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
export { AuthoredItemV2, AuthoredScrollV2, SCROLL_AUTHORING_V2_VERSION } from './v2/authoring-schema.js';
export {
  assembleScrollV2,
  shuffleOptions,
  type Assembly,
  type AssemblyMap,
  type PublicationV2,
  type RecipeDataV2,
} from './v2/assemble.js';
export { compileAuthoredV2, type CompileV2Input, type CompileV2Outcome } from './v2/compile.js';
export { authoringReferenceV2 } from './v2/reference.js';
export { REPAIR_HINTS_V2 } from './v2/reasons.js';
export { authoringIssuesV2, type AuthoringRulesInput } from './v2/rules.js';
