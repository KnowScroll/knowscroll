import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { QUIET_SWEEP, activityChanges, placeSchedules, unreadRetryMs } from './quiet.js';
import { requiredChanges } from './formation.js';
import {
  QUIET_AFTER_MS,
  semanticKey,
  type Candidate,
  type FormationFacts,
  type Place,
  type Support,
} from './policy.js';

/** Authored supports over the real concept catalogue; none of this is a person's reading. */
const catalogue = CONCEPTS.map((topic) => ({
  id: topic.id,
  parent: topic.parent,
  facets: topic.facets.map((facet) => facet.id),
}));
const seasons = 'earth.seasons';
const tilt = `${seasons}.axial-tilt`;
const candidate = (kind: Candidate['kind'], conceptId: string, parentKey: string, n: number): Candidate => ({
  key: semanticKey(kind, conceptId),
  id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind,
  conceptId,
  parentKey,
  truthStatus: 'factual',
  labels: [conceptId],
});
const earthSystem = candidate('system', 'earth', 'universe', 1);
const earthStar = candidate('star', 'earth', earthSystem.key, 2);
const spaceSystem = candidate('system', 'space', 'universe', 3);

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const support = (unit: string, activatedAt: string, topicId = seasons, facetId = tilt): Support => ({
  ref: `${topicId}:${unit}`,
  topicId,
  facetId,
  explanationUnitId: unit,
  truthStatus: 'factual',
  activatedAt,
});
const placed = (c: Candidate, state: 'active' | 'quiet' | undefined): Place => ({
  ...c,
  label: c.labels[0]!,
  objectRevision: 1,
  originTransitionId: '20000000-0000-4000-8000-000000000001',
  activity: state ? { availability: 'available', state } : { availability: 'unavailable' },
});
const facts = (supports: Support[], objects: Place[]): FormationFacts => ({
  catalogue,
  supports,
  candidates: [earthSystem, earthStar, spaceSystem],
  objects,
  routes: [],
  evaluatedAt: new Date(NOW).toISOString(),
  completeness: 'not_asserted',
});

