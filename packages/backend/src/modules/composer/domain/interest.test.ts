import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { COMPOSER_POLICY_V3 } from './policy.js';
import {
  durationBucketOf,
  hierarchicalFormatFit,
  shrunkInterest,
  type FormatCounts,
  type FormatModel,
  type InterestModel,
} from './interest.js';

/** Policy v3's interest and format arithmetic (D-420): labelled fixtures, no product data. */
const INTEREST = COMPOSER_POLICY_V3.interestModel as InterestModel;
const FORMAT = COMPOSER_POLICY_V3.formatModel as FormatModel;
const NOTHING = { topicActivity: 0, systemRestActivity: 0, personActivity: 0 };

describe('interest with shrinkage toward the system and the person (v3)', () => {
  it('is the neutral base for a topic nothing is known about, as v0 to v2 call an unknown topic', () => {
    expect(shrunkInterest(INTEREST, NOTHING)).toBe(INTEREST.base);
    expect(INTEREST.base).toBe(0.5);
  });

  it('scores a topic met once above one never met, where v0 to v2 scored it below', () => {
    // One fully read Scroll is an activity of about 0.6. Old: 0.6 / 1.6 = 0.375, below the unknown 0.5.
    const once = shrunkInterest(INTEREST, { ...NOTHING, topicActivity: 0.6 });
    expect(0.6 / (1 + 0.6)).toBeLessThan(0.5);
    expect(once).toBeGreaterThan(shrunkInterest(INTEREST, NOTHING));
  });

  it('scores a never-met topic of a loved system above an unknown one', () => {
    const loved = shrunkInterest(INTEREST, { ...NOTHING, systemRestActivity: 6 });
    expect(loved).toBeGreaterThan(shrunkInterest(INTEREST, NOTHING));
    // The topic's own evidence adds to what its system gives.
    expect(shrunkInterest(INTEREST, { topicActivity: 1, systemRestActivity: 6, personActivity: 0 })).toBeGreaterThan(
      loved,
    );
  });

  it('lets an old interest decay toward its prior and never below an unknown topic', () => {
    const prior = { systemRestActivity: 6, personActivity: 12 };
    let previous = shrunkInterest(INTEREST, { topicActivity: 3, ...prior });
    for (const topicActivity of [1.5, 0.75, 0.3, 0.05, 0.001, 0]) {
      const value = shrunkInterest(INTEREST, { topicActivity, ...prior });
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(shrunkInterest(INTEREST, NOTHING));
      previous = value;
    }
    // At nothing left the topic is exactly its system's prior for a topic never met.
    expect(previous).toBe(shrunkInterest(INTEREST, { topicActivity: 0, ...prior }));
  });

  it('weighs a heavy reader’s overall level in the prior without letting it make every unknown topic loved', () => {
    const heavy = shrunkInterest(INTEREST, { ...NOTHING, personActivity: 1000 });
    expect(heavy).toBeGreaterThan(INTEREST.base);
    expect(heavy).toBeLessThanOrEqual(INTEREST.base + (1 - INTEREST.base) * INTEREST.personWeight + 1e-12);
    // A topic the heavy reader has actually read still stands clear of one they have not.
    expect(shrunkInterest(INTEREST, { topicActivity: 3, systemRestActivity: 0, personActivity: 1000 })).toBeGreaterThan(
      heavy + 0.2,
    );
  });

  test.prop([
    fc.double({ min: 0, max: 100, noNaN: true }),
    fc.double({ min: 0, max: 100, noNaN: true }),
    fc.double({ min: 0, max: 1000, noNaN: true }),
    fc.double({ min: 0, max: 50, noNaN: true }),
  ])('is in [base, 1] and never falls as any activity grows', (topic, system, person, more) => {
    const value = shrunkInterest(INTEREST, {
      topicActivity: topic,
      systemRestActivity: system,
      personActivity: person,
    });
    expect(value).toBeGreaterThanOrEqual(INTEREST.base);
    expect(value).toBeLessThanOrEqual(1);
    for (const grown of [
      { topicActivity: topic + more, systemRestActivity: system, personActivity: person },
      { topicActivity: topic, systemRestActivity: system + more, personActivity: person },
      { topicActivity: topic, systemRestActivity: system, personActivity: person + more },
    ])
      expect(shrunkInterest(INTEREST, grown)).toBeGreaterThanOrEqual(value - 1e-12);
  });
});

