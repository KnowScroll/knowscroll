/**
 * The rules of a report that need no database (D-055).
 */

/** The most reports one account may send in `REPORT_WINDOW_MS`: enough for real trouble, too few to flood the safety team. */
export const REPORTS_PER_WINDOW = 25;
export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether the account has already sent as many reports as one window allows. */
export function reportsExhausted(sentInWindow: number): boolean {
  return sentInWindow >= REPORTS_PER_WINDOW;
}

/** The oldest report that still counts against the window that ends at `now`. */
export function windowStart(now: Date): Date {
  return new Date(now.getTime() - REPORT_WINDOW_MS);
}
