/**
 * The shared reasoning engine's public surface (blueprint §15, §22): the harness that module-owned
 * roles call and its typed inputs and outcomes. Roles (instructions, context builder, output
 * schema, semantic validator, applier) live in their owning modules. Deliberately NOT exported
 * here: the harness factory, its ports, the attempt ledger and the model transport port. A module
 * receives a ready `ReasoningHarness` (injected by `REASONING_HARNESS`) and cannot build its own
 * with its own ledger or transport; composition roots and tests reach the factories through
 * `adapters/nest-providers.ts` only.
 */
export {
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_ITEM_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_ROLE_OUTPUT_TOKENS,
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
  PurgeExpiredRequestsPayloadSchema,
  SweepDispatchedAttemptsPayloadSchema,
  purgeExpiredRequestsQueue,
  sweepDispatchedAttemptsQueue,
  type PurgeExpiredRequestsPayload,
  type SweepDispatchedAttemptsPayload,
} from './events.js';
export type { BudgetCap, ReportedUsage } from './domain/budgets.js';
export { HARNESS_PROMPT_VERSION } from './domain/prompt.js';

/** Injection token of the worker's `ReasoningHarness` (bound by `reasoningProviders`). */
export const REASONING_HARNESS = Symbol('reasoning.harness');

/** Injection token of the scheduled protected-request purge (bound by `reasoningPurgeProviders`). */
export const PURGE_EXPIRED_REQUESTS = Symbol('reasoning.purge-expired-requests');

/** Deletes expired protected request bytes now; resolves with how many were deleted. */
export type PurgeExpiredRequests = () => Promise<number>;

/** Injection token of the scheduled crash-recovery sweep (bound by `reasoningSweepProviders`). */
export const SWEEP_DISPATCHED_ATTEMPTS = Symbol('reasoning.sweep-dispatched-attempts');

/** Moves attempts left `dispatched` past the request deadline to `unknown`; resolves with how many. */
export type SweepDispatchedAttempts = () => Promise<number>;

export type {
  ProductionAuthority,
  ProductionScopeTx,
  ProductionScopeOutcome,
  WithProductionScope,
  ProductionReasoningRun,
  ProductionProposeInput,
  ProductionReasoningHarness,
  ProductionAttemptAccounting,
  ProductionRunAccounting,
} from './application/production.js';

/** Worker-only injection tokens. Configuration and the database root default to disabled. */
export const PRODUCTION_REASONING_HARNESS = Symbol('reasoning.production-harness');
export const WITH_PRODUCTION_SCOPE = Symbol('reasoning.with-production-scope');

/** Closed Cutroom prerequisite: pure advice and future cents capability; no runtime binding. */
export { decideCutroomDelivery, canTransitionCutroomAttempt } from './domain/cutroom-attempt.js';
export type {
  CutroomAttemptIdentity,
  CutroomProtectedRequest,
  CutroomCentsReservation,
  CutroomAttemptSnapshot,
  CutroomDispatchOutcome,
  CutroomCentsReceipt,
} from './domain/cutroom-attempt.js';
export type { CutroomOwnerCapability, CutroomExecution } from './application/cutroom.js';

/** B only: shared transaction/reservation metadata. No full dispatch implementation. */
export type {
  CutroomScopeTx,
  CutroomAuthority,
  CutroomScopeOutcome,
  WithCutroomScope,
  CutroomPoolIdentity,
  CutroomCandidate,
  CutroomOwnerApproval,
  CutroomB,
  CutroomBResult,
  CutroomReservationPort,
  CutroomBusinessLock,
} from './application/cutroom-ports.js';

export { CutroomPoolWorkSchema, cutroomPoolQueue } from './events.js';