describe('the duration bucket of a candidate', () => {
  it('is short for every Reel (20 to 60 seconds), and for a Scroll by its reading minutes', () => {
    expect(durationBucketOf({ kind: 'reel' }, FORMAT)).toBe('short');
    expect(durationBucketOf({ kind: 'reel', traits: { readingMinutes: 12 } }, FORMAT)).toBe('short');
    expect(durationBucketOf({ kind: 'scroll', traits: { readingMinutes: 2.9 } }, FORMAT)).toBe('short');
    expect(durationBucketOf({ kind: 'scroll', traits: { readingMinutes: 3 } }, FORMAT)).toBe('medium');
    expect(durationBucketOf({ kind: 'scroll', traits: { readingMinutes: 7.9 } }, FORMAT)).toBe('medium');
    expect(durationBucketOf({ kind: 'scroll', traits: { readingMinutes: 8 } }, FORMAT)).toBe('long');
  });

  it('is medium for a Scroll that states no reading time', () => {
    expect(durationBucketOf({ kind: 'scroll' }, FORMAT)).toBe('medium');
    expect(durationBucketOf({ kind: 'scroll', traits: {} }, FORMAT)).toBe('medium');
  });

  it('has a flat default prior, so neither format is preferred at a cold start whatever the durations', () => {
    expect(FORMAT.prior).toEqual({ short: 0.5, medium: 0.5, long: 0.5 });
    const reel = FORMAT.prior[durationBucketOf({ kind: 'reel' }, FORMAT)];
    for (const readingMinutes of [0.5, 2.9, 3, 7.9, 8, 40])
      expect(FORMAT.prior[durationBucketOf({ kind: 'scroll', traits: { readingMinutes } }, FORMAT)]).toBe(reel);
  });
});

const counts = (qualified: number, measured: number): FormatCounts => ({ measured, qualified });
const PRIOR = 0.5;

describe('format fit by hierarchical shrinkage: topic, system, person, then a duration prior (v3)', () => {
  it('is the duration prior when nothing is known', () => {
    expect(hierarchicalFormatFit(FORMAT, {}, PRIOR)).toBe(PRIOR);
    expect(hierarchicalFormatFit(FORMAT, {}, 0.45)).toBe(0.45);
    expect(
      hierarchicalFormatFit(FORMAT, { person: counts(0, 0), system: counts(0, 0), topic: counts(0, 0) }, 0.55),
    ).toBe(0.55);
  });

  it('lets evidence of a format in a topic’s system inform a topic never read in that format', () => {
    // The person qualified 9 of 10 Reels across the system, never met this topic: its Reel fit leaves the prior.
    const system = hierarchicalFormatFit(FORMAT, { person: counts(9, 10), system: counts(9, 10) }, PRIOR);
    expect(system).toBeGreaterThan(PRIOR + 0.15);
    // The same person qualified 1 of 10 Scrolls there: the Scroll fit goes the other way.
    const scroll = hierarchicalFormatFit(FORMAT, { person: counts(1, 10), system: counts(1, 10) }, PRIOR);
    expect(scroll).toBeLessThan(PRIOR - 0.1);
    // The one pooled estimate v0 had for this topic ((1 + 0) / (2 + 0)) knows nothing of either.
    expect((1 + 0) / (2 + 0)).toBe(0.5);
  });

  it('lets evidence of the person overall inform a system they have no row for, more weakly than the system’s own', () => {
    const personOnly = hierarchicalFormatFit(FORMAT, { person: counts(9, 10) }, PRIOR);
    const system = hierarchicalFormatFit(FORMAT, { person: counts(9, 10), system: counts(9, 10) }, PRIOR);
    expect(personOnly).toBeGreaterThan(PRIOR);
    expect(system).toBeGreaterThanOrEqual(personOnly - 1e-12);
  });

  it('moves toward the topic’s own rate as its own encounters grow, away from the pooled prior', () => {
    const pooled = { person: counts(80, 100), system: counts(40, 50) };
    const few = hierarchicalFormatFit(FORMAT, { ...pooled, topic: counts(0, 2) }, PRIOR);
    const many = hierarchicalFormatFit(FORMAT, { ...pooled, topic: counts(0, 40) }, PRIOR);
    // A topic that is never qualified is read lower the more evidence there is of it.
    expect(many).toBeLessThan(few);
    expect(many).toBeLessThan(0.35);
    // And a play-level cell of the topic that is always qualified lifts the fit above the topic's pooled rate.
    const cell = hierarchicalFormatFit(FORMAT, { ...pooled, topic: counts(5, 40), cell: counts(5, 5) }, PRIOR);
    const noCell = hierarchicalFormatFit(FORMAT, { ...pooled, topic: counts(5, 40) }, PRIOR);
    expect(cell).toBeGreaterThan(noCell);
  });

  it('counts no encounter twice: each level reads the rest of its parent', () => {
    // The system's counts are exactly the topic's: the rest of the system is empty, so the system adds nothing the topic did not.
    const sameAsTopic = hierarchicalFormatFit(
      FORMAT,
      { person: counts(8, 10), system: counts(8, 10), topic: counts(8, 10) },
      PRIOR,
    );
    const topicAlone = hierarchicalFormatFit(FORMAT, { person: counts(8, 10), topic: counts(8, 10) }, PRIOR);
    expect(sameAsTopic).toBeCloseTo(topicAlone, 12);
  });

  it('never goes below zero when a parent is smaller than its child (a process from before the roll-ups)', () => {
    const value = hierarchicalFormatFit(
      FORMAT,
      { person: counts(0, 0), system: counts(0, 1), topic: counts(5, 6), cell: counts(6, 7) },
      PRIOR,
    );
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  test.prop([
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 60 }),
  ])('stays in [0, 1] for any counts', (a, b, c, d, e, f) => {
    const pair = (x: number, y: number) => counts(Math.min(x, y), Math.max(x, y));
    const value = hierarchicalFormatFit(
      FORMAT,
      { person: pair(a, b), system: pair(c, d), topic: pair(e, f), cell: pair(a, f) },
      PRIOR,
    );
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});
