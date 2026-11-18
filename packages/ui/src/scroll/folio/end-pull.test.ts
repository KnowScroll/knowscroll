import { atVeryEnd, PULL_DISTANCE, pullProgress, type PullStart } from './end-pull';

const atEnd: PullStart = { x: 200, y: 600, atEnd: true, screenWidth: 400 };

describe('a pull up past the end of the essay', () => {
  it('fills as the finger travels up from the end, and is full at the distance a release needs', () => {
    expect(pullProgress(atEnd, 200, 600 - PULL_DISTANCE / 2)).toBeCloseTo(0.5);
    expect(pullProgress(atEnd, 210, 600 - PULL_DISTANCE)).toBe(1);
    expect(pullProgress(atEnd, 200, 600 - 3 * PULL_DISTANCE)).toBe(1);
  });

  it('is no pull when the page was not at its end as the finger went down: a fling into the end is reading', () => {
    expect(pullProgress({ ...atEnd, atEnd: false }, 200, 600 - 2 * PULL_DISTANCE)).toBe(0);
  });

  it('is no pull going down, going mostly sideways, or starting in a screen edge the platform keeps for Back', () => {
    expect(pullProgress(atEnd, 200, 700)).toBe(0);
    expect(pullProgress(atEnd, 330, 600 - PULL_DISTANCE)).toBe(0);
    expect(pullProgress({ ...atEnd, x: 10 }, 10, 600 - PULL_DISTANCE)).toBe(0);
    expect(pullProgress({ ...atEnd, x: 390 }, 390, 600 - PULL_DISTANCE)).toBe(0);
  });

  it('counts a page as at its end within a few pixels, and a page that fits its viewport as having no end', () => {
    expect(atVeryEnd(1398, 600, 2000)).toBe(true);
    expect(atVeryEnd(1300, 600, 2000)).toBe(false);
    expect(atVeryEnd(0, 600, 600)).toBe(false);
  });
});
