/** Backend-only pure policy and private scoped persistence. No consumer diagnostics wire. */
export { composeEncounter, validateSnapshot } from './application/compose.js';
export { COMPOSER_POLICY } from './domain/policy.js';
export type {
  ComposerSnapshot,
  ComposerDecision,
  PreparedEvidenceInput,
  Features,
  CandidateEvaluation,
} from './domain/types.js';
export type {
  ComposeEncounter,
  ReadPreparedEvidenceInput,
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
