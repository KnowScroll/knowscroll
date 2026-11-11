import { describe, expect, it } from 'vitest';
import type { EncounterQuery, EncounterSnapshot } from '../../content/public.js';
import type { ComposeEncounter } from './ports.js';
import { COMPOSER_POLICY_V1, COMPOSER_POLICY_V2 } from '../domain/policy.js';
import {
  OTHER_FORMAT_RESERVE,
  VERTICAL_RETRIEVAL_LIMIT,
  readVerticalCandidates,
  wantsUnseenFirst,
} from './vertical-candidates.js';

function encounter(name: string, kind: 'reel' | 'scroll', topicId = 'earth.seasons'): EncounterSnapshot {
  return {
    assetId: name,
    assetRevision: 1,
    kind,
    explanationUnitId: `unit-${name}`,
    metadata: { kind, title: name, summary: '', language: 'en' },
    topics: [
      { topicId, role: 'primary', weight: 0.7 },
      { topicId: 'earth.tides', role: 'incidental', weight: 0.3 },
    ],
    facets: [],
    siblings: [],
    catalogWatermark: 'w',
    attributionVersion: 'v',
  };
}

/** A fake retrieval that holds `count` of each format and returns as many as the query asks for. */
function library(counts: { reel: number; scroll: number }) {
  const queries: EncounterQuery[] = [];
  const read = (_scope: unknown, query: EncounterQuery): Promise<readonly EncounterSnapshot[]> => {
    queries.push(query);
    const found = query.formats.flatMap((kind) =>
      Array.from({ length: counts[kind] }, (_, n) => encounter(`${kind}-${String(n)}`, kind)),
    );
    return Promise.resolve(found.slice(0, query.limit ?? 100));
  };
  return { read, queries };
}
const scope = {} as never;

describe('vertical retrieval', () => {
  it('asks for the source’s non-incidental topics, never text, and passes the decision seed to rotate each lane', async () => {
    const { read, queries } = library({ reel: 3, scroll: 3 });
    await readVerticalCandidates(read, scope, {
      source: encounter('source', 'scroll'),
      formats: ['reel', 'scroll'],
      capabilities: {},
      seed: 'decision-seed',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ topicIds: ['earth.seasons'], rotation: 'decision-seed', limit: 100 });
    expect(queries[0]).not.toHaveProperty('text');
  });

  it('names no rotation when it has no seed, so a caller without one still reads the stable random order', async () => {
    const { read, queries } = library({ reel: 1, scroll: 1 });
    await readVerticalCandidates(read, scope, { formats: ['scroll'], capabilities: {} });
    expect(queries[0]).not.toHaveProperty('rotation');
    expect(queries[0]!.topicIds).toEqual([]);
  });

  it('always reads some of the other format beside a person’s own, even when theirs fills the cap', async () => {
    // A library with far more than 100 Reels: before, the Scrolls were never read, so format stickiness had nothing to
    // give way to when a Reel watcher had met every Reel in the 100.
    const { read, queries } = library({ reel: 500, scroll: 40 });
    const found = await readVerticalCandidates(read, scope, {
      formats: ['reel', 'scroll'],
      capabilities: {},
      stickyFormat: 'reel',
      seed: 's',
    });
    expect(queries.map((q) => [q.formats, q.limit])).toEqual([
      [['reel'], VERTICAL_RETRIEVAL_LIMIT - OTHER_FORMAT_RESERVE],
      [['scroll'], OTHER_FORMAT_RESERVE],
    ]);
    expect(found).toHaveLength(VERTICAL_RETRIEVAL_LIMIT);
    expect(found.filter((e) => e.kind === 'scroll')).toHaveLength(OTHER_FORMAT_RESERVE);
    // Both reads rotate from the same seed.
    expect(queries.every((q) => q.rotation === 's')).toBe(true);
  });

  it('gives the other format whatever the person’s own leaves of the cap', async () => {
    const { read } = library({ reel: 30, scroll: 500 });
    const found = await readVerticalCandidates(read, scope, {
      formats: ['reel', 'scroll'],
      capabilities: {},
      stickyFormat: 'reel',
    });
    expect(found.filter((e) => e.kind === 'reel')).toHaveLength(30);
    expect(found.filter((e) => e.kind === 'scroll')).toHaveLength(70);
  });

  it('reads nothing when the client can render no format', async () => {
    const { read, queries } = library({ reel: 5, scroll: 5 });
    expect(await readVerticalCandidates(read, scope, { formats: [], capabilities: {} })).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('asks for the unseen first, and for the source’s own unit to be always read, only when it is given a condition', async () => {
    const { read, queries } = library({ reel: 3, scroll: 3 });
    const unseenFirst = { text: 'not exists (select 1 from t where t.u = {unit})', values: [] };
    await readVerticalCandidates(read, scope, {
      source: encounter('source', 'scroll'),
      formats: ['reel', 'scroll'],
      capabilities: {},
      stickyFormat: 'scroll',
      unseenFirst,
    });
    expect(queries).toHaveLength(2);
    for (const query of queries) expect(query).toMatchObject({ unseenFirst, alwaysUnits: ['unit-source'] });

    const plain = library({ reel: 3, scroll: 3 });
    await readVerticalCandidates(plain.read, scope, { formats: ['scroll'], capabilities: {} });
    expect(plain.queries[0]).not.toHaveProperty('unseenFirst');
    expect(plain.queries[0]).not.toHaveProperty('alwaysUnits');
  });

  it('with no source there is no unit to always read', async () => {
    const { read, queries } = library({ reel: 1, scroll: 1 });
    await readVerticalCandidates(read, scope, {
      formats: ['scroll'],
      capabilities: {},
      unseenFirst: { text: 'true', values: [] },
    });
    expect(queries[0]).toMatchObject({ alwaysUnits: [] });
  });

  it('only a policy that asks for it reads the unseen first: v2, not v0 or v1', () => {
    const under = (policy?: ComposeEncounter['policy']): ComposeEncounter =>
      Object.assign(() => ({}) as never, { policy });
    expect(wantsUnseenFirst(under(COMPOSER_POLICY_V2))).toBe(true);
    expect(wantsUnseenFirst(under(COMPOSER_POLICY_V1))).toBe(false);
    expect(wantsUnseenFirst(under(undefined))).toBe(false);
  });
});
