/** What a moderator may learn of a report about a message in their room (D-055). No database or clock. */

/**
 * The start of the UTC day of the newest report. A moderator learns which day, not the minute: the minute
 * could single out the one person who was online then.
 */
export function reportedOnDay(newestReportAt: Date): Date {
  return new Date(Date.UTC(newestReportAt.getUTCFullYear(), newestReportAt.getUTCMonth(), newestReportAt.getUTCDate()));
}
