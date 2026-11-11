/** Backend-only prepared context. No consumer scores, source metadata or peer positions. */
export {
  CONTEXT_POLICY,
  ContributionSchema,
  ContextQuerySchema,
  RecordingContributionEnvelopeSchema,
} from './domain/context.js';
export type { Contribution, ContextQuery } from './domain/context.js';
export type {
  ApplyProjectedEncounter,
  ReadExplorationSnapshot,
  ReadCurrentPlan,
  ExplorationSnapshot,
  TopicStatistics,
  ReadRecentContextTopics,
} from './application/ports.js';
export { encounteredUnitsOf } from './application/met-units.js';
export const APPLY_PROJECTED_ENCOUNTER = Symbol('personal-context.applyProjectedEncounter');
export const READ_EXPLORATION_SNAPSHOT = Symbol('personal-context.readExplorationSnapshot');
export const ACTIVITY_CONTEXT_EFFECT = Symbol('personal-context.activityContextEffect');

export const READ_RECENT_CONTEXT_TOPICS = Symbol('personal-context.readRecentContextTopics');
/** Implements Composer's existing backend-only prepared-input capability via the context owner. */
export const READ_COMPOSER_CONTEXT = Symbol('personal-context.readComposerContext');
/** Implements Composer's policy v3 read of the person's long-term interest (top topics, roll-ups, planned units) over Evidence (D-420). */
export const READ_INTEREST_CONTEXT = Symbol('personal-context.readInterestContext');

/** Exact current observed witnesses; raw retained support counts are not geography authority. */
export { TrustedCoverageQuerySchema } from './domain/coverage.js';
export type { TrustedCoverageQuery, TrustedCoverageRead } from './domain/coverage.js';
export type { ReadTrustedCoverage } from './application/coverage-ports.js';
export const READ_TRUSTED_COVERAGE = Symbol('personal-context.readTrustedCoverage');

/**
 * What a Geography run evaluates (#674, slice 4.1, D-416). The dirty set lists the topics whose trusted support changed;
 * the inputs read gives the bounded newest keys of named topics; both are candidate discovery, never trusted supports,
 * unit counts or formation authority: Geography calls the current trusted read under the same root.
 */
export type {
  CoverageDirty,
  CoverageProbe,
  ReadCoverageDirty,
  ReadCoverageInputs,
  ClearCoverageDirty,
  MarkCoverageDirty,
} from './application/coverage-ports.js';
export const READ_COVERAGE_INPUTS = Symbol('personal-context.readCoverageInputs');
export const READ_COVERAGE_DIRTY = Symbol('personal-context.readCoverageDirty');
export const CLEAR_COVERAGE_DIRTY = Symbol('personal-context.clearCoverageDirty');
export const MARK_COVERAGE_DIRTY = Symbol('personal-context.markCoverageDirty');
