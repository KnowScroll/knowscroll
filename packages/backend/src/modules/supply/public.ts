/** Private demand use cases; paid commissioning and transport are separate capabilities. */
export type {
  CreateRequest,
  ReadRequest,
  ListRequests,
  CancelRequest,
  RetryRequest,
  ResolveRequest,
  RecordPlannedDemand,
  PlannedDemandInput,
  PlannedDemandOutcome,
  Result,
  Refusal,
} from './application/ports.js';
export { resolveSupplyQueue, ResolveSupplyJobSchema, type ResolveSupplyJob } from './events.js';
export const CREATE_CONTENT_REQUEST = Symbol('supply.createRequest');
export const READ_CONTENT_REQUEST = Symbol('supply.readRequest');
export const LIST_CONTENT_REQUESTS = Symbol('supply.listRequests');
export const CANCEL_CONTENT_REQUEST = Symbol('supply.cancelRequest');
export const RETRY_CONTENT_REQUEST = Symbol('supply.retryRequest');
export const RESOLVE_CONTENT_REQUEST = Symbol('supply.resolveRequest');
export const RECORD_PLANNED_DEMAND = Symbol('supply.recordPlannedDemand');

/**
 * Quick answer (V3 D2, D-086, D-253): a short, unchecked answer about words selected in a Scroll, written by a worker. The API
 * asks, reads and dismisses; the worker answers; Feedback reads one for a report.
 */
export type {
  AskQuickAnswerUseCase,
  ReadQuickAnswerUseCase,
  DismissQuickAnswerUseCase,
  AnswerQuickAnswerUseCase,
  ReadQuickAnswerForReport,
  QuickAnswerRefusal,
  QuickAnswerResult,
  QuickAnswerSupportCheck,
} from './application/quick-answer-ports.js';
export type { PurgeQuickAnswers } from './application/purge-quick-answers.js';
export {
  answerQuickAnswerQueue,
  AnswerQuickAnswerJobSchema,
  purgeQuickAnswersQueue,
  type AnswerQuickAnswerJobPayload,
} from './quick-answer-events.js';
export const ASK_QUICK_ANSWER = Symbol('supply.askQuickAnswer');
export const READ_QUICK_ANSWER = Symbol('supply.readQuickAnswer');
export const DISMISS_QUICK_ANSWER = Symbol('supply.dismissQuickAnswer');
export const ANSWER_QUICK_ANSWER = Symbol('supply.answerQuickAnswer');
export const PURGE_QUICK_ANSWERS = Symbol('supply.purgeQuickAnswers');
export const READ_QUICK_ANSWER_FOR_REPORT = Symbol('supply.readQuickAnswerForReport');

/** Quartermaster's Create for a branch of a content thread; the scenarios module's choice calls it (D-049). */
export type { CommissionScenarioOrder, ScenarioOrder, ScenarioOrderOutcome } from './application/scenario-orders.js';
export const COMMISSION_SCENARIO_ORDER = Symbol('supply.commissionScenarioOrder');
