/** Backend-only prepared context. No consumer scores, source metadata or peer positions. */
export { CONTEXT_POLICY, ContributionSchema, ContextQuerySchema } from './domain/context.js';
export type { Contribution, ContextQuery } from './domain/context.js';
export type {
  ApplyProjectedEncounter,
  ReadExplorationSnapshot,
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
