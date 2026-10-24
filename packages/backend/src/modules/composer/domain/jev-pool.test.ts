import { describe, expect, it } from 'vitest';
import { ASSESSMENT_LIFETIME_MS } from './buffer.js';
import {
  JEV_POOL_LIMIT,
  JEV_REFRESH_INTERVAL_MS,
  jevSubjectOf,
  planAssessments,
  poolWith,
  usableAssessments,
  type JevPool,
  type PooledAssessment,
} from './jev-pool.js';
import type { EncounterSnapshot, TopicAttribution } from './types.js';

const now = new Date('2026-10-24T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const version = { roleVersion: 'jev.1/hp2', model: 'fixture-model' };

function encounter(index: number, topics: readonly TopicAttribution[] = [], language = 'en'): EncounterSnapshot {
  return {
    assetId: `asset-${String(index)}`,
    assetRevision: 1,
    kind: 'scroll',
    explanationUnitId: `unit-${String(index)}`,
    metadata: { kind: 'scroll', title: `Title ${String(index)}`, summary: 'Summary', language },
    topics,
    facets: [],
    siblings: [],
    catalogWatermark: 'watermark',
    attributionVersion: 'taxonomy',
  };
}

function assessment(index: number, ageMinutes: number, subject = 'en|topic:rivers'): PooledAssessment {
  return {
    subject,
    assetId: `asset-${String(index)}`,
    assetRevision: 1,
    relevance: 0.8,
    appropriateness: 0.7,
    redundancy: 0.1,
    assessedAt: minutesAgo(ageMinutes),
  };
}

const poolOf = (entries: readonly PooledAssessment[], overrides: Partial<JevPool> = {}): JevPool => ({
  ...version,
  entries,
  ...overrides,
});

describe('the subject a Jev assessment is about', () => {
  it('is the language and the heaviest topic that is not incidental', () => {
    const source = encounter(1, [
      { topicId: 'water', role: 'supporting', weight: 0.3 },
      { topicId: 'rivers', role: 'primary', weight: 0.6 },
      { topicId: 'weather', role: 'incidental', weight: 0.9 },
    ]);
    expect(jevSubjectOf(source)).toBe('en|topic:rivers');
    expect(jevSubjectOf(encounter(2, source.topics, 'de'))).toBe('de|topic:rivers');
  });

  it('breaks a tie by topic ID so the subject never depends on order', () => {
    const topics: TopicAttribution[] = [
      { topicId: 'b', role: 'primary', weight: 0.5 },
      { topicId: 'a', role: 'primary', weight: 0.5 },
    ];
    expect(jevSubjectOf(encounter(1, topics))).toBe(jevSubjectOf(encounter(1, [...topics].reverse())));
    expect(jevSubjectOf(encounter(1, topics))).toBe('en|topic:a');
  });

  it('is the explanation itself when the step has no topic, so its judgements are never lent to another step', () => {
    expect(jevSubjectOf(encounter(1))).toBe('en|unit:unit-1');
    expect(jevSubjectOf(encounter(1, [{ topicId: 'x', role: 'incidental', weight: 1 }]))).toBe('en|unit:unit-1');
    expect(jevSubjectOf(encounter(1))).not.toBe(jevSubjectOf(encounter(2)));
  });
});

describe('which stored assessments may be used', () => {
  const pool = poolOf([assessment(1, 5), assessment(2, 29), assessment(3, 31), assessment(4, 5, 'en|topic:tides')]);

  it('keeps those of this subject that are inside their 30 minutes', () => {
    expect(usableAssessments(pool, version, 'en|topic:rivers', now).map((entry) => entry.assetId)).toEqual([
      'asset-1',
      'asset-2',
    ]);
  });

  it('uses nothing that another role version or model made, or when there is no pool', () => {
    expect(usableAssessments(pool, { ...version, roleVersion: 'jev.2/hp2' }, 'en|topic:rivers', now)).toEqual([]);
    expect(usableAssessments(pool, { ...version, model: 'other-model' }, 'en|topic:rivers', now)).toEqual([]);
    expect(usableAssessments(undefined, version, 'en|topic:rivers', now)).toEqual([]);
  });

  it('lets an assessment lapse exactly at the end of its lifetime', () => {
    const edge = poolOf([
      { ...assessment(1, 0), assessedAt: new Date(now.getTime() - ASSESSMENT_LIFETIME_MS).toISOString() },
    ]);
    expect(usableAssessments(edge, version, 'en|topic:rivers', now)).toEqual([]);
  });
});

describe('whether Jev is worth a call', () => {
  const shortlist = [encounter(1), encounter(2), encounter(3)];

  it('asks about everything when nothing is stored', () => {
    expect(planAssessments(shortlist, [], now)).toEqual({ kind: 'ask', candidates: shortlist });
  });

  it('asks nothing when every shortlisted candidate already has an assessment', () => {
    const stored = [assessment(1, 25), assessment(2, 25), assessment(3, 25), assessment(9, 25)];
    expect(planAssessments(shortlist, stored, now)).toEqual({ kind: 'reuse', reason: 'nothing_new' });
  });

  it('asks only about the candidates without an assessment once the subject’s last call is old enough', () => {
    const stored = [assessment(1, 25), assessment(2, 25)];
    expect(planAssessments(shortlist, stored, now)).toEqual({ kind: 'ask', candidates: [shortlist[2]] });
  });

  it('waits out the refresh interval after the newest assessment of the subject, however many are new', () => {
    const justAssessed = [assessment(1, 2)];
    expect(planAssessments(shortlist, justAssessed, now)).toEqual({ kind: 'reuse', reason: 'recently_assessed' });
    const atTheEdge = [assessment(1, JEV_REFRESH_INTERVAL_MS / 60_000)];
    expect(planAssessments(shortlist, atTheEdge, now).kind).toBe('ask');
  });

  it('counts the refresh interval from the newest assessment, not the oldest', () => {
    const mixed = [assessment(1, 28), assessment(2, 3)];
    expect(planAssessments(shortlist, mixed, now)).toEqual({ kind: 'reuse', reason: 'recently_assessed' });
  });
});

describe('the pool after new assessments', () => {
  it('adds the new entries to the ones still inside their life and drops the rest', () => {
    const existing = poolOf([assessment(1, 5), assessment(2, 40)]);
    const added = poolOf([assessment(3, 0)]);
    expect(
      poolWith(existing, added, now)
        .entries.map((entry) => entry.assetId)
        .sort(),
    ).toEqual(['asset-1', 'asset-3']);
  });

  it('lets a new assessment replace the old one for the same subject and candidate, not for another subject', () => {
    const existing = poolOf([assessment(1, 5), assessment(1, 5, 'en|topic:tides')]);
    const fresh = { ...assessment(1, 0), relevance: 0.1 };
    const merged = poolWith(existing, poolOf([fresh]), now).entries;
    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.subject === 'en|topic:rivers')?.relevance).toBe(0.1);
    expect(merged.find((entry) => entry.subject === 'en|topic:tides')?.relevance).toBe(0.8);
  });

  it('starts again when the old entries came from another role version or model', () => {
    const existing = poolOf([assessment(1, 5)], { roleVersion: 'jev.0/hp1' });
    expect(poolWith(existing, poolOf([assessment(2, 0)]), now).entries.map((entry) => entry.assetId)).toEqual([
      'asset-2',
    ]);
    expect(
      poolWith(poolOf([assessment(1, 5)], { model: 'old' }), poolOf([assessment(2, 0)]), now).entries,
    ).toHaveLength(1);
  });

  it('keeps the newest entries when there are more than the limit', () => {
    const many = Array.from({ length: JEV_POOL_LIMIT + 20 }, (_, index) => assessment(index, index / 10));
    const merged = poolWith(undefined, poolOf(many), now).entries;
    expect(merged).toHaveLength(JEV_POOL_LIMIT);
    expect(merged[0]?.assetId).toBe('asset-0');
    expect(merged.some((entry) => entry.assetId === `asset-${String(JEV_POOL_LIMIT + 19)}`)).toBe(false);
  });

  it('is empty when nothing is left, which the store turns into no row', () => {
    expect(poolWith(poolOf([assessment(1, 40)]), poolOf([]), now).entries).toEqual([]);
  });
});
