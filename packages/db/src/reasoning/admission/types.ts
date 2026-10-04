// Public input/result types and limits for admission, plus the row shapes its queries read.
// Kept apart from the entry so guards and reserve can import them without importing admission.ts.
import type {
  ReasoningBinding,
  ResolvedReasoningPolicy,
} from '../runtime-policy.ts';

export const REASONING_ADMISSION_LIMITS = Object.freeze({
  minLeaseMs: 1,
  maxLeaseMs: 60_000,
  minPermitTtlMs: 1,
  maxPermitTtlMs: 60_000,
});

export type ClaimJobInput = { owner: string; leaseMs: number };
export type ClaimedJob = {
  jobId: string;
  universeId: string;
  privacyEpoch: number;
  leaseFence: string;
  leaseExpiresAt: Date;
};

export type ReserveAttemptInput = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  contextId: string;
  owner: string;
  leaseFence: string;
  requestId: string;
  requestHash: string;
  inputTokensUpperBound: number;
  maxOutputTokens: number;
  costCeilingMicroUsd: number | null;
  deadline: string;
  permitTtlMs: number;
};

export type ReservedAttempt = {
  attemptId: string;
  permitId: string;
  reservationSetId: string;
  bindingHash: string;
  routeId: string;
  routeProfileVersion: string;
  permitExpiresAt: Date;
};

export type AuthorizeDispatchInput = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  attemptId: string;
  owner: string;
  leaseFence: string;
  requestId: string;
  requestHash: string;
  inputTokensUpperBound: number;
  maxOutputTokens: number;
  dispatchId: string;
};

export type DispatchGrant = {
  attemptId: string;
  requestId: string;
  dispatchId: string;
  routeId: string;
  routeProfileVersion: string;
  requestHash: string;
  inputTokensUpperBound: number;
  maxOutputTokens: number;
  deadline: string;
};

export type WithdrawJobInput = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  owner: string;
  leaseFence: string;
  reason: 'cancelled' | 'expired';
};
export type WithdrawalResult = {
  closedNotSent: number;
  preservedUnknown: number;
};

export type RecoverAttemptInput = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  attemptId: string;
  owner: string;
};
export type RecoveryResult = {
  attemptId: string;
  outcome: 'not_sent' | 'unknown';
  recoveryFence: string;
};

export type MarkAttemptUnknownInput = {
  universeId: string;
  privacyEpoch: number;
  jobId: string;
  stepId: string;
  attemptId: string;
  owner: string;
  leaseFence: string;
  reason: 'transport_loss' | 'deadline' | 'local_cancel';
};
export type MarkAttemptUnknownResult = {
  outcome: 'unknown' | 'private_state_gone';
  outputWithdrawn: boolean;
};

export type ReasoningAdmission = {
  claimJob(input: ClaimJobInput): Promise<ClaimedJob | null>;
  reserveAttempt(input: ReserveAttemptInput): Promise<ReservedAttempt>;
  authorizeDispatch(input: AuthorizeDispatchInput): Promise<DispatchGrant>;
  withdrawJob(input: WithdrawJobInput): Promise<WithdrawalResult>;
  recoverAttempt(input: RecoverAttemptInput): Promise<RecoveryResult>;
  markAttemptUnknown(
    input: MarkAttemptUnknownInput,
  ): Promise<MarkAttemptUnknownResult>;
};

export type JobRow = {
  id: string;
  universe_id: string;
  privacy_epoch: number;
  status: string;
  policy_version: string;
  deadline: Date;
  lease_owner: string | null;
  lease_fence: string;
  lease_expires_at: Date | null;
};

export type ReservationRow = {
  bucket_id: string;
  dimension: ReasoningBinding['dimension'];
  unit: ReasoningBinding['unit'];
  amount: string;
  state: string;
  usage_basis: ReasoningBinding['basis'];
  handling: ReasoningBinding['handling'];
};

export type ReasoningPreflightInput = Omit<
  ReserveAttemptInput,
  'owner' | 'leaseFence'
>;
export type ReasoningPreflight = {
  policy: ResolvedReasoningPolicy;
  bindingHash: string;
  physicallyFits: 'fit' | 'impossible' | 'capacity_exhausted' | 'paused';
};
