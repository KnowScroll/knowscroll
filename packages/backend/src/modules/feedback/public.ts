/**
 * Feedback's framework-free public surface (D-055): reports to the safety team about a Reel or Scroll,
 * a message or a person. "Not interested" is Experience's, because it shapes what that module offers.
 *
 * A report is never shown to the person it is about, or to anyone but its sender and the operators:
 * no use case here reads one back to a consumer, and the receipt a sender gets names nothing else.
 */
import type { PersonalScopeTx } from '../identity/public.js';

export type { ReportRefusal, ReportResult, ReportUseCases } from './application/file-report.js';

export const REPORT_USE_CASES = Symbol('feedback.reportUseCases');

/** What the moderators of a room may see about one message of theirs that was reported: why, how many times and when. */
export interface RoomReport {
  readonly messageId: string;
  readonly categories: readonly string[];
  readonly count: number;
  readonly lastReportedAt: Date;
}

/**
 * Port: the reports on messages of one room, newest first, for that room's moderators (D-055). It leaves
 * out every report about the asking moderator's own words, and never carries who reported, a note or
 * the author. Who may ask is the Rooms module's check; this read only answers.
 */
export type ReadRoomReports = (
  scope: PersonalScopeTx,
  query: { readonly roomId: string; readonly excludingAccountId: string; readonly limit: number },
) => Promise<readonly RoomReport[]>;
export const READ_ROOM_REPORTS = Symbol('feedback.readRoomReports');
