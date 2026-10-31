import type { ThreadPlace } from '@knowscroll/contracts';
import { placeProgress } from './thread-places';

/**
 * The words a thread's party is described in (T3 "who is on which part", D-065). A place is a part, `on`
 * or `finished`, and a calendar day, so no line here says "watching", names a time of day, or is finer
 * than a day.
 */

/** What a finished place finished: "Part 1", or "all 3 parts" once it is the last. */
const finishedWhat = (place: Pick<ThreadPlace, 'part'>, total: number): string =>
  place.part === total && total > 1 ? `all ${String(total)} parts` : `Part ${String(place.part)}`;

/** "On Part 2", "Finished Part 1", and "Finished all 3 parts" once the last part is finished. */
export function placeWords(place: Pick<ThreadPlace, 'part' | 'state'>, total: number): string {
  return place.state === 'on' ? `On Part ${String(place.part)}` : `Finished ${finishedWhat(place, total)}`;
}

/**
 * The day of a place, as a date: "Sat 24 Oct", with the year once it is not this year. The server stamps
 * the day in UTC and it is shown as that date, never converted into a time, so it reads the same on every
 * device. There is no relative word ("today"): a date near midnight could be wrong by a day in another
 * time zone.
 */
export function placeDay(day: string, now: Date, locale?: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, date));
  const weekday = at.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
  const monthName = at.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' });
  const label = `${weekday} ${String(date)} ${monthName}`;
  return year === now.getUTCFullYear() ? label : `${label} ${String(year)}`;
}

/** "Ravi", "Asha and Kenji", "Asha, Kenji and Meera". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** Everyone who shares has finished the last part, and there are at least two of them. */
export function allFinished(places: readonly ThreadPlace[], total: number): boolean {
  return places.length >= 2 && places.every((place) => place.state === 'finished' && place.part === total);
}

/**
 * The one line under the header: "Ravi is on Part 2 · Asha and Kenji on Part 1", or "All finished". It
 * speaks only of the others who share and never of the reader (their own place is in the member list),
 * and says nothing when nobody else shows a place. Furthest along comes first.
 */
export function partyLine(places: readonly ThreadPlace[], total: number): string | undefined {
  if (allFinished(places, total)) return 'All finished';
  const others = places.filter((place) => !place.you);
  if (others.length === 0) return undefined;
  const groups = new Map<string, { place: ThreadPlace; names: string[] }>();
  for (const place of others) {
    const key = `${String(place.part)}:${place.state}`;
    const group = groups.get(key) ?? { place, names: [] };
    group.names.push(place.person.displayName);
    groups.set(key, group);
  }
  return [...groups.values()]
    .toSorted((left, right) => placeProgress(right.place) - placeProgress(left.place))
    .map(({ place, names }, index) => {
      const who = joinNames(names.toSorted());
      if (place.state === 'finished') return `${who} finished ${finishedWhat(place, total)}`;
      const verb = index === 0 ? `${names.length > 1 ? 'are' : 'is'} ` : '';
      return `${who} ${verb}on Part ${String(place.part)}`;
    })
    .join(' · ');
}

/** The faces on each part: who is on it, or has finished it, by part number. */
export function facesByPart(places: readonly ThreadPlace[]): ReadonlyMap<number, readonly ThreadPlace[]> {
  const byPart = new Map<number, ThreadPlace[]>();
  for (const place of places) byPart.set(place.part, [...(byPart.get(place.part) ?? []), place]);
  return byPart;
}
