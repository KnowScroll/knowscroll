import type { ClearAccountingTx, ClearLiability, PrivacyScopeTx } from '../modules/identity/public.js';
/**
 * The shared reasoning engine's public surface (blueprint §15, §22): the harness that module-owned
 * roles call and its typed inputs and outcomes. Roles (instructions, context builder, output
 * schema, semantic validator, applier) live in their owning modules. Deliberately NOT exported
 * here: the harness factory, its ports, the attempt ledger and the model transport port. A module
 * receives a ready `ReasoningHarness` (injected by `RECORDING_REASONING_HARNESS`) and cannot build its own
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
export type { ImageMime, ImageOutcome, ImagePort, ImageRequest } from './application/image-port.js';
export { HARNESS_PROMPT_VERSION } from './domain/prompt.js';

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
  ProductionScopeId,
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
/**
 * The room scope (D-162): the harness that pays for residents speaking on their own, and the scope function
 * that closes their runs. Same engine and ledger as production, bound to the `rooms` root, with its own enable
 * switch and daily caps. Worker-only.
 */
export const ROOM_REASONING_HARNESS = Symbol('reasoning.room-harness');
export const WITH_ROOM_SCOPE = Symbol('reasoning.with-room-scope');

/** Bounded owner port for selective Clear; global/role receipts and monetary states are untouched. */
export interface ClearReasoning {
  capture(scope: PrivacyScopeTx): Promise<readonly ClearLiability[]>;
  verifyAndPrune(scope: ClearAccountingTx): Promise<'pending' | 'verified' | 'verified_retained'>;
}

/** Required personal-recording boundary; no factory, ledger or transport is exposed here. */
export type {
  PersonalRecordingPurpose,
  StepOwnerModule,
  CheckPersonalRecordingRun,
  PersonalRunAccounting,
  PersonalRunAccountingBinding,
  ReadPersonalRunAccountingBinding,
  PersonalRecordingProposeInput,
  RecordingReasoningHarness,
} from './application/personal-recording.js';
export {
  applyClosingRun,
  closeStartedRun,
  closeStartedRunAlone,
  proposeAtGeneration,
  proposeWhenRecording,
  purposeOf,
  runOwnerOf,
  runToClose,
  startRunOwner,
  type RunOwner,
  type StartedRun,
  type StepProposal,
} from './application/recording-runs.js';
export const RECORDING_REASONING_HARNESS = Symbol('reasoning.recording-harness');
export const CHECK_PLANNER_RECORDING_RUN = Symbol('planner.check-recording-run');
export const CHECK_GEOGRAPHY_RECORDING_RUN = Symbol('geography.check-recording-run');
export const CHECK_SUPPLY_RECORDING_RUN = Symbol('supply.check-recording-run');
export const CHECK_SCENARIOS_RECORDING_RUN = Symbol('scenarios.check-recording-run');
export const CHECK_ROOMS_RECORDING_RUN = Symbol('rooms.check-recording-run');
export const CHECK_COMPOSER_RECORDING_RUN = Symbol('composer.check-recording-run');
export { parsePersonalRecordingPurpose } from './application/personal-recording.js';
