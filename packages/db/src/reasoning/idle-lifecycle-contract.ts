// Types shared by idle-lifecycle and its callers, kept apart so callers need not import its SQL.
// Internal helpers require a caller-owned transaction; no public API (ADR-0018).
export type IdleDirectJobScope = {
  jobId: string;
  universeId: string;
  privacyEpoch: number;
};
export type IdleWithdrawalResult = {
  status: 'cancelled' | 'expired';
  changed: boolean;
  closedNotSent: number;
  preservedUnknown: number;
};
export const IDLE_WITHDRAWAL_LIMITS = Object.freeze({
  steps: 128,
  attempts: 128,
});
