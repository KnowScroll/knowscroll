/**
 * The shared reasoning engine's public surface (blueprint §15, §22): the harness that module-owned
 * roles call, its typed outcomes, and the transport port adapters implement. Roles (instructions,
 * context builder, output schema, semantic validator, applier) live in their owning modules. The
 * engine's adapters are bound through `adapters/nest-providers.ts` by composition roots only.
 */
export {
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_ITEM_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_ROLE_OUTPUT_TOKENS,
  makeReasoningHarness,
  type ContextItem,
  type ProposeInput,
  type ProposeLimits,
  type ProposeOutcome,
  type ProposeRefusal,
  type ReasoningContext,
  type ReasoningHarness,
  type ReasoningRole,
  type ReasoningRun,
} from './application/propose.js';
export {
  MAX_STORED_OUTPUT_BYTES,
  ModelNotSentError,
  ModelOutcomeUnknownError,
  ModelRejectedError,
  type AttemptLedger,
  type HarnessPorts,
  type HarnessSettings,
  type ModelPort,
  type ModelReply,
  type ModelRequest,
  type QuotaObservation,
  type StopReason,
} from './application/ports.js';
export { makeReasoningOperator, type ReasoningOperator } from './application/operator.js';
export {
  PurgeExpiredRequestsPayloadSchema,
  purgeExpiredRequestsQueue,
  type PurgeExpiredRequestsPayload,
} from './events.js';
export type { BudgetCap, ReportedUsage } from './domain/budgets.js';
export { HARNESS_PROMPT_VERSION } from './domain/prompt.js';

/** Injection token of the worker's `ReasoningHarness` (bound by `reasoningProviders`). */
export const REASONING_HARNESS = Symbol('reasoning.harness');

/** Injection token of the scheduled protected-request purge (bound by `reasoningPurgeProviders`). */
export const PURGE_EXPIRED_REQUESTS = Symbol('reasoning.purge-expired-requests');

/** Deletes expired protected request bytes now; resolves with how many were deleted. */
export type PurgeExpiredRequests = () => Promise<number>;
