import type { OuterFriend } from '../universe/voyage/outer/friend-order';

/**
 * Sample friends for the developer gallery and for tests: labelled as samples, never people. Product code never reads
 * this file. The first two are the prototype's two friends (Mei and Ravi), so a field of two is the prototype's picture.
 */
const NAMES = [
  'Ravi',
  'Mei',
  'Ana',
  'Tomas',
  'Priya',
  'Jonas',
  'Lucia',
  'Kofi',
  'Hana',
  'Mateo',
  'Sana',
  'Oskar',
  'Nia',
  'Dev',
  'Elin',
  'Yusuf',
  'Iris',
  'Arjun',
  'Zoe',
  'Felix',
] as const;

/** `count` sample friends: unique ids and handles, names from a short list (numbered after the list runs out). */
export function sampleFriends(count: number): readonly OuterFriend[] {
  return Array.from({ length: count }, (_, index) => {
    const name = NAMES[index % NAMES.length]!;
    const round = Math.floor(index / NAMES.length);
    const display = round === 0 ? name : `${name} ${round + 1}`;
    return {
      personId: `sample-person-${index}`,
      handle: `${name.toLowerCase()}${round === 0 ? '' : round + 1}`,
      name: display,
    };
  });
}
