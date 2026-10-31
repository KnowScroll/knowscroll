import { describe, expect, it } from 'vitest';
import { dayOf, movePlace, shownPlaces, type PlaceMember, type PlaceRow, type StoredPlace } from './places.js';

const stored = (part: number, state: 'on' | 'finished', day = '2026-10-30'): StoredPlace => ({ part, state, day });

describe('the day a place carries', () => {
  it('is the UTC calendar date and never a time', () => {
    expect(dayOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-31');
    expect(dayOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
    expect(dayOf(new Date('2026-10-31T13:02:11.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('moving a place', () => {
  it('stores the first place with today’s day', () => {
    expect(movePlace(undefined, { part: 1, state: 'on' }, '2026-10-31')).toEqual({
      kind: 'store',
      place: { part: 1, state: 'on', day: '2026-10-31' },
    });
  });

  it('only moves forward: on a part, then finished it, then on the next', () => {
    const steps = [
      { part: 1, state: 'on' as const },
      { part: 1, state: 'finished' as const },
      { part: 2, state: 'on' as const },
      { part: 2, state: 'finished' as const },
    ];
    let current: StoredPlace | undefined;
    for (const step of steps) {
      const move = movePlace(current, step, '2026-10-31');
      expect(move.kind).toBe('store');
      if (move.kind === 'store') current = move.place;
    }
    expect(current).toEqual({ part: 2, state: 'finished', day: '2026-10-31' });
  });

  it('keeps the place when the member opens an earlier part or a part they finished, and on a repeat', () => {
    const current = stored(2, 'finished');
    for (const reported of [
      { part: 2, state: 'finished' as const },
      { part: 2, state: 'on' as const },
      { part: 1, state: 'on' as const },
      { part: 1, state: 'finished' as const },
    ])
      expect(movePlace(current, reported, '2026-11-02')).toEqual({ kind: 'keep' });
  });

  it('keeps the day the member got there when the same place is reported again', () => {
    expect(movePlace(stored(2, 'on', '2026-10-30'), { part: 2, state: 'on' }, '2026-11-02')).toEqual({ kind: 'keep' });
  });

  it('may finish a part that was never opened here', () => {
    expect(movePlace(stored(1, 'on'), { part: 3, state: 'finished' }, '2026-10-31')).toMatchObject({
      kind: 'store',
      place: { part: 3, state: 'finished' },
    });
  });
});

describe('who sees which place', () => {
  const standing = { pending: false, left: false, stands: true } as const;
  const member = (accountId: string, patch: Partial<PlaceMember> = {}): PlaceMember => ({
    accountId,
    placeHidden: false,
    ...standing,
    ...patch,
  });
  const row = (accountId: string, part: number, state: 'on' | 'finished' = 'on'): PlaceRow => ({
    accountId,
    part,
    state,
    day: '2026-10-30',
  });
  const show = (input: { members: PlaceMember[]; rows: PlaceRow[]; blocked?: string[]; reader?: string }): string[] =>
    shownPlaces({
      readerAccountId: input.reader ?? 'asha',
      members: input.members,
      rows: input.rows,
      blockedWithReader: new Set(input.blocked ?? []),
      nameOf: (each) => each.accountId,
    }).map((entry) => `${entry.member.accountId}:${String(entry.place.part)}${entry.place.state}`);

  const party = [member('asha'), member('ravi'), member('kenji')];

  it('lists members who share, ordered by how far along and then by name, not by arrival', () => {
    expect(show({ members: party, rows: [row('kenji', 1), row('ravi', 2), row('asha', 1)] })).toEqual([
      'asha:1on',
      'kenji:1on',
      'ravi:2on',
    ]);
    expect(show({ members: party, rows: [row('ravi', 2, 'finished'), row('kenji', 2)] })).toEqual([
      'kenji:2on',
      'ravi:2finished',
    ]);
  });

  it('leaves out a member who hides, however their row got there', () => {
    const hidden = [member('asha'), member('ravi', { placeHidden: true })];
    expect(show({ members: hidden, rows: [row('asha', 1), row('ravi', 2)] })).toEqual(['asha:1on']);
  });

  it('leaves out someone who left, has not joined, or no longer stands', () => {
    const gone = [
      member('asha'),
      member('ravi', { left: true }),
      member('kenji', { pending: true }),
      member('meera', { stands: false }),
    ];
    expect(show({ members: gone, rows: gone.map((each) => row(each.accountId, 1)) })).toEqual(['asha:1on']);
  });

  it('leaves out a row whose member is not in the thread', () => {
    expect(show({ members: [member('asha')], rows: [row('asha', 1), row('stranger', 3)] })).toEqual(['asha:1on']);
  });

  it('leaves out anyone the reader blocked or who blocked the reader, but never the reader themself', () => {
    expect(show({ members: party, rows: [row('asha', 1), row('ravi', 2)], blocked: ['ravi'] })).toEqual(['asha:1on']);
    expect(show({ members: party, rows: [row('asha', 1), row('ravi', 2)], blocked: ['asha'] })).toEqual([
      'asha:1on',
      'ravi:2on',
    ]);
  });

  it('says nothing about why a member is missing', () => {
    const hidden = show({ members: [member('asha'), member('ravi', { placeHidden: true })], rows: [row('ravi', 2)] });
    const never = show({ members: [member('asha'), member('ravi')], rows: [] });
    const left = show({ members: [member('asha'), member('ravi', { left: true })], rows: [row('ravi', 2)] });
    expect(hidden).toEqual(never);
    expect(left).toEqual(never);
  });
});
