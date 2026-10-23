/** Backend-only pure policy and private scoped persistence. No consumer diagnostics wire. */
export { composeEncounter, validateSnapshot } from './application/compose.js';
export { COMPOSER_POLICY } from './domain/policy.js';
export type {
  ComposerSnapshot,
  ComposerDecision,
  PreparedEvidenceInput,
  SemanticAssessments,
  Features,
  CandidateEvaluation,
} from './domain/types.js';
export { prepareBufferQueue, PrepareBufferJobSchema, type PrepareBufferJob } from './events.js';
export { assembleSnapshot, evidenceQueryFor, type SnapshotInput } from './application/snapshot-assembly.js';
export { readVerticalCandidates, renderableFormats } from './application/vertical-candidates.js';
export type { PrepareBuffer, PrepareBufferResult } from './application/prepare-buffer.js';
export {
  bufferIsServable,
  validAssessments,
  type BufferKey,
  type BufferedSelection,
  type PreparedBuffer,
} from './domain/buffer.js';
export type {
  ComposeEncounter,
  ReadPreparedEvidenceInput,
  BufferSourceFacts,
  ReadBufferSource,
  ReadHiddenAssets,
  ReadComposerBuffer,
  ReleaseComposerBuffer,
  RequestBufferPreparation,
  DecisionBinding,
  PersistComposerDecision,
  ReadComposerDecision,
  PruneComposerDecisions,
  ComposerOperatorAccess,
} from './application/ports.js';
export const COMPOSE_ENCOUNTER = Symbol('composer.composeEncounter');
export const PERSIST_COMPOSER_DECISION = Symbol('composer.persistComposerDecision');
export const READ_COMPOSER_DECISION = Symbol('composer.readComposerDecision');
export const READ_PREPARED_EVIDENCE_INPUT = Symbol('composer.readPreparedEvidenceInput');

/** Served by Experience's wiring: what the buffer worker may know about an activated offer. */
export const READ_BUFFER_SOURCE = Symbol('composer.readBufferSource');
export const READ_HIDDEN_ASSETS = Symbol('composer.readHiddenAssets');
export const READ_COMPOSER_BUFFER = Symbol('composer.readBuffer');
export const RELEASE_COMPOSER_BUFFER = Symbol('composer.releaseBuffer');
export const REQUEST_BUFFER_PREPARATION = Symbol('composer.requestBufferPreparation');
export const PREPARE_COMPOSER_BUFFER = Symbol('composer.prepareBuffer');
