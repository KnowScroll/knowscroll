/**
 * The rules of a report that need no database (D-055).
 */

/** The most reports one account may send in `REPORT_WINDOW_MS`: enough for real trouble, too few to flood the safety team. */
export const REPORTS_PER_WINDOW = 25;
export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a report about a deleted account is kept, counted from that deletion (D-055). Deleting an
 * account must not erase what other people told the safety team about it, but the report must not
 * outlive the need: after this many days the scheduled purge removes it.
 */
export const DELETED_ACCOUNT_REPORT_RETENTION_DAYS = 90;

/** Whether the account has already sent as many reports as one window allows. */
export function reportsExhausted(sentInWindow: number): boolean {
  return sentInWindow >= REPORTS_PER_WINDOW;
}

/** The oldest report that still counts against the window that ends at `now`. */
export function windowStart(now: Date): Date {
  return new Date(now.getTime() - REPORT_WINDOW_MS);
}
