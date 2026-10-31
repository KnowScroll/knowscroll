import { describe, expect, it } from 'vitest';
import type { ThreadPlace } from '@knowscroll/contracts';
import { allFinished, facesByPart, joinNames, partyLine, placeDay, placeWords } from './party-lines';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const place = (name: string, part: number, state: 'on' | 'finished', you = false): ThreadPlace => ({
  person: person(10 + name.length, name),
  you,
  part,
  state,
  day: '2026-10-24',
});

describe('the words of a place', () => {
  it('says on a part, or finished it, and never watching', () => {
    expect(placeWords({ part: 2, state: 'on' }, 3)).toBe('On Part 2');
    expect(placeWords({ part: 1, state: 'finished' }, 3)).toBe('Finished Part 1');
    expect(placeWords({ part: 3, state: 'finished' }, 3)).toBe('Finished all 3 parts');
    for (const part of [1, 2, 3])
      for (const state of ['on', 'finished'] as const) expect(placeWords({ part, state }, 3)).not.toMatch(/watch/i);
  });

  it('dates a place by its day alone, the same in every time zone, with no relative word', () => {
    const now = new Date('2026-10-31T23:30:00Z');
    expect(placeDay('2026-10-24', now, 'en-GB')).toBe('Sat 24 Oct');
    expect(placeDay('2026-10-31', now, 'en-GB')).toBe('Sat 31 Oct');
    expect(placeDay('2025-12-31', now, 'en-GB')).toBe('Wed 31 Dec 2025');
    expect(placeDay('2026-10-24', now, 'en-GB')).not.toMatch(/\d:\d|today|yesterday/i);
  });

  it('joins names the way a sentence does', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Ravi'])).toBe('Ravi');
    expect(joinNames(['Asha', 'Kenji'])).toBe('Asha and Kenji');
    expect(joinNames(['Asha', 'Kenji', 'Meera'])).toBe('Asha, Kenji and Meera');
  });
});

describe('the line under the header', () => {
  it('says where the others are, furthest first, as T3 draws it', () => {
    expect(
      partyLine(
        [place('Asha', 1, 'on'), place('Ravi', 2, 'on'), place('Kenji', 1, 'on'), place('Me', 1, 'on', true)],
        3,
      ),
    ).toBe('Ravi is on Part 2 · Asha and Kenji on Part 1');
    expect(partyLine([place('Ravi', 2, 'on')], 3)).toBe('Ravi is on Part 2');
    expect(partyLine([place('Ravi', 2, 'on'), place('Kenji', 2, 'on')], 3)).toBe('Kenji and Ravi are on Part 2');
  });

  it('says who finished a part, and "All finished" when everyone who shares finished the last one', () => {
    expect(partyLine([place('Ravi', 2, 'finished'), place('Asha', 1, 'on')], 3)).toBe(
      'Ravi finished Part 2 · Asha on Part 1',
    );
    expect(partyLine([place('Ravi', 3, 'finished'), place('Asha', 3, 'finished')], 3)).toBe('All finished');
    expect(partyLine([place('Ravi', 3, 'finished'), place('Me', 3, 'finished', true)], 3)).toBe('All finished');
    expect(partyLine([place('Ravi', 3, 'finished'), place('Asha', 2, 'finished')], 3)).toBe(
      'Ravi finished all 3 parts · Asha finished Part 2',
    );
  });

  it('says nothing when nobody else shows a place, and nothing is claimed about one person alone', () => {
    expect(partyLine([], 3)).toBeUndefined();
    expect(partyLine([place('Me', 2, 'on', true)], 3)).toBeUndefined();
    expect(allFinished([place('Ravi', 3, 'finished')], 3)).toBe(false);
  });

  it('never says watching, a time of day or a playhead', () => {
    const lines = [
      partyLine([place('Ravi', 2, 'on'), place('Asha', 1, 'finished')], 3),
      partyLine([place('Ravi', 3, 'finished'), place('Asha', 3, 'finished')], 3),
    ];
    for (const line of lines) expect(line).not.toMatch(/watch|\d{1,2}:\d{2}|playing/i);
  });
});

describe('faces on the parts', () => {
  it('groups the places by part', () => {
    const faces = facesByPart([place('Asha', 1, 'on'), place('Ravi', 2, 'on'), place('Kenji', 1, 'finished')]);
    expect(faces.get(1)?.map((entry) => entry.person.displayName)).toEqual(['Asha', 'Kenji']);
    expect(faces.get(2)?.map((entry) => entry.person.displayName)).toEqual(['Ravi']);
    expect(faces.get(3)).toBeUndefined();
  });
});
