/**
 * `@knowscroll/scroll-model/producer`: the backend-only producer contract — the draft the writer
 * model returns, the compile input, the prompt catalogue, staged draft validation and compilation
 * into the consumer document plus its internal provenance. Client packages must never import this
 * entry (dependency-cruiser `clients-never-import-scroll-internals`).
 */
export { blockCatalogueText, CATALOGUE_MAX_BYTES } from './catalogue.js';
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
