import { describe, expect, it } from 'vitest';
import {
  addDays,
  REVEAL_AFTER_DAYS,
  revealedForThread,
  threadCallOf,
  viewCall,
  type CallInput,
  type CallLockRow,
} from './calls.js';
import type { PlaceMember, PlaceRow } from './places.js';

interface Member extends PlaceMember {
  readonly name: string;
}

const member = (accountId: string, patch: Partial<Member> = {}): Member => ({
  accountId,
  name: accountId,
  placeHidden: false,
  pending: false,
  left: false,
  stands: true,
  ...patch,
});
const place = (accountId: string, part: number, state: 'on' | 'finished'): PlaceRow => ({
  accountId,
  part,
  state,
  day: '2026-10-30',
});
const lock = (accountId: string, option: number, day = '2026-10-30'): CallLockRow => ({ accountId, option, day });

/** Asha reads; Ravi, Kenji and Meera are the others. The call is the one before Part 2, and the right answer is 0. */
const base = (patch: Partial<CallInput<Member>> = {}): CallInput<Member> => ({
  readerAccountId: 'asha',
  part: 2,
  answer: 0,
  members: [member('asha'), member('ravi'), member('kenji'), member('meera')],
  locks: [],
  places: [],
  blockedWithReader: new Set(),
  today: '2026-10-30',
  latched: false,
  nameOf: (candidate) => candidate.name,
  ...patch,
});

