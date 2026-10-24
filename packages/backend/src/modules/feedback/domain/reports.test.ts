import { describe, expect, it } from 'vitest';
import { REPORTS_PER_WINDOW, REPORT_WINDOW_MS, reportsExhausted, windowStart } from './reports.js';

describe('the report bound', () => {
  it('allows reports up to the bound and refuses the next one', () => {
    expect(reportsExhausted(REPORTS_PER_WINDOW - 1)).toBe(false);
    expect(reportsExhausted(REPORTS_PER_WINDOW)).toBe(true);
  });

  it('counts the reports of the 24 hours before now', () => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    expect(now.getTime() - windowStart(now).getTime()).toBe(REPORT_WINDOW_MS);
  });
});
