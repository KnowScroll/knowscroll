/**
 * Executing one background bridge inquiry (ADR-0038 §6–§8, #132), mirroring the Ask-answer path. The
 * entry of the execution path; implementation lives in `inquiry-execution/`. A reply becomes a decided
 * proposal only through `submitBridgeProposal`, a refusal may continue (ADR-0042 §1), and nothing
 * here ever re-sends a request.
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
