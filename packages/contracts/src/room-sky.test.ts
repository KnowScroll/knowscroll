import { describe, expect, it } from 'vitest';
import { NewDebateSchema, RoomNamingSchema, RoomSkySchema } from './room-sky.js';

describe('the sky of a room (D-174)', () => {
  const sky = (over: object) => RoomSkySchema.safeParse({ lit: 3, of: 7, state: 'forming', finished: 0, ...over });

  it('accepts a forming constellation, a finished one awaiting a name and a named one', () => {
    expect(sky({}).success).toBe(true);
    expect(sky({ lit: 7, state: 'naming', finished: 1 }).success).toBe(true);
    expect(sky({ lit: 7, state: 'named', finished: 1, constellationName: 'The Lantern' }).success).toBe(true);
    expect(sky({ lit: 1, finished: 2, constellationName: 'The Lantern' }).success).toBe(true);
  });

  it('refuses a sky that cannot be: a full forming one, a short finished one, a named one with no name', () => {
    expect(sky({ lit: 7 }).success).toBe(false);
    expect(sky({ lit: 5, state: 'naming', finished: 1 }).success).toBe(false);
    expect(sky({ lit: 7, state: 'naming', finished: 0 }).success).toBe(false);
    expect(sky({ lit: 7, state: 'named', finished: 1 }).success).toBe(false);
    expect(sky({ lit: 8 }).success).toBe(false);
  });

  it('carries no person: a sky has no place for who earned a star', () => {
    expect(sky({ by: 'asha' }).success).toBe(false);
  });

  it('offers exactly three names, and a vote of one of them', () => {
    const naming = {
      constellation: 1,
      candidates: ['A one', 'B two', 'C three'],
      closesAt: '2026-10-27T10:00:00.000Z',
    };
    expect(RoomNamingSchema.safeParse(naming).success).toBe(true);
    expect(RoomNamingSchema.safeParse({ ...naming, candidates: ['A one', 'B two'] }).success).toBe(false);
    expect(RoomNamingSchema.safeParse({ ...naming, yourVote: 3 }).success).toBe(false);
  });

  it('asks a debate for two different short sides and a close time within a week', () => {
    const debate = { sides: ['Dark matter', 'Modified gravity'], closesInHours: 24 };
    expect(NewDebateSchema.safeParse(debate).success).toBe(true);
    expect(NewDebateSchema.safeParse({ ...debate, sides: ['Same', 'same'] }).success).toBe(false);
    expect(NewDebateSchema.safeParse({ ...debate, closesInHours: 0 }).success).toBe(false);
    expect(NewDebateSchema.safeParse({ ...debate, closesInHours: 169 }).success).toBe(false);
    expect(NewDebateSchema.safeParse({ ...debate, sides: ['One', 'x'.repeat(61)] }).success).toBe(false);
  });
});
