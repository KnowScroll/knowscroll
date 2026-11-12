import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { LIBRARY_SYSTEMS } from '../library/index.js';
import type { ReleasedCoverage } from '../library/gap-facts.js';
import { SHORTLIST_TOPICS, shortlistTopics } from './shortlist.js';
import { makeSnapshot } from './snapshot.js';
import { seedRelease, seedSnapshot } from './seed.js';
import { topicsNowServable } from './visibility.js';
import { planRelease } from './release.js';
import type { NodeDraft } from './plan-import.js';
import type { CatalogueSnapshot } from './snapshot.js';

const seeded = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);

// A word's first five letters are its key word, so each invented word differs inside them.
const letter = (n: number) => String.fromCharCode(97 + (n % 26));
const word = (n: number) =>
  `${letter(n)}${letter(Math.floor(n / 26))}${letter(Math.floor(n / 676))}${letter(Math.floor(n / 17576))}x${letter(7)}onium`;

/** A catalogue of many invented topics, each with a distinctive word, as a large catalogue would be. */
function large(topics: number): CatalogueSnapshot {
  const base = seedRelease(LIBRARY_SYSTEMS, canonicalSha256).rows;
  const drafts: NodeDraft[] = [];
  for (let n = 0; n < topics; n += 1) {
    const id = `earth.t${String(n)}`;
    const draft = (key: string, kind: NodeDraft['kind'], parent: string, at: number): NodeDraft => ({
      id: key,
      kind,
      parentId: parent,
      label: `${word(n)} ${kind}${String(at)}`,
      meaning: `About ${word(n)} and how it behaves in the world, number ${String(n)}.`,
      sceneFamily: null,
      haze: null,
      sameMeaningAs: [],
    });
    drafts.push(draft(id, 'topic', 'earth', 0), draft(`${id}.a`, 'facet', id, 1), draft(`${id}.b`, 'facet', id, 2));
  }
  const planned = planRelease(
    base,
    drafts.map((d) => ({ kind: 'add', draft: d })),
    canonicalSha256,
    { visibleOnAdd: true },
  );
  if (planned.kind !== 'release') throw new Error('expected a release');
  return makeSnapshot(planned.rows, canonicalSha256);
}

describe('the shortlist a prompt is shown instead of the whole catalogue', () => {
  it('is every servable topic while the catalogue is within the bound, so a small catalogue behaves as it did', () => {
    expect(seeded.topics().length).toBeLessThanOrEqual(SHORTLIST_TOPICS);
    expect(shortlistTopics(seeded, 'why is the sky blue').map((topic) => topic.id)).toEqual(
      seeded.topics().map((topic) => topic.id),
    );
  });

  it('is bounded however large the catalogue grows, best match first', () => {
    const catalogue = large(2000);
    expect(catalogue.topics().length).toBe(2017);
    const shortlist = shortlistTopics(catalogue, `${word(1)} ${word(1)}`);
    expect(shortlist.length).toBeGreaterThan(0);
    expect(shortlist.length).toBeLessThanOrEqual(SHORTLIST_TOPICS);
    expect(shortlist[0]!.meaning).toContain(word(1));
  });

  it('is empty when nothing in the catalogue shares a key word with the text, and never reads past the bound', () => {
    const catalogue = large(200);
    expect(shortlistTopics(catalogue, 'quokka marathon')).toEqual([]);
    expect(shortlistTopics(catalogue, '')).toEqual([]);
    expect(shortlistTopics(catalogue, word(1), 3).length).toBeLessThanOrEqual(3);
  });

  it('leaves out a topic that is not servable yet', () => {
    const base = seedRelease(LIBRARY_SYSTEMS, canonicalSha256).rows;
    const drafts: NodeDraft[] = ['topic', 'a', 'b'].map((part, at) => ({
      id: at === 0 ? 'earth.waiting' : `earth.waiting.${part}`,
      kind: at === 0 ? 'topic' : 'facet',
      parentId: at === 0 ? 'earth' : 'earth.waiting',
      label: at === 0 ? 'Waiting' : `Angle ${part}`,
      meaning: 'A topic about zorblax that nobody can be offered yet.',
      sceneFamily: null,
      haze: null,
      sameMeaningAs: [],
    }));
    const planned = planRelease(
      base,
      drafts.map((draft) => ({ kind: 'add', draft })),
      canonicalSha256,
    );
    if (planned.kind !== 'release') throw new Error('expected a release');
    const waiting = makeSnapshot(planned.rows, canonicalSha256);
    expect(shortlistTopics(waiting, 'zorblax').map((topic) => topic.id)).not.toContain('earth.waiting');
  });
});

describe('when a new topic becomes servable', () => {
  const base = seedRelease(LIBRARY_SYSTEMS, canonicalSha256).rows;
  const drafts: NodeDraft[] = [
    {
      id: 'earth.waiting',
      kind: 'topic',
      parentId: 'earth',
      label: 'Waiting',
      meaning: 'A topic that waits for released supply.',
      sceneFamily: null,
      haze: null,
      sameMeaningAs: [],
    },
    {
      id: 'earth.waiting.a',
      kind: 'facet',
      parentId: 'earth.waiting',
      label: 'Angle a',
      meaning: 'The first angle on the waiting topic.',
      sceneFamily: null,
      haze: null,
      sameMeaningAs: [],
    },
    {
      id: 'earth.waiting.b',
      kind: 'facet',
      parentId: 'earth.waiting',
      label: 'Angle b',
      meaning: 'The second angle on the waiting topic.',
      sceneFamily: null,
      haze: null,
      sameMeaningAs: [],
    },
  ];
  const planned = planRelease(
    base,
    drafts.map((draft) => ({ kind: 'add', draft })),
    canonicalSha256,
  );
  if (planned.kind !== 'release') throw new Error('expected a release');
  const snapshot = makeSnapshot(planned.rows, canonicalSha256);
  const supply = (units: number, facets: readonly string[]): ReleasedCoverage => ({
    planets: [{ topicId: 'earth.waiting', units, facets: facets.map((facetId) => ({ facetId, units: 1 })) }],
  });

  it('needs three released explanations over two of its own facets', () => {
    expect(topicsNowServable(snapshot, supply(3, ['earth.waiting.a', 'earth.waiting.b']))).toEqual(['earth.waiting']);
    expect(topicsNowServable(snapshot, supply(2, ['earth.waiting.a', 'earth.waiting.b']))).toEqual([]);
    expect(topicsNowServable(snapshot, supply(5, ['earth.waiting.a']))).toEqual([]);
  });

  it('counts only facets the topic has, and never a topic that is already servable', () => {
    expect(topicsNowServable(snapshot, supply(4, ['earth.waiting.a', 'earth.tides.coasts']))).toEqual([]);
    expect(
      topicsNowServable(snapshot, {
        planets: [{ topicId: 'earth.tides', units: 9, facets: [{ facetId: 'earth.tides.coasts', units: 9 }] }],
      }),
    ).toEqual([]);
    expect(topicsNowServable(snapshot, { planets: [] })).toEqual([]);
  });
});
