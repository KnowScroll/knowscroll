import { describe, expect, it } from 'vitest';
import { nextRunNotBefore, wakeAt } from './pacing.js';

describe("pacing one person's runs", () => {
  const settled = new Date('2026-10-24T10:00:00.000Z');

  it('lets the run after a settled one start 5 minutes later', () => {
    expect(nextRunNotBefore(settled)).toBe(new Date(settled.getTime() + 300000).toISOString());
  });

  it("delays a new run's wake only while that time is still ahead", () => {
    const notBefore = nextRunNotBefore(settled);
    expect(wakeAt(notBefore, new Date(settled.getTime() + 1_000))).toEqual(new Date(notBefore));
    expect(wakeAt(notBefore, new Date(notBefore))).toBeUndefined();
    expect(wakeAt(notBefore, new Date(settled.getTime() + 600_000))).toBeUndefined();
    expect(wakeAt(undefined, settled)).toBeUndefined();
  });
});
