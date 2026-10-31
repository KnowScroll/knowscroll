import { describe, expect, it } from 'vitest';
import { ORBIT_DAYS_TO_CLOSE as CONTRACT_DAYS } from '@knowscroll/contracts';
import { ORBIT_DAYS_TO_CLOSE, orbitOf, weekStartOf } from './orbit.js';

describe('the weekly Orbit', () => {
  it('names the same number of days as the contract', () => {
    expect(ORBIT_DAYS_TO_CLOSE).toBe(CONTRACT_DAYS);
  });

  it('begins a week on Monday, across a month and a year', () => {
    expect(weekStartOf('2026-11-02')).toBe('2026-11-02'); // a Monday
    expect(weekStartOf('2026-11-08')).toBe('2026-11-02'); // the Sunday after
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26'); // a Sunday, the week before
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28'); // across the year
    expect(weekStartOf('2028-02-29')).toBe('2028-02-28'); // a leap day, a Tuesday
  });

  it('counts the distinct days of this week and ignores repeats', () => {
    const orbit = orbitOf(['2026-11-02', '2026-11-02', '2026-11-04'], '2026-11-05');
    expect(orbit).toEqual({ days: 2, goal: 3, weekStart: '2026-11-02', closed: false });
  });

  it('closes at three days and stays closed with more', () => {
    expect(orbitOf(['2026-11-02', '2026-11-03', '2026-11-04'], '2026-11-04').closed).toBe(true);
    expect(orbitOf(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'], '2026-11-05')).toMatchObject({
      days: 4,
      closed: true,
    });
  });

  it('leaves a missed week behind: the new Monday begins at zero and removes nothing', () => {
    const lastWeek = ['2026-10-26', '2026-10-27', '2026-10-28'];
    expect(orbitOf(lastWeek, '2026-10-28').closed).toBe(true);
    expect(orbitOf(lastWeek, '2026-11-02')).toEqual({ days: 0, goal: 3, weekStart: '2026-11-02', closed: false });
  });

  it('ignores a day after today (a clock that stepped back)', () => {
    expect(orbitOf(['2026-11-06'], '2026-11-04').days).toBe(0);
  });
});
