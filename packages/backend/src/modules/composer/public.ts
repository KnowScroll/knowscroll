/** Backend-only pure policy and private scoped persistence. No consumer diagnostics wire. */
export { composeEncounter, validateSnapshot } from './application/compose.js';
export { formatLeaning } from './domain/features.js';
export { metUnitsOf } from './domain/encountered.js';
export { gapSignalsOf, LOW_HEADROOM_UNITS, type DecisionGapSignal } from './domain/gap-signals.js';
export {
  composerPolicyFor,
  COMPOSER_POLICY_V0,
  COMPOSER_POLICY_V1,
  COMPOSER_POLICY_V2,
  policyOf,
  type ComposerPolicy,
  type ComposerPolicySetting,
  type ComposerPolicyVersion,
} from './domain/policy.js';
export {
  DEFAULT_VARIANTS,
  startPolicyReplay,
  withVerticalWeights,
  type PolicyReplayReport,
  type ReplayVariant,
  type StoredDecision,
  type VariantReport,
} from './application/replay-policy.js';
export type {
  ComposerSnapshot,
  ComposerDecision,
  PreparedEvidenceInput,
  CurrentPlan,
  PlannedOpportunity,
  PlanInfluence,
  SemanticAssessments,
  Features,
  CandidateEvaluation,
  SourcePlace,
  UnseenLadderOutcome,
} from './domain/types.js';
export { prepareBufferQueue, PrepareBufferJobSchema, pruneDecisionsQueue, type PrepareBufferJob } from './events.js';
export { assembleSnapshot, evidenceQueryFor, type SnapshotInput } from './application/snapshot-assembly.js';
export {
  readUnseenFirst,
  readVerticalCandidates,
  renderableFormats,
  wantsUnseenFirst,
} from './application/vertical-candidates.js';
export { readRelatedAssetIds } from './application/related-targets.js';
export type { PrepareBuffer, PrepareBufferResult } from './application/prepare-buffer.js';
export type { BackfillPruneDecisions, PruneDecisions } from './application/prune-decisions.js';
export {
  bufferIsServable,
  validAssessments,
  type BufferKey,
  type BufferedSelection,
  type PreparedBuffer,
} from './domain/buffer.js';
export type {
  ComposeEncounter,
  ReadMetUnitIds,
  ReadPreparedEvidenceInput,
  BufferSourceFacts,
  ReadBufferSource,
  CheckRecordedActivation,
  ReadHiddenAssets,
  ReadComposerBuffer,
  ReleaseComposerBuffer,
  PurgeExpiredComposerBuffer,
  RequestBufferPreparation,
  DecisionBinding,
  PersistComposerDecision,
  RecordDecisionSignals,
  ReadComposerDecision,
  PruneComposerDecisions,
  ComposerOperatorAccess,
} from './application/ports.js';
export const COMPOSE_ENCOUNTER = Symbol('composer.composeEncounter');
export const PERSIST_COMPOSER_DECISION = Symbol('composer.persistComposerDecision');
export const READ_COMPOSER_DECISION = Symbol('composer.readComposerDecision');

/** Served by Experience's wiring: what the buffer worker may know about an activated offer. */
export const READ_BUFFER_SOURCE = Symbol('composer.readBufferSource');
export const READ_HIDDEN_ASSETS = Symbol('composer.readHiddenAssets');
/** Served by Experience's wiring: the explanation units the person has met, newest first and bounded (policy v2, D-408). */
export const READ_MET_UNIT_IDS = Symbol('composer.readMetUnitIds');
/** Served by Experience's wiring: whether an exposure was activated, for Jev's owner check (D-270). */
export const CHECK_RECORDED_ACTIVATION = Symbol('composer.checkRecordedActivation');
export const READ_COMPOSER_BUFFER = Symbol('composer.readBuffer');
export const RELEASE_COMPOSER_BUFFER = Symbol('composer.releaseBuffer');
export const PURGE_EXPIRED_COMPOSER_BUFFER = Symbol('composer.purgeExpiredBuffer');
export const REQUEST_BUFFER_PREPARATION = Symbol('composer.requestBufferPreparation');
export const PREPARE_COMPOSER_BUFFER = Symbol('composer.prepareBuffer');
/** The scheduled sweep that deletes expired decisions nothing holds (`composer.prune-decisions`). */
export const PRUNE_COMPOSER_DECISIONS = Symbol('composer.pruneDecisions');
