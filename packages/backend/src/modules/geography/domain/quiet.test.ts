import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { activityChanges, nextQuietAt } from './quiet.js';
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
    expect(Date.parse(nextQuietAt(f)!)).toBe(NOW - 10 * DAY + QUIET_AFTER_MS + 1);
    // At that moment the place is quiet, one millisecond earlier it is not.
    const at = (ms: number) => ({ ...f, evaluatedAt: new Date(ms).toISOString() });
    const due = Date.parse(nextQuietAt(f)!);
    expect(activityChanges(at(due - 1))).toEqual([]);
    expect(activityChanges(at(due))).toHaveLength(1);
  });

  it('takes the earliest of several places, and says now while a change is already due', () => {
    const supports = [
      support('a', daysAgo(5)),
      support('b', daysAgo(6)),
      support('c', daysAgo(20), 'space.stars', 'space.stars.fusion'),
      support('d', daysAgo(21), 'space.stars', 'space.stars.fusion'),
    ];
    const f = facts(supports, [placed(earthSystem, 'active'), placed(spaceSystem, 'active')]);
    expect(Date.parse(nextQuietAt(f)!)).toBe(NOW - 20 * DAY + QUIET_AFTER_MS + 1);
    const pending = facts([support('a', daysAgo(40)), support('b', daysAgo(41))], [placed(earthSystem, 'active')]);
    expect(nextQuietAt(pending)).toBe(pending.evaluatedAt);
  });

  it('says nothing when no place can go quiet', () => {
    expect(nextQuietAt(facts([], []))).toBeUndefined();
    expect(nextQuietAt(facts([], [placed(earthSystem, 'active')]))).toBeUndefined();
    const settled = facts([support('a', daysAgo(40)), support('b', daysAgo(41))], [placed(earthSystem, 'quiet')]);
    expect(nextQuietAt(settled)).toBeUndefined();
  });
});
