import { describe, expect, it } from 'vitest';
import { reportedOnDay } from './reports.js';

describe('reportedOnDay', () => {
  it('keeps the UTC day and drops the time', () => {
    expect(reportedOnDay(new Date('2026-10-24T23:59:59.999Z')).toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(reportedOnDay(new Date('2026-10-24T00:00:00.000Z')).toISOString()).toBe('2026-10-24T00:00:00.000Z');
  });
});
