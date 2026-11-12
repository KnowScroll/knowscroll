import { describe, expect, it } from 'vitest';
import type { CurrentPlan } from '../../composer/public.js';
import type { InterestRollup, InterestTopic } from '../../evidence/public.js';
import { makeReadInterestContext } from './read-interest-context.js';

/** Policy v3's view of the person's interest, over Evidence's reads (D-420). Labelled CI fixtures. */
const scope = {} as never;
const NOW = '2026-11-11T12:00:00.000Z';

const topics: readonly InterestTopic[] = [
  { topicId: 'space.stars', activity: 2.5 },
  { topicId: 'earth.tides', activity: 0.4 },
];
const rollup = (level: 'system' | 'person', subjectId: string, activity: number): InterestRollup => ({
  level,
  subjectId,
  activity,
  formats: [
    { kind: 'reel', measured: 4, qualified: 3 },
    { kind: 'scroll', measured: 2, qualified: 1 },
  ],
});

const opportunity = (
  unit: string,
  target: 'existing' | 'missing_supply',
  expiresAt: string,
  eligibility: readonly ('vertical' | 'related')[] = ['vertical'],
) => ({
  move: 'example' as const,
  topicIds: ['space.stars'],
  explanationUnitId: unit,
  eligibility,
  formats: ['scroll' as const],
  expiresAt,
  target,
});

function reader(plan?: CurrentPlan) {
  const calls: unknown[] = [];
  const read = makeReadInterestContext({
    readTop: (_scope, query) => {
      calls.push(['top', query]);
      return Promise.resolve(topics);
    },
    readRollups: (_scope, query) => {
      calls.push(['rollups', query]);
      return Promise.resolve([rollup('person', '', 9), rollup('system', 'space', 5)]);
    },
    ...(plan ? { readCurrentPlan: () => Promise.resolve(plan) } : {}),
  });
  return { read, calls };
}

describe('leads: the person’s top interest topics and the units a valid plan names', () => {
  it('reads the top K topics with the evaluation time, and names no planned unit without a plan', async () => {
    const { read, calls } = reader();
    expect(await read.leads(scope, { evaluatedAt: NOW, topK: 32 })).toEqual({ topics, plannedUnitIds: [] });
    expect(calls).toEqual([['top', { limit: 32, evaluatedAt: NOW }]]);
  });

  it('names only opportunities suited to a vertical move, as plan lifts are: a related-only opportunity is not for this read', async () => {
    const plan: CurrentPlan = {
      revision: 4,
      opportunities: [
        opportunity('unit-vertical', 'existing', '2026-11-12T00:00:00.000Z', ['vertical']),
        opportunity('unit-both', 'existing', '2026-11-12T00:00:00.000Z', ['related', 'vertical']),
        opportunity('unit-related-only', 'existing', '2026-11-12T00:00:00.000Z', ['related']),
      ],
    };
    const { read } = reader(plan);
    expect((await read.leads(scope, { evaluatedAt: NOW, topK: 8 })).plannedUnitIds).toEqual([
      'unit-vertical',
      'unit-both',
    ]);
  });

  it('reads no topics for a K of zero', async () => {
    const { read, calls } = reader();
    expect((await read.leads(scope, { evaluatedAt: NOW, topK: 0 })).topics).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('names the units of unexpired opportunities for existing content, once each, and never a missing supply or an expired one', async () => {
    const plan: CurrentPlan = {
      revision: 3,
      opportunities: [
        opportunity('unit-a', 'existing', '2026-11-12T00:00:00.000Z'),
        opportunity('unit-a', 'existing', '2026-11-13T00:00:00.000Z'),
        opportunity('unit-b', 'missing_supply', '2026-11-12T00:00:00.000Z'),
        opportunity('unit-c', 'existing', '2026-11-11T11:59:59.000Z'),
      ],
    };
    const { read } = reader(plan);
    expect((await read.leads(scope, { evaluatedAt: NOW, topK: 8 })).plannedUnitIds).toEqual(['unit-a']);
  });
});

describe('rollups: the person’s level and the systems asked for, in the shape of a topic’s statistics', () => {
  it('asks Evidence for the systems and the person, and maps each row', async () => {
    const { read, calls } = reader();
    const result = await read.rollups(scope, { evaluatedAt: NOW, systemIds: ['space', 'earth'] });
    expect(calls).toEqual([['rollups', { systemIds: ['space', 'earth'], person: true, evaluatedAt: NOW }]]);
    expect(result.person).toEqual({
      activity: 9,
      formats: [
        { kind: 'reel', measured: 4, qualified: 3 },
        { kind: 'scroll', measured: 2, qualified: 1 },
      ],
    });
    expect(result.systems).toEqual([
      {
        systemId: 'space',
        activity: 5,
        formats: [
          { kind: 'reel', measured: 4, qualified: 3 },
          { kind: 'scroll', measured: 2, qualified: 1 },
        ],
      },
    ]);
  });

  it('has no person or system for a person with no rows: absence is not zero', async () => {
    const read = makeReadInterestContext({
      readTop: () => Promise.resolve([]),
      readRollups: () => Promise.resolve([]),
    });
    expect(await read.rollups(scope, { evaluatedAt: NOW, systemIds: [] })).toEqual({ systems: [] });
  });
});
