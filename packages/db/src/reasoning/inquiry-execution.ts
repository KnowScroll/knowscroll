/**
 * #132 — executing one background bridge inquiry (ADR-0038 §6–§8), mirroring the Ask-answer path.
 *
 * The worker rebuilds the reserved bytes from the sealed context (`loadInquiryWork`), sends them once
 * through `invokeReasoningOnce`, then finishes under its fence: `applyInquiryReply` rechecks the
 * sealed facts and turns a reply into a decided proposal only through `submitBridgeProposal`
 * (universe scope, proposer `model`, the Attempt id as its reference), or `failInquiry` ends it
 * honestly. When the validator refuses, the route may allow one continuation (ADR-0042 §1): the next
 * Step, carrying the refused turn and the validator's reasons, is recorded and queued fairly, never
 * sent from here. `settleInquiries` is the recovery sweep: expired leases, leaseless Jobs, stale or
 * expired queued Jobs and terminal Jobs whose inquiry is still open. Nothing here ever re-sends a request.
 */

export { loadInquiryWork } from './inquiry-execution/load.ts';
export type {
  InquiryWork,
  InquiryFence,
  ProviderReply,
  InquiryOutcome,
} from './inquiry-execution/load.ts';
export { applyInquiryReply } from './inquiry-execution/apply.ts';
export { failInquiry } from './inquiry-execution/fail.ts';
export type { InquiryFailure } from './inquiry-execution/fail.ts';
export { giveBackUnsentInquiry } from './inquiry-execution/recovery.ts';
export { settleInquiries } from './inquiry-execution/settle.ts';
