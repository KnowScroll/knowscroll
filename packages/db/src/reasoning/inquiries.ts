/**
 * Background bridge inquiries (ADR-0038, #132), on the same reasoning primitives as Ask answers. The
 * entry of the inquiry path; implementation lives in `inquiries/`. Consent, mail and opening run
 * under the universe lock; turning consent off or pausing withdraws what has not been sent, and
 * Clear/Reset erase everything. Execution and recovery are in `inquiry-execution.ts`.
 */

export { setInquiryConsent } from './inquiries/consent.ts';
export { mailRevokedConnections, postInquiryMail } from './inquiries/mail.ts';
export type { OpenResult } from './inquiries/opening.ts';
export { openDueInquiries, openInquiry } from './inquiries/opening.ts';
export { eraseInquiries, exportInquiries } from './inquiries/privacy.ts';
export { bridgeConnection, listInquiries } from './inquiries/reader.ts';
export {
  inquiryAuthority,
  inquiryRouteFor,
  installBackgroundInquiryRoute,
  jobFamily,
  requestRoute,
  resolveInquiryPolicy,
  sharedReasoningAuthority,
} from './inquiries/route.ts';
export type { InquiryRow } from './inquiries/shared.ts';
export { withdrawInquiries } from './inquiries/stopping.ts';
