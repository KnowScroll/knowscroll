/**
 * Operator's framework-free public surface: the use cases that let an operator look at the running
 * system through the allowlisted `ops` views (D-044), and the types they answer with. Nothing here
 * writes. The use cases are built by `adapters/nest-providers.ts`.
 */
export { makeIsOperator, type IsOperator } from './application/operator-access.js';
export { MAX_JOURNEY_STEPS, type JourneyOutcome, type ReadJourney } from './application/read-journey.js';
export type { ReadOperatorPanels } from './application/read-panels.js';
export { renderJourney } from './domain/render.js';
export type { Journey, JourneyGap, JourneyStep, JourneySubject } from './domain/journey.js';
export {
  RETENTION_QUEUES,
  type CartographerRunRow,
  type CartographerSummary,
  type ErrorRow,
  type OperatorPanels,
  type OutcomeCount,
  type Piece,
  type PrivacyOperationGroup,
  type PrivacySummary,
  type ProductionRunRow,
  type QueueRow,
  type RefusedAnswerRow,
  type ReelOrderRow,
  type Unavailable,
  type UsageSummary,
} from './domain/panels.js';

/** Injection tokens of the operator use cases (bound by the API composition root). */
export const READ_OPERATOR_PANELS = Symbol('operator.readPanels');
export const READ_JOURNEY = Symbol('operator.readJourney');
export const IS_OPERATOR = Symbol('operator.isOperator');
