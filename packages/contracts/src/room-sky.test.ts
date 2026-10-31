import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RoomStationSchema, RoomTodaySchema, RoomSkyViewSchema } from './rooms.js';
import { NewDebateSchema, RoomDebateSchema, RoomNamingSchema, RoomSkySchema } from './room-sky.js';

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

describe('what a tally says and to whom', () => {
  const debate = (over: object) => ({
    sides: [{ text: 'Dark matter' }, { text: 'Modified gravity' }],
    closesAt: '2026-10-27T10:00:00.000Z',
    state: 'open',
    ...over,
  });
  const counted = [
    { text: 'Dark matter', votes: 2 },
    { text: 'Modified gravity', votes: 1 },
  ];

  it('holds a debate tally back until the reader voted or the debate closed', () => {
    expect(RoomDebateSchema.safeParse(debate({})).success).toBe(true);
    expect(RoomDebateSchema.safeParse(debate({ yourVote: 'a', sides: counted })).success).toBe(true);
    expect(RoomDebateSchema.safeParse(debate({ state: 'closed', sides: counted, winner: 'a' })).success).toBe(true);
    // Counts to a reader who has not voted, counts on one side only, and a vote with no counts are all refused.
    expect(RoomDebateSchema.safeParse(debate({ sides: counted })).success).toBe(false);
    expect(
      RoomDebateSchema.safeParse(debate({ yourVote: 'a', sides: [counted[0], { text: 'Modified gravity' }] })).success,
    ).toBe(false);
    expect(RoomDebateSchema.safeParse(debate({ yourVote: 'a' })).success).toBe(false);
    expect(RoomDebateSchema.safeParse(debate({ state: 'closed' })).success).toBe(false);
  });

  it('names a winner only once the debate closed', () => {
    expect(RoomDebateSchema.safeParse(debate({ yourVote: 'a', sides: counted, winner: 'a' })).success).toBe(false);
  });

  it('holds a name vote tally back until the reader voted, and gives a vote its tally', () => {
    const naming = {
      constellation: 1,
      candidates: ['A one', 'B two', 'C three'],
      closesAt: '2026-10-27T10:00:00.000Z',
    };
    expect(RoomNamingSchema.safeParse({ ...naming, yourVote: 1, votes: [0, 2, 1] }).success).toBe(true);
    expect(RoomNamingSchema.safeParse({ ...naming, votes: [0, 2, 1] }).success).toBe(false);
    expect(RoomNamingSchema.safeParse({ ...naming, yourVote: 1 }).success).toBe(false);
  });
});

/** The number-typed key paths of a schema, with array and tuple items named as their parent. */
function numberPaths(schema: z.ZodType, path: string, found: Set<string>): void {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  if (def.type === 'number') {
    found.add(path);
    return;
  }
  if (def.type === 'object') {
    for (const [key, child] of Object.entries(def['shape'] as Record<string, z.ZodType>))
      numberPaths(child, path === '' ? key : `${path}.${key}`, found);
    return;
  }
  const children = [
    def['element'],
    def['innerType'],
    def['in'],
    ...((def['options'] as unknown[] | undefined) ?? []),
    ...((def['items'] as unknown[] | undefined) ?? []),
  ] as (z.ZodType | undefined)[];
  for (const child of children) if (child !== undefined) numberPaths(child, path, found);
}

describe('every number a room shows about its sky', () => {
  const of = (schema: z.ZodType) => {
    const found = new Set<string>();
    numberPaths(schema, '', found);
    // The envelope's privacy epoch is the caller's own scope, not a figure about the room.
    found.delete('scope.privacyEpoch');
    // A cited Scroll's revision is a fact about content, not a figure about the room.
    for (const path of found) if (path.endsWith('.assetRevision')) found.delete(path);
    return [...found].sort();
  };

  it('is named here, so a new count is a decision and not an accident (D-176)', () => {
    expect(of(RoomStationSchema)).toEqual(['sky.finished', 'sky.lit']);
    expect(of(RoomSkyViewSchema)).toEqual([
      'naming.constellation',
      'naming.votes',
      'naming.yourVote',
      'sky.finished',
      'sky.lit',
      'stars.constellation',
      'starsPerDay',
    ]);
    expect(of(RoomDebateSchema)).toEqual(['sides.votes']);
    expect(of(RoomTodaySchema)).toEqual(
      ['flaw.found', 'flaw.flawIndex', 'flaw.yourPick', 'question.messagesToday'].sort(),
    );
  });
});
