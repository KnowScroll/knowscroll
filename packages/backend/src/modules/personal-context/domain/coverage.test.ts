import { describe, expect, it } from 'vitest';
import { newestWitnessPerSupport } from './coverage.js';

const hex = (digit: string) => digit.repeat(64);
const witness = (exposureId: string, at: string, overrides: Record<string, string> = {}) => ({
  topicId: 'earth.seasons',
  facetId: 'earth.seasons.axial-tilt',
  meaningSha256: hex('a'),
  explanationUnitId: 'unit-1',
  truthSha256: hex('b'),
  exposureId,
  at,
  ...overrides,
});
const newest = (witnesses: ReturnType<typeof witness>[]) =>
  newestWitnessPerSupport(witnesses, (w) => w.at).map((w) => w.exposureId);

describe('the newest witness of each support key (#674)', () => {
  it('keeps one witness for a support read many times, the one activated last', () => {
    // Exposures 8, 17, 26, 35 and 44 share the latest activation; the greatest id wins the tie.
    const rereads = Array.from({ length: 50 }, (_, n) =>
      witness(
        `exposure-${String(n).padStart(2, '0')}`,
        `2026-11-${String(1 + (n % 9)).padStart(2, '0')}T10:00:00.000Z`,
      ),
    );
    expect(newest(rereads)).toEqual(['exposure-44']);
  });

  it('breaks a tie by the greater exposure id, so the choice never depends on the order of the rows', () => {
    const tied = [witness('exposure-a', '2026-11-05T10:00:00.000Z'), witness('exposure-b', '2026-11-05T10:00:00.000Z')];
    expect(newest(tied)).toEqual(['exposure-b']);
    expect(newest([...tied].reverse())).toEqual(['exposure-b']);
  });

  it('keeps one witness for each key, and keys that differ only by meaning or framing are different keys', () => {
    const rows = [
      witness('exposure-1', '2026-11-01T10:00:00.000Z'),
      witness('exposure-2', '2026-11-02T10:00:00.000Z', { facetId: 'earth.seasons.hemispheres' }),
      witness('exposure-3', '2026-11-03T10:00:00.000Z', { meaningSha256: hex('c') }),
      witness('exposure-4', '2026-11-04T10:00:00.000Z', { truthSha256: hex('d') }),
      witness('exposure-5', '2026-11-05T10:00:00.000Z', { explanationUnitId: 'unit-2' }),
    ];
    expect(newest(rows).sort()).toEqual(['exposure-1', 'exposure-2', 'exposure-3', 'exposure-4', 'exposure-5']);
  });

  it('reads an activation time as a time, not as text', () => {
    const rows = [witness('exposure-a', '2026-11-05T10:00:00Z'), witness('exposure-b', '2026-11-05T10:00:00.5Z')];
    expect(newest(rows)).toEqual(['exposure-b']);
  });
});
