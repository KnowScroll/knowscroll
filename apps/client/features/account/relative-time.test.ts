import { ago } from './relative-time';

const now = Date.parse('2026-10-24T12:00:00.000Z');
const before = (ms: number) => new Date(now - ms).toISOString();

describe('ago', () => {
  it('names a recent time as just now, then in minutes, hours and days', () => {
    expect(ago(before(2 * 60_000), now)).toBe('just now');
    expect(ago(before(25 * 60_000), now)).toBe('25 minutes ago');
    expect(ago(before(60 * 60_000), now)).toBe('1 hour ago');
    expect(ago(before(5 * 3_600_000), now)).toBe('5 hours ago');
    expect(ago(before(26 * 3_600_000), now)).toBe('yesterday');
    expect(ago(before(2 * 86_400_000), now)).toBe('2 days ago');
  });

  it('names the date beyond a month, and never reads a clock that is ahead as the future', () => {
    expect(ago(before(40 * 86_400_000), now)).toBe('on 14 Sep 2026');
    expect(ago(new Date(now + 5 * 60_000).toISOString(), now)).toBe('just now');
  });
});
