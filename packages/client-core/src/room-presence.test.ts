import { describe, expect, it } from 'vitest';
import type { RoomHere } from '@knowscroll/contracts';
import { QUIET_AFTER_MS, agoWords, hereView, quietPill } from './room-presence';

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const face = (n: number, name: string, you = false) => ({
  person: { kind: 'person' as const, personId: id(n), handle: `ci.${name.toLowerCase()}`, displayName: name },
  you,
});

describe('who is here, in words', () => {
  it('names two people and says no number', () => {
    const view = hereView({ faces: [face(1, 'Ravi Kumar', true), face(2, 'Asha')] });
    expect(view.countLabel).toBeUndefined();
    expect(view.caption).toBe('You and Asha are here');
    expect(view.faces.map((entry) => entry.initials)).toEqual(['RK', 'A']);
  });

  it('says nothing when only the reader is here, and never a count of one or none', () => {
    for (const faces of [[], [face(1, 'Ravi', true)]]) {
      const view = hereView({ faces });
      expect(view.caption).toBeUndefined();
      expect(view.countLabel).toBeUndefined();
    }
  });

  it('says the number from three and no names', () => {
    const view = hereView({ faces: [face(1, 'Ravi', true), face(2, 'Asha'), face(3, 'Kenji')], count: 4 });
    expect(view.countLabel).toBe('4 here');
    expect(view.caption).toBe('4 here');
  });

  it('can never be made to render "0 online" or "1 online", whatever it is handed', () => {
    const everything: RoomHere[] = [
      { faces: [] },
      { faces: [face(1, 'A', true)] },
      // A count below the threshold is not a valid answer; if one arrived it still would not be shown.
      { faces: [face(1, 'A', true)], count: 1 },
      { faces: [], count: 0 },
      { faces: [face(1, 'A', true), face(2, 'B')], count: 2 },
    ];
    for (const here of everything) {
      const view = hereView(here);
      const words = JSON.stringify(view);
      expect(words).not.toMatch(/\b[01] (online|here)\b/i);
      expect(words).not.toMatch(/online/i);
      expect(view.countLabel).toBeUndefined();
    }
  });
});

describe('the honest quiet pill', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('says nothing while the room is talking', () => {
    expect(quietPill(ago(60_000), now)).toBeUndefined();
    expect(quietPill(ago(QUIET_AFTER_MS - 1), now)).toBeUndefined();
  });

  it('says when the last message was, once it has been quiet for a while', () => {
    expect(quietPill(ago(QUIET_AFTER_MS), now)).toBe('Quiet right now · last person wrote 10 min ago');
    expect(quietPill(ago(3 * 3_600_000), now)).toBe('Quiet right now · last person wrote 3 h ago');
    expect(quietPill(ago(3 * 86_400_000), now)).toBe('Quiet right now · last person wrote 3 d ago');
    expect(quietPill(ago(60 * 3_600_000), now)).toBe('Quiet right now · last person wrote 2 d ago');
  });

  it('says so when nothing has ever been said, and never invents a time', () => {
    expect(quietPill(undefined, now)).toBe('Quiet right now · no one has written yet');
  });

  it('does not call a room quiet because the device clock runs behind', () => {
    expect(quietPill(new Date(now.getTime() + 5 * 60_000).toISOString(), now)).toBeUndefined();
  });

  it('words ages in the few units a pill has room for', () => {
    expect(agoWords(0)).toBe('1 min ago');
    expect(agoWords(59 * 60_000)).toBe('59 min ago');
    expect(agoWords(60 * 60_000)).toBe('1 h ago');
    expect(agoWords(47 * 3_600_000)).toBe('47 h ago');
    expect(agoWords(48 * 3_600_000)).toBe('2 d ago');
  });
});
