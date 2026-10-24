import { describe, expect, it } from 'vitest';
import { stableUuid } from './stable-uuid.js';

describe('stableUuid', () => {
  it('is the same for the same name and different for another', () => {
    expect(stableUuid('produce-scroll:seasons:v1')).toBe(stableUuid('produce-scroll:seasons:v1'));
    expect(stableUuid('produce-scroll:seasons:v1')).not.toBe(stableUuid('produce-scroll:tides:v1'));
  });

  it('has the shape of a lowercase version 4 UUID, which pg-boss and the enqueue port accept', () => {
    for (const name of ['a', 'b', 'c', 'seasons', 'x'.repeat(500)])
      expect(stableUuid(name)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
