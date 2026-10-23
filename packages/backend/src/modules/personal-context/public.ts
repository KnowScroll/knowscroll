import type { PersonalScopeTx } from '../identity/public.js';
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
export const APPLY_PROJECTED_ENCOUNTER = Symbol('personal-context.applyProjectedEncounter');
export const READ_EXPLORATION_SNAPSHOT = Symbol('personal-context.readExplorationSnapshot');
export const ACTIVITY_CONTEXT_EFFECT = Symbol('personal-context.activityContextEffect');

export const READ_RECENT_CONTEXT_TOPICS = Symbol('personal-context.readRecentContextTopics');
/** Implements Composer's existing backend-only prepared-input capability via the context owner. */
export const READ_COMPOSER_CONTEXT = Symbol('personal-context.readComposerContext');

/** Exact current observed witnesses; raw retained support counts are not geography authority. */
export { TrustedCoverageQuerySchema } from './domain/coverage.js';
export type { TrustedCoverageQuery, TrustedCoverageRead } from './domain/coverage.js';
import type { TrustedCoverageQuery } from './domain/coverage.js';
export type { ReadTrustedCoverage } from './application/coverage-ports.js';
export const READ_TRUSTED_COVERAGE = Symbol('personal-context.readTrustedCoverage');

/** Bounded indexed candidate keys (at most 1000, from at most 1000 raw references) and PC revision only; not counts or current formation authority. */
export type ReadCoverageInputs = (scope: PersonalScopeTx) => Promise<{
  readonly revision: number;
  readonly completeness: 'not_asserted';
  readonly availability: 'available' | 'unavailable';
  readonly reason: 'bounded' | 'limit';
  readonly probes: TrustedCoverageQuery['probes'];
}>;
export const READ_COVERAGE_INPUTS = Symbol('personal-context.readCoverageInputs');
