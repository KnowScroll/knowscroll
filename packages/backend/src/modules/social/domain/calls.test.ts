import { describe, expect, it } from 'vitest';
import {
  addDays,
  COMMON_GUESS_MIN_CALLS,
  commonGuess,
  REVEAL_AFTER_DAYS,
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

describe('the common guess', () => {
  it('is nothing below the threshold, whatever the split', () => {
    expect(commonGuess([COMMON_GUESS_MIN_CALLS - 1, 0, 0])).toBeUndefined();
    expect(commonGuess([0, 0])).toBeUndefined();
  });

  it('is the leading option and its whole-percent share once there are enough calls', () => {
    expect(commonGuess([COMMON_GUESS_MIN_CALLS, 0])).toEqual({ option: 0, percent: 100 });
    expect(commonGuess([5, 20, 5])).toEqual({ option: 1, percent: 67 });
  });

  it('is nothing when two options lead together', () => {
    expect(commonGuess([15, 15, 0])).toBeUndefined();
  });

  it('carries only an option and a percent: no count, no person', () => {
    expect(Object.keys(commonGuess([5, 20, 5])!).sort()).toEqual(['option', 'percent']);
  });
});
