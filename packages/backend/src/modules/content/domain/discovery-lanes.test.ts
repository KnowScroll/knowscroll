import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { RELEASE_1_PLAN } from './catalogue/release-1.fixture.js';
import { seedSnapshot } from './catalogue/seed.js';
import { makeSnapshot, type CatalogueSnapshot } from './catalogue/snapshot.js';
import type { NodeRow, RevisionRow } from './catalogue/types.js';
import {
  DISCOVERY_LANE_LIMITS,
  DISCOVERY_LANE_QUOTAS,
  DISCOVERY_LANES,
  siblingTopicIds,
  topicSystemPairs,
  validateDiscoveryLanes,
} from './discovery-lanes.js';

/** The catalogue of release 1: six systems and seventeen topics, every one servable. */
const catalogue = seedSnapshot(RELEASE_1_PLAN, canonicalSha256);

/** A catalogue of invented nodes: `waiting` topics have no released supply yet and `retired` ones are gone. */
function invented(
  concepts: readonly { readonly id: string; readonly parent: string | null }[],
  status: { readonly waiting?: readonly string[]; readonly retired?: readonly string[] } = {},
  releaseId = 1,
): CatalogueSnapshot {
  const nodes: NodeRow[] = concepts.map((concept, at) => ({
    nodeId: concept.id,
    kind: concept.parent === null ? 'system' : 'topic',
    parentId: concept.parent,
    seq: at + 1,
    introducedIn: 1,
    visibleIn: concept.parent === null || status.waiting?.includes(concept.id) ? null : 1,
    retiredIn: status.retired?.includes(concept.id) ? releaseId : null,
    mergedInto: null,
  }));
  const revisions: RevisionRow[] = concepts.map((concept) => ({
    nodeId: concept.id,
    revision: 1,
    introducedIn: 1,
    label: concept.id,
    meaning: `Invented meaning of ${concept.id}.`,
    meaningSha256: canonicalSha256(concept.id),
    compatibleWith: [],
    systemUnits: null,
    planetUnits: null,
    planetFacets: null,
    sceneFamily: concept.parent === null ? 'terraced.v1' : null,
    haze: concept.parent === null ? 'teal' : null,
  }));
  return makeSnapshot({ releaseId, digest: 'invented', nodes, revisions }, canonicalSha256);
}

describe('the lanes of a retrieval (D-420)', () => {
  it('names the six lanes in priority order', () => {
    expect(DISCOVERY_LANES).toEqual(['source', 'planned', 'text', 'continue', 'adjacent', 'explore']);
  });

  it('caps the lanes before explore at 66, so explore keeps at least 34 of the 100 and takes the rest, without the text lane a subject move never asks for', () => {
    const { source, planned, continue: continued, adjacent, explore } = DISCOVERY_LANE_QUOTAS;
    expect(source + planned + continued + adjacent).toBe(66);
    expect(100 - (source + planned + continued + adjacent)).toBeGreaterThanOrEqual(34);
    expect(explore).toBe(100);
  });

  it('keeps ids as data: bounded, non-empty and de-duplicated', () => {
    const checked = validateDiscoveryLanes({ continueTopicIds: ['a', 'b', 'a'], plannedUnitIds: ['u'], catalogue });
    expect(checked).toEqual({ continueTopicIds: ['a', 'b'], plannedUnitIds: ['u'], catalogue });
  });

  it('refuses what is not a bounded list of ids', () => {
    const tooMany = Array.from({ length: DISCOVERY_LANE_LIMITS.continueTopics + 1 }, (_, n) => `t${String(n)}`);
    expect(() => validateDiscoveryLanes({ continueTopicIds: tooMany, plannedUnitIds: [], catalogue })).toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(() => validateDiscoveryLanes({ continueTopicIds: [''], plannedUnitIds: [], catalogue })).toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(() =>
      validateDiscoveryLanes({ continueTopicIds: ['x'.repeat(161)], plannedUnitIds: [], catalogue }),
    ).toThrow('DISCOVERY_LANES_INVALID');
    expect(() =>
      validateDiscoveryLanes({
        continueTopicIds: [],
        plannedUnitIds: Array.from({ length: 13 }, (_, n) => `u${String(n)}`),
        catalogue,
      }),
    ).toThrow('DISCOVERY_LANES_INVALID');
    expect(() =>
      validateDiscoveryLanes({ continueTopicIds: 'a' as unknown as string[], plannedUnitIds: [], catalogue }),
    ).toThrow('DISCOVERY_LANES_INVALID');
    expect(() => validateDiscoveryLanes(null as unknown as never)).toThrow('DISCOVERY_LANES_INVALID');
  });

  it('refuses a read that names no catalogue release, since the strata and siblings come from one', () => {
    expect(() =>
      validateDiscoveryLanes({ continueTopicIds: [], plannedUnitIds: [] } as unknown as Parameters<
        typeof validateDiscoveryLanes
      >[0]),
    ).toThrow('DISCOVERY_LANES_INVALID');
  });
});

