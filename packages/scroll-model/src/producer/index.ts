/**
 * `@knowscroll/scroll-model/producer`: the backend-only producer contract — the canonical draft and its
 * compile input, staged draft validation and compilation into the consumer document plus its
 * internal provenance (the editorial source, and the tests of the reader), and the document v3 writer's reply and compile.
 * The v1 writer's authored shape (`scroll-authoring.v1`) and its compile are deleted (#818). Client packages must never import this entry (dependency-cruiser
 * `clients-never-import-scroll-internals`).
 */
export { type AuthoringEvidence } from './authoring-evidence.js';
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

export { unstatedFigures } from './figures.js';

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
export { looseCopyIssuesV3 } from './v3/copy-loose.js';
export { writtenReferenceV3, type WrittenArm } from './v3/written-reference.js';
