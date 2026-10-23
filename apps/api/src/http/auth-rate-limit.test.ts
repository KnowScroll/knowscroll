import { describe, expect, it } from 'vitest';
import { WindowLimiter } from './auth-rate-limit.js';

describe('WindowLimiter', () => {
  it('allows max per window per key, answers the wait, and starts a fresh window afterwards', () => {
    let now = 0;
    const limiter = new WindowLimiter({ max: 2, windowSeconds: 60 }, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('b')]).toEqual([undefined, undefined, undefined]);
    now = 15_000;
    expect(limiter.take('a')).toBe(45);
    now = 60_000;
    expect(limiter.take('a')).toBeUndefined();
  });

  it('forgets the oldest keys beyond its bound', () => {
    const limiter = new WindowLimiter({ max: 1, windowSeconds: 60 }, () => 0, 2);
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    // `a` was forgotten, so it starts again; `c` is still counted.
    expect(limiter.take('a')).toBeUndefined();
    expect(limiter.take('c')).toBe(60);
  });
});
