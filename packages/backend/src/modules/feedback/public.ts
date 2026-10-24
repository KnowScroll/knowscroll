/**
 * Feedback's framework-free public surface (D-055): reports to the safety team about a Reel or Scroll,
 * a message or a person. "Not interested" is Experience's, because it shapes what that module offers.
 *
 * A report is never shown to the person it is about, or to anyone but its sender and the operators:
 * no use case here reads one back to a consumer, and the receipt a sender gets names nothing else.
 */
export type { ReportRefusal, ReportResult, ReportUseCases } from './application/file-report.js';

export { PurgeReportsPayloadSchema, purgeReportsQueue, type PurgeReportsPayload } from './events.js';
export type { PurgeReports } from './application/purge-reports.js';

export const REPORT_USE_CASES = Symbol('feedback.reportUseCases');
/** Injection token of the scheduled report purge (bound by `feedbackPurgeProviders`). */
export const PURGE_REPORTS = Symbol('feedback.purgeReports');
