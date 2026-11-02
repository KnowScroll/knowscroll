import type { EncounterEntry } from './encounter-history';
import { arrivalToSay, markArrivalSaid, partArrival } from './part-arrival';

type Scroll = Extract<EncounterEntry, { kind: 'scroll' }>;

/** Hand-made entries, enough for the arrival: not product content. */
const entry = (part: number, relation = 'series_step', seriesId = 'ci-series', kind = 'scroll'): Scroll =>
  ({
    kind,
    offer: { relation: { kind: relation } },
    context: { series: { seriesId, seriesRevision: 1, part, total: 3 } },
  }) as unknown as Scroll;

describe('the arrival of a Part opened by a step forward (V3 G2)', () => {
  it('names the Part and the one left, only for a later Part of the same series that is the last in the trail', () => {
    const one = entry(1, 'discovery');
    const two = entry(2);
    expect(partArrival([one, two], two)).toEqual({ part: 'Part 2', from: 'Part 1' });
    expect(partArrival([two, one], one)).toBeUndefined();
    expect(partArrival([one, two, entry(3)], two)).toBeUndefined();
    expect(partArrival([entry(1, 'discovery', 'other'), two], two)).toBeUndefined();
    expect(partArrival([one, entry(2, 'related_move')], entry(2, 'related_move'))).toBeUndefined();
    expect(partArrival([entry(1, 'discovery', 'ci-series', 'reel'), two], two)).toBeUndefined();
  });

  it('is said once: Part 1, 2, 3 then Back to Part 2, or a tab return, does not say it or slide it in again', () => {
    const one = entry(1, 'discovery');
    const two = entry(2);
    const three = entry(3);
    expect(arrivalToSay([one, two], two)).toBeDefined();
    markArrivalSaid(two);
    expect(arrivalToSay([one, two, three], three)).toBeDefined();
    markArrivalSaid(three);
    // Back from Part 3: Part 2 is the last in the trail again, with Part 1 before it.
    expect(arrivalToSay([one, two], two)).toBeUndefined();
    // The same entry drawn again (a remount) says nothing either.
    expect(arrivalToSay([one, two, three], three)).toBeUndefined();
  });
});