describe('days', () => {
  it('adds calendar days across months and years', () => {
    expect(addDays('2026-10-30', 2)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('the call a part offers', () => {
  it('is the first Call it, never the Final call', () => {
    const calls = [
      { kind: 'final_call' as const, id: 'final' },
      { kind: 'call_it' as const, id: 'one' },
      { kind: 'call_it' as const, id: 'two' },
    ];
    expect(threadCallOf(calls)?.id).toBe('one');
    expect(threadCallOf([{ kind: 'final_call' as const }])).toBeUndefined();
    expect(threadCallOf([])).toBeUndefined();
  });
});

describe('what a reader sees of a call', () => {
  it('is open with counts only before they lock, and counts the members who take part', () => {
    const view = viewCall(
      base({ locks: [lock('ravi', 1)], members: [...base().members, member('left', { left: true })] }),
    );
    expect(view).toEqual({ stage: 'open', of: 4, called: 1 });
  });

  it('hides everyone’s pick, the right answer and who called, from a reader who has locked, until the reveal', () => {
    const view = viewCall(
      base({
        locks: [lock('asha', 2), lock('ravi', 0)],
        places: [place('asha', 1, 'finished'), place('ravi', 1, 'on')],
      }),
    );
    expect(view).toEqual({ stage: 'locked', option: 2, of: 4, called: 2 });
    expect(JSON.stringify(view)).not.toContain('ravi');
  });

  it('never reveals to a reader who has not locked, even when everyone finished', () => {
    const view = viewCall(
      base({
        locks: [lock('ravi', 0)],
        places: [place('asha', 2, 'finished'), place('ravi', 2, 'finished')],
      }),
    );
    expect(view).toEqual({ stage: 'closed', reason: 'revealed', of: 4, called: 1 });
    expect(JSON.stringify(view)).not.toContain('ravi');
  });

  describe('the reveal', () => {
    it('waits for every member who shares where they are to finish the part', () => {
      const locks = [lock('asha', 0), lock('ravi', 1)];
      const places = (kenji: PlaceRow) => [place('asha', 2, 'finished'), place('ravi', 2, 'finished'), kenji];
      expect(viewCall(base({ locks, places: places(place('kenji', 2, 'on')) })).stage).toBe('locked');
      expect(viewCall(base({ locks, places: places(place('kenji', 1, 'finished')) })).stage).toBe('locked');
      const revealed = viewCall(base({ locks, places: places(place('kenji', 2, 'finished')) }));
      expect(revealed.stage).toBe('revealed');
      // A member further along has finished the part too.
      expect(viewCall(base({ locks, places: places(place('kenji', 3, 'on')) })).stage).toBe('revealed');
    });

    it('waits for the reader too, when they share', () => {
      const places = [place('asha', 2, 'on'), place('ravi', 2, 'finished')];
      expect(viewCall(base({ locks: [lock('asha', 0)], places })).stage).toBe('locked');
    });

    it('does not wait for a member who hides, never set a place, left or was removed', () => {
      const locks = [lock('asha', 0)];
      const finished = [place('asha', 2, 'finished')];
      // Meera shows nothing: hiding deletes her place, and a member who never reported has none.
      expect(viewCall(base({ locks, places: finished })).stage).toBe('revealed');
      const gone = [
        member('asha'),
        member('ravi', { left: true }),
        member('kenji', { stands: false }),
        member('meera'),
      ];
      expect(
        viewCall(base({ locks, members: gone, places: [...finished, place('ravi', 1, 'on'), place('kenji', 1, 'on')] }))
          .stage,
      ).toBe('revealed');
      const hiding = [member('asha'), member('ravi', { placeHidden: true }), member('kenji'), member('meera')];
      expect(viewCall(base({ locks, members: hiding, places: [...finished, place('ravi', 1, 'on')] })).stage).toBe(
        'revealed',
      );
    });

    it('waits for no one when nobody shares a place, and then only the clock opens it', () => {
      const locks = [lock('asha', 0)];
      expect(viewCall(base({ locks, places: [] })).stage).toBe('locked');
      expect(viewCall(base({ locks, places: [], today: addDays('2026-10-30', REVEAL_AFTER_DAYS - 1) })).stage).toBe(
        'locked',
      );
      expect(viewCall(base({ locks, places: [], today: addDays('2026-10-30', REVEAL_AFTER_DAYS) })).stage).toBe(
        'revealed',
      );
    });

    it('opens by itself once the clock runs out, so a member who never finishes cannot hold the others', () => {
      const locks = [lock('asha', 0), lock('ravi', 1, '2026-10-31')];
      const places = [place('asha', 2, 'finished'), place('kenji', 1, 'on')];
      const input = base({ locks, places });
      expect(viewCall({ ...input, today: '2026-10-31' }).stage).toBe('locked');
      // Counted from the first lock, not the last.
      expect(viewCall({ ...input, today: '2026-11-01' }).stage).toBe('revealed');
    });

    it('never waits for a pick: a member who does not call does not hold it back', () => {
      const locks = [lock('asha', 0)];
      const places = [place('asha', 2, 'finished'), place('ravi', 2, 'finished'), place('kenji', 2, 'finished')];
      expect(viewCall(base({ locks, places })).stage).toBe('revealed');
    });

    it('has nothing to reveal until someone has locked', () => {
      const places = [place('asha', 1, 'on'), place('ravi', 2, 'finished')];
      expect(viewCall(base({ locks: [], places, today: '2027-01-01' })).stage).toBe('open');
    });

    it('shows every pick the reader may see, by option and then by name, with who was right', () => {
      const view = viewCall(
        base({
          locks: [lock('asha', 0), lock('kenji', 1), lock('ravi', 0), lock('meera', 2)],
          places: [place('asha', 2, 'finished')],
        }),
      );
      if (view.stage !== 'revealed') throw new Error('expected a reveal');
      expect(view.picks.map((pick) => [pick.member.accountId, pick.option, pick.right])).toEqual([
        ['asha', 0, true],
        ['ravi', 0, true],
        ['kenji', 1, false],
        ['meera', 2, false],
      ]);
      expect(view).toMatchObject({ rightCount: 2, option: 0, called: 4, of: 4 });
    });
  });

  describe('a block, in either direction', () => {
    it('hides the blocked member’s pick, place and count from the reader, and their progress does not hold the reveal', () => {
      const input = base({
        locks: [lock('asha', 0), lock('ravi', 1)],
        places: [place('asha', 2, 'finished'), place('ravi', 1, 'on')],
        blockedWithReader: new Set(['ravi']),
      });
      const view = viewCall(input);
      if (view.stage !== 'revealed') throw new Error('expected a reveal');
      expect(view.picks.map((pick) => pick.member.accountId)).toEqual(['asha']);
      expect(view).toMatchObject({ called: 1, of: 3 });
      // Without the block the same thread is still waiting for Ravi.
      expect(viewCall({ ...input, blockedWithReader: new Set() }).stage).toBe('locked');
    });
  });

  describe('closing', () => {
    it('closes for a reader who shares that they are on the part, or past it, and has not locked', () => {
      expect(viewCall(base({ places: [place('asha', 2, 'on')] }))).toMatchObject({
        stage: 'closed',
        reason: 'started',
      });
      expect(viewCall(base({ places: [place('asha', 3, 'on')] }))).toMatchObject({
        stage: 'closed',
        reason: 'started',
      });
      expect(viewCall(base({ places: [place('asha', 1, 'finished')] })).stage).toBe('open');
      expect(viewCall(base({ places: [place('asha', 1, 'on')] })).stage).toBe('open');
    });

    it('does not close a reader who locked before they started, and who waits for the others', () => {
      const places = [place('asha', 2, 'on'), place('ravi', 1, 'on')];
      expect(viewCall(base({ locks: [lock('asha', 0)], places })).stage).toBe('locked');
    });
  });
});

describe('a reveal that has happened stays', () => {
  /** Asha and Ravi called on the 30th; nobody shares a place, so the clock opens it on the 1st. */
  const timed = (patch: Partial<CallInput<Member>> = {}) =>
    base({ locks: [lock('asha', 0, '2026-10-31'), lock('ravi', 1, '2026-10-30')], today: '2026-11-01', ...patch });

  it('is revealed by the clock only while the earliest lock stands', () => {
    expect(viewCall(timed()).stage).toBe('revealed');
    // The earliest locker leaves or clears: the clock now counts from Asha's lock, and it has not run out.
    expect(viewCall(timed({ locks: [lock('asha', 0, '2026-10-31')] })).stage).toBe('locked');
  });

  it('stays revealed once it is on record, whoever leaves or clears afterwards', () => {
    const left = timed({ locks: [lock('asha', 0, '2026-10-31')], latched: true });
    expect(viewCall(left)).toMatchObject({ stage: 'revealed', option: 0, called: 1 });
  });

  it('stays revealed when someone who shares a place and has not finished the part joins later', () => {
    const finished = [place('asha', 2, 'finished'), place('ravi', 2, 'finished')];
    const joined = [...base().members, member('newcomer')];
    const places = [...finished, place('newcomer', 1, 'on')];
    const input = base({ locks: [lock('asha', 0)], members: joined, places });
    expect(viewCall(input).stage).toBe('locked');
    expect(viewCall({ ...input, latched: true }).stage).toBe('revealed');
  });

  it('closes the call for someone who never locked, for good', () => {
    const closed = viewCall(base({ locks: [lock('ravi', 0)], latched: true }));
    expect(closed).toMatchObject({ stage: 'closed', reason: 'revealed' });
    expect(JSON.stringify(closed)).not.toContain('ravi');
  });
});

describe('a block keeps the reader on the live rule', () => {
  /** Ravi called on the 29th and finished Part 2. Kenji, who blocked him, has not called; the latch is on record. */
  const blocked = (patch: Partial<CallInput<Member>> = {}) =>
    base({
      readerAccountId: 'kenji',
      locks: [lock('ravi', 1, '2026-10-29')],
      places: [place('ravi', 2, 'finished'), place('asha', 2, 'finished')],
      blockedWithReader: new Set(['ravi']),
      latched: true,
      today: '2026-10-31',
      ...patch,
    });

  it('does not let the blocked member’s lock or finish close or open anything for the blocker', () => {
    // Honouring the latch would turn Kenji's open card into closed, and he could no longer call.
    expect(viewCall(blocked())).toMatchObject({ stage: 'open', called: 0, of: 3 });
    expect(viewCall(blocked({ latched: false }))).toEqual(viewCall(blocked({ latched: true })));
  });

  it('does not reveal to the blocker on the blocked member’s earlier lock', () => {
    // Asha blocks Ravi; Ravi called on the 29th, Asha on the 30th. Ravi's day would open the clock on the 31st.
    const asha = base({
      readerAccountId: 'asha',
      locks: [lock('ravi', 1, '2026-10-29'), lock('asha', 0, '2026-10-30')],
      blockedWithReader: new Set(['ravi']),
      today: '2026-10-31',
    });
    expect(viewCall({ ...asha, latched: true })).toMatchObject({ stage: 'locked', called: 1, of: 3 });
    expect(viewCall({ ...asha, latched: false })).toMatchObject({ stage: 'locked' });
  });

  it('is the same for a block in either direction, and honours the latch for a reader no block touches', () => {
    expect(viewCall(blocked({ readerAccountId: 'meera', blockedWithReader: new Set() })).stage).toBe('closed');
    // A block with someone who has left touches nobody who takes part.
    const gone = [member('asha'), member('ravi', { left: true }), member('kenji'), member('meera')];
    expect(viewCall(blocked({ members: gone })).stage).toBe('closed');
  });
});

describe('when the whole thread has revealed', () => {
  const thread = (patch: Partial<Parameters<typeof revealedForThread<Member>>[0]> = {}) => ({
    part: 2,
    members: base().members,
    locks: [lock('asha', 0)],
    places: [place('asha', 2, 'finished'), place('ravi', 2, 'finished')],
    today: '2026-10-30',
    ...patch,
  });

  it('is the same rule with nobody masked: it waits for every member who takes part and shares', () => {
    expect(revealedForThread(thread())).toBe(true);
    expect(revealedForThread(thread({ places: [place('asha', 2, 'finished'), place('ravi', 1, 'on')] }))).toBe(false);
  });

  it('reads no block: a member only the blocker cannot see still holds the thread', () => {
    const places = [place('asha', 2, 'finished'), place('ravi', 1, 'on')];
    expect(revealedForThread(thread({ places }))).toBe(false);
    // The blocker's own view does not wait for Ravi, but that is not what is recorded for the thread.
    expect(viewCall(base({ locks: [lock('asha', 0)], places, blockedWithReader: new Set(['ravi']) })).stage).toBe(
      'revealed',
    );
  });

  it('does not count a member who hides, left, or never reports, and opens by the clock when nobody shares', () => {
    const left = [member('asha'), member('ravi', { left: true })];
    expect(
      revealedForThread(thread({ members: left, places: [place('asha', 2, 'finished'), place('ravi', 1, 'on')] })),
    ).toBe(true);
    expect(revealedForThread(thread({ places: [] }))).toBe(false);
    expect(revealedForThread(thread({ places: [], today: addDays('2026-10-30', REVEAL_AFTER_DAYS) }))).toBe(true);
  });

  it('has nothing to record until someone has locked, and counts only locks of members who take part', () => {
    expect(revealedForThread(thread({ locks: [] }))).toBe(false);
    expect(revealedForThread(thread({ locks: [lock('gone', 0)] }))).toBe(false);
  });
});