describe('the strata and siblings of retrieval lanes, read from one catalogue release (D-420, D-419)', () => {
  it('pairs every servable topic with its system, in two parallel arrays in catalogue order', () => {
    const { topicIds, systemIds } = topicSystemPairs(catalogue);
    expect(topicIds).toEqual(catalogue.topics().map((topic) => topic.id));
    expect(topicIds).toHaveLength(17);
    expect(systemIds).toHaveLength(topicIds.length);
    topicIds.forEach((id, index) => expect(systemIds[index]).toBe(catalogue.systemOf(id)));
    expect(topicIds).not.toContain('earth');
  });

  it('lists the other topics of the same system and never the topics asked about or a system itself', () => {
    const siblings = siblingTopicIds(catalogue, ['earth.seasons']);
    expect(siblings).toContain('earth.tides');
    expect(siblings).toContain('earth.greenhouse-effect');
    expect(siblings).not.toContain('earth.seasons');
    expect(siblings).not.toContain('earth');
    expect(siblings.every((id) => catalogue.systemOf(id) === 'earth')).toBe(true);
  });

  it('takes the siblings of every system the topics belong to, and none for an id the catalogue does not hold', () => {
    const siblings = siblingTopicIds(catalogue, ['earth.seasons', 'space.stars']);
    expect(siblings).toContain('earth.tides');
    expect(siblings).toContain('space.exoplanets');
    expect(siblingTopicIds(catalogue, ['ci.newcontent.topic'])).toEqual([]);
    expect(siblingTopicIds(catalogue, [])).toEqual([]);
  });

  it('does not list a topic asked about when a whole system is asked about, and honours the bound', () => {
    expect(siblingTopicIds(catalogue, ['earth.seasons', 'earth.tides', 'earth.greenhouse-effect'])).toEqual([]);
    expect(siblingTopicIds(catalogue, ['space.stars'], 1)).toHaveLength(1);
  });

  it('keeps the order of the catalogue across systems', () => {
    const siblings = siblingTopicIds(catalogue, ['space.stars', 'earth.seasons']);
    const order = catalogue.topics().map((topic) => topic.id);
    expect(siblings).toEqual(order.filter((id) => siblings.includes(id)));
  });

  const nodes = [
    { id: 'a', parent: null },
    { id: 'a.one', parent: 'a' },
    { id: 'a.two', parent: 'a' },
    { id: 'a.waiting', parent: 'a' },
    { id: 'a.gone', parent: 'a' },
    { id: 'b', parent: null },
    { id: 'b.one', parent: 'b' },
  ];

  it('offers only servable, active topics: a topic still waiting for supply and a retired topic are in no stratum and no sibling list', () => {
    const release = invented(nodes, { waiting: ['a.waiting'], retired: ['a.gone'] });
    expect(topicSystemPairs(release)).toEqual({ topicIds: ['a.one', 'a.two', 'b.one'], systemIds: ['a', 'a', 'b'] });
    expect(siblingTopicIds(release, ['a.one'])).toEqual(['a.two']);
    // The source may itself be a topic that is waiting or retired: its system still names its siblings.
    expect(siblingTopicIds(release, ['a.waiting'])).toEqual(['a.one', 'a.two']);
    expect(siblingTopicIds(release, ['a.gone'])).toEqual(['a.one', 'a.two']);
  });

  it('reads the release it is given: a later release that adds a topic or retires one changes only its own answer', () => {
    const before = invented(nodes, { waiting: ['a.waiting'], retired: ['a.gone'] });
    const after = invented(
      [...nodes, { id: 'b.two', parent: 'b' }],
      { waiting: ['a.waiting'], retired: ['a.gone', 'a.two'] },
      2,
    );
    expect(topicSystemPairs(before).topicIds).toEqual(['a.one', 'a.two', 'b.one']);
    expect(topicSystemPairs(after).topicIds).toEqual(['a.one', 'b.one', 'b.two']);
    expect(siblingTopicIds(before, ['b.one'])).toEqual([]);
    expect(siblingTopicIds(after, ['b.one'])).toEqual(['b.two']);
  });
});