describe('quiet places (authored fixtures only)', () => {
  it('turns a place quiet only once its newest support is more than 30 days old', () => {
    const young = [support('a', daysAgo(29)), support('b', daysAgo(30))];
    expect(activityChanges(facts(young, [placed(earthSystem, 'active')]))).toEqual([]);
    const old = [support('a', daysAgo(31)), support('b', daysAgo(40))];
    expect(activityChanges(facts(old, [placed(earthSystem, 'active')]))).toEqual([
      { kind: 'set_activity', objectId: earthSystem.id, state: 'quiet', supportRefs: old.map((entry) => entry.ref) },
    ]);
  });

  it('wakes a quiet place that has new support, and leaves one with no support as it is', () => {
    const fresh = [support('a', daysAgo(1)), support('b', daysAgo(2))];
    expect(activityChanges(facts(fresh, [placed(earthSystem, 'quiet')]))).toMatchObject([
      { objectId: earthSystem.id, state: 'active' },
    ]);
    expect(activityChanges(facts([], [placed(earthSystem, 'active'), placed(spaceSystem, 'quiet')]))).toEqual([]);
  });

  it('is the activity part of what the rules require', () => {
    const old = [support('a', daysAgo(31)), support('b', daysAgo(40))];
    const f = facts(old, [placed(earthSystem, 'active'), placed(earthStar, 'active')]);
    expect(requiredChanges(f).operations).toEqual(activityChanges(f));
  });

  it('names when the newest support under an active place turns 30 days old', () => {
    const f = facts([support('a', daysAgo(10)), support('b', daysAgo(12))], [placed(earthSystem, 'active')]);
    const [schedule] = placeSchedules(f);
    expect(schedule).toEqual({
      key: earthSystem.key,
      lastSupportAt: daysAgo(10),
      quietCheckAt: new Date(NOW - 10 * DAY + QUIET_AFTER_MS + 1).toISOString(),
    });
    // At that moment the place is quiet, one millisecond earlier it is not.
    const at = (ms: number) => ({ ...f, evaluatedAt: new Date(ms).toISOString() });
    const due = Date.parse(schedule!.quietCheckAt!);
    expect(activityChanges(at(due - 1))).toEqual([]);
    expect(activityChanges(at(due))).toHaveLength(1);
  });

  it('schedules each place by its own support, and says now while a change is already due', () => {
    const supports = [
      support('a', daysAgo(5)),
      support('b', daysAgo(6)),
      support('c', daysAgo(20), 'space.stars', 'space.stars.fusion'),
      support('d', daysAgo(21), 'space.stars', 'space.stars.fusion'),
    ];
    const f = facts(supports, [placed(earthSystem, 'active'), placed(spaceSystem, 'active')]);
    expect(placeSchedules(f).map((schedule) => schedule.quietCheckAt)).toEqual([
      new Date(NOW - 5 * DAY + QUIET_AFTER_MS + 1).toISOString(),
      new Date(NOW - 20 * DAY + QUIET_AFTER_MS + 1).toISOString(),
    ]);
    const pending = facts([support('a', daysAgo(40)), support('b', daysAgo(41))], [placed(earthSystem, 'active')]);
    expect(placeSchedules(pending)[0]!.quietCheckAt).toBe(pending.evaluatedAt);
    // A quiet place with new support is a change due now, too.
    const waking = facts([support('a', daysAgo(1)), support('b', daysAgo(2))], [placed(earthSystem, 'quiet')]);
    expect(placeSchedules(waking)[0]!.quietCheckAt).toBe(waking.evaluatedAt);
  });

  it('says nothing for a place that cannot go quiet: it has no support, or it is quiet already', () => {
    expect(placeSchedules(facts([], []))).toEqual([]);
    expect(placeSchedules(facts([], [placed(earthSystem, 'active')]))).toEqual([
      { key: earthSystem.key, lastSupportAt: null, quietCheckAt: null },
    ]);
    const settled = facts([support('a', daysAgo(40)), support('b', daysAgo(41))], [placed(earthSystem, 'quiet')]);
    expect(placeSchedules(settled)).toEqual([{ key: earthSystem.key, lastSupportAt: daysAgo(40), quietCheckAt: null }]);
  });

  it('carries the newest support a system was last seen with, so reading one topic never ages the system', () => {
    // Only an old topic of the system is read now; the system's own newest support (3 days ago) was seen earlier.
    const old = [support('a', daysAgo(45)), support('b', daysAgo(50))];
    const f = { ...facts(old, [placed(earthSystem, 'active'), placed(earthStar, 'active')]) };
    expect(activityChanges(f)).toHaveLength(2);
    const carried = { ...f, carriedSupportAt: { [earthSystem.key]: daysAgo(3), [earthStar.key]: daysAgo(3) } };
    expect(activityChanges(carried)).toEqual([]);
    expect(placeSchedules(carried).map((schedule) => schedule.lastSupportAt)).toEqual([daysAgo(3), daysAgo(3)]);
    // The carry never lowers what the facts read, and only systems and stars carry.
    const newer = { ...carried, carriedSupportAt: { [earthSystem.key]: daysAgo(60) } };
    expect(placeSchedules(newer)[0]!.lastSupportAt).toBe(daysAgo(45));
  });

  it('keeps the activity of a system whose carried last support is all that remains: nothing was read to cite (PR #723)', () => {
    // A system last supported 40 days ago whose content was withdrawn: nothing is read under it now. The carried time is not a
    // support, so no change is made (a change with no support to cite could never be applied) and nothing is scheduled.
    const carried = {
      ...facts([], [placed(earthSystem, 'active'), placed(earthStar, 'active')]),
      carriedSupportAt: {
        [earthSystem.key]: daysAgo(40),
        [earthStar.key]: daysAgo(40),
      },
    };
    expect(activityChanges(carried)).toEqual([]);
    expect(
      placeSchedules(carried).map((schedule) => [schedule.key, schedule.lastSupportAt, schedule.quietCheckAt]),
    ).toEqual([
      [earthSystem.key, null, null],
      [earthStar.key, null, null],
    ]);
    // With something read under it, the carried time still counts: the newest of the two decides.
    const read = { ...carried, supports: [support('a', daysAgo(2))] };
    expect(activityChanges(read)).toEqual([]);
    const readOld = { ...carried, supports: [support('a', daysAgo(35))] };
    expect(activityChanges(readOld).map((change) => change.state)).toEqual(['quiet', 'quiet']);
  });

  it('backs off a place no settle can read: an hour, doubling to a day, and not at all from the sixth look (PR #723)', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((looks) => unreadRetryMs(looks));
    expect(waits).toEqual([3_600_000, 7_200_000, 14_400_000, 28_800_000, 57_600_000, undefined, undefined]);
    expect(Math.max(...waits.filter((wait): wait is number => wait !== undefined))).toBeLessThanOrEqual(
      QUIET_SWEEP.parkMs,
    );
  });

  it('sizes the sweep for a migration-day backlog: 4.8 million places a day, a place held by a run waits minutes (PR #723)', () => {
    const passesPerDay = 96;
    expect(QUIET_SWEEP.batch * QUIET_SWEEP.pagesPerPass * passesPerDay).toBe(4_800_000);
    expect(QUIET_SWEEP.runHeldMs).toBeLessThanOrEqual(15 * 60_000);
    expect(QUIET_SWEEP.runHeldMs).toBeLessThan(QUIET_SWEEP.parkMs);
  });
});
