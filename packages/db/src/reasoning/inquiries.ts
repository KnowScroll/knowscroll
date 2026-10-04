/**
 * #132 — background bridge inquiries (ADR-0038), on the same reasoning primitives as Ask answers.
 *
 * Standing consent (`setInquiryConsent`, from a live session) lets the Cartographer post mail
 * (`postInquiryMail`, called by `applyDeltas`) into at most one pending inquiry per universe and
 * kind. The worker opens a due inquiry (`openDueInquiries`) with fresh authority under the universe
 * lock: consent, recording, route and today's limit, then either `nothing_to_ask` with no Job, or the
 * background Job, its sealed context, one Step and the exact request bytes, enqueued fairly.
 * Execution, application and recovery live in `inquiry-execution.ts`. Turning consent off
 * and pausing withdraw what has not been sent (`withdrawInquiries`); Clear/Reset erase it all.
 */

export { InquiryError } from './inquiries/shared.ts';
export type { InquiryRoute, InquiryRow } from './inquiries/shared.ts';
export {
  installBackgroundInquiryRoute,
  inquiryRouteFor,
  requestRoute,
  resolveInquiryPolicy,
  inquiryAuthority,
  sharedReasoningAuthority,
  jobFamily,
} from './inquiries/route.ts';
export { readInquiryConsent, setInquiryConsent } from './inquiries/consent.ts';
export { postInquiryMail, mailRevokedConnections } from './inquiries/mail.ts';
export type { InquiryMailCause } from './inquiries/mail.ts';
export { withdrawInquiries } from './inquiries/stopping.ts';
export { openDueInquiries, openInquiry } from './inquiries/opening.ts';
export type { OpenResult } from './inquiries/opening.ts';
export { bridgeConnection, listInquiries } from './inquiries/reader.ts';
export { eraseInquiries, exportInquiries } from './inquiries/privacy.ts';
