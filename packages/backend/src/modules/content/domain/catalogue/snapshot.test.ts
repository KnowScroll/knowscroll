import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { LIBRARY_SYSTEMS } from '../library/index.js';
import { nodesOfPlan } from './plan-import.js';
import { planRelease, type ReleasePlan } from './release.js';
import { seedRelease, seedSnapshot } from './seed.js';
import { makeSnapshot, type CatalogueSnapshot } from './snapshot.js';
import type { ReleaseRows } from './types.js';

/** The catalogue as it was when it was a constant derived from the plan: the shapes every consumer read before D-419. */
const LEGACY = LIBRARY_SYSTEMS.flatMap((system) => [
  { id: system.id, parent: null, meaning: system.meaning, facets: [] as { id: string; meaning: string }[] },
  ...system.topics.map((topic) => ({
    id: topic.id,
    parent: system.id,
    meaning: topic.meaning,
    facets: topic.facets.map(({ id, meaning }) => ({ id, meaning })),
  })),
]);

/** The label the old `conceptLabel` made from ids. */
const legacyLabel = (topicId: string, facetId?: string): string => {
  const phrase = (id: string) => id.replaceAll('-', ' ');
  const topic = phrase(topicId.slice(topicId.lastIndexOf('.') + 1));
  const heading = topic.charAt(0).toUpperCase() + topic.slice(1);
  if (facetId === undefined || !facetId.startsWith(`${topicId}.`)) return heading;
  return `${heading}: ${phrase(facetId.slice(topicId.length + 1))}`;
};

const seeded = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);

/** Applies one release on top of a snapshot's rows, as the adapter does, and reads the result. */
function release(base: ReleaseRows, plan: ReleasePlan): ReleaseRows {
  if (plan.kind !== 'release') throw new Error(`expected a release, got ${plan.kind}`);
  return plan.rows;
}
const seedRows = seedRelease(LIBRARY_SYSTEMS, canonicalSha256).rows;
const view = (rows: ReleaseRows): CatalogueSnapshot => makeSnapshot(rows, canonicalSha256);

describe('the seeded catalogue is the old constant (catalogue-equivalence, no database)', () => {
  it('holds the six systems, seventeen topics and fifty-three facets of the plan', () => {
    expect(seeded.all().filter((concept) => concept.kind === 'system')).toHaveLength(6);
    expect(seeded.allTopics()).toHaveLength(17);
    expect(seeded.allTopics().reduce((total, topic) => total + topic.facets.length, 0)).toBe(53);
    expect(seedRelease(LIBRARY_SYSTEMS, canonicalSha256).summary).toMatchObject({
      addedSystems: 6,
      addedTopics: 17,
      addedFacets: 53,
    });
  });

  it('reads every id, parent, meaning and facet in the order the constant had them', () => {
    expect(
      seeded.all().map((concept) => ({
        id: concept.id,
        parent: concept.parent,
        meaning: concept.meaning,
        facets: concept.facets.map(({ id, meaning }) => ({ id, meaning })),
      })),
    ).toEqual(LEGACY);
  });

  it('has the digest every earlier coverage mapping recorded as its catalogue digest', () => {
    expect(seeded.digest).toBe(canonicalSha256({ version: 'content-concepts.v1', concepts: LEGACY }));
    expect(seeded.releaseId).toBe(1);
  });

  it('pins the same meaning identity for every facet as the code plan did', () => {
    for (const topic of LEGACY)
      for (const facet of topic.facets) {
        const pinned = canonicalSha256({
          topicId: topic.id,
          topicMeaning: topic.meaning,
          facetId: facet.id,
          facetMeaning: facet.meaning,
        });
        expect(seeded.meaningSha256(topic.id, facet.id)).toBe(pinned);
        expect(seeded.acceptsMeaning(topic.id, facet.id, pinned)).toBe(true);
      }
  });

  it('names every topic and facet as the old label rule did', () => {
    for (const topic of LEGACY) {
      expect(seeded.label(topic.id)).toBe(legacyLabel(topic.id));
      for (const facet of topic.facets) expect(seeded.label(topic.id, facet.id)).toBe(legacyLabel(topic.id, facet.id));
    }
    expect(seeded.label('not.in.the.catalogue')).toBe('Catalogue');
  });

  it('is exact about membership: a system belongs to itself, and a prefix, a label or a lookalike admits nothing', () => {
    expect(seeded.systemOf('earth.seasons')).toBe('earth');
    expect(seeded.systemOf('earth')).toBe('earth');
    expect(seeded.systemOf('space.stars')).not.toBe(seeded.systemOf('earth.seasons'));
    expect(seeded.systemOf('earth.not-a-topic')).toBeUndefined();
    expect(seeded.systemOf('ci.newcontent.topic')).toBeUndefined();
    expect(seeded.systemOf('')).toBeUndefined();
    expect(seeded.systemOf('earth.seasons.axial-tilt')).toBeUndefined();
    expect(seeded.meaning('earth', 'earth.seasons.axial-tilt')).toBeUndefined();
    expect(seeded.meaning('earth.tides', 'earth.seasons.axial-tilt')).toBeUndefined();
    expect(seeded.meaning('earth.seasons', 'earth.seasons.axial-tilt')).toMatchObject({ topicId: 'earth.seasons' });
  });

  it('offers every system and topic: nothing of the seeded catalogue waits for supply', () => {
    expect(seeded.systems().map((system) => system.id)).toEqual(
      LEGACY.filter((concept) => concept.parent === null).map((concept) => concept.id),
    );
    expect(seeded.topics()).toHaveLength(17);
    for (const system of seeded.systems()) expect(seeded.children(system.id).length).toBeGreaterThan(0);
  });

  it('keeps the plan’s silhouettes and hazes, and the formation thresholds as they were (2, 3 and 2)', () => {
    expect(['earth', 'earth.seasons', 'earth.tides', 'earth.greenhouse-effect'].map(seeded.sceneFamilyOf)).toEqual([
      'terraced.v1',
      'terraced.v1',
      'archipelago.v1',
      'ridged.v1',
    ]);
    expect(seeded.sceneFamilyOf('earth.seasons.axial-tilt')).toBeUndefined();
    expect(LIBRARY_SYSTEMS.map((system) => seeded.hazeOf(system.id))).toEqual(
      LIBRARY_SYSTEMS.map((system) => system.haze),
    );
    expect(seeded.hazeOf('earth.seasons')).toBeUndefined();
    expect(seeded.concept('earth')?.policy).toEqual({ systemUnits: 2, planetUnits: 3, planetFacets: 2 });
    expect(seeded.concept('earth.tides')?.policy).toEqual({ systemUnits: 2, planetUnits: 3, planetFacets: 2 });
  });

  it('slices the named nodes in catalogue order and skips ids it does not hold', () => {
    expect(seeded.slice(['space.stars', 'earth', 'nope', 'earth.tides']).map((concept) => concept.id)).toEqual([
      'earth',
      'earth.tides',
      'space.stars',
    ]);
  });
});

describe('the catalogue after releases', () => {
  const growthDraft = (id: string, parentId: string | null, kind: 'system' | 'topic' | 'facet', meaning: string) => ({
    id,
    kind,
    parentId,
    label: id.slice(id.lastIndexOf('.') + 1).replace(/^./u, (c) => c.toUpperCase()),
    meaning,
    sceneFamily: null,
    haze: null,
    sameMeaningAs: [],
  });
  const newTopic = [
    growthDraft('earth.volcanoes', 'earth', 'topic', 'How volcanoes build and reshape land.'),
    growthDraft('earth.volcanoes.magma', 'earth.volcanoes', 'facet', 'Magma rises through the crust and erupts.'),
    growthDraft('earth.volcanoes.plates', 'earth.volcanoes', 'facet', 'Plate boundaries decide where volcanoes form.'),
  ];

  it('holds a new topic back from every listing until it is made servable, and still resolves it by id', () => {
    const made = release(
      seedRows,
      planRelease(
        seedRows,
        newTopic.map((draft) => ({ kind: 'add', draft })),
        canonicalSha256,
      ),
    );
    const waiting = view(made);
    expect(waiting.releaseId).toBe(2);
    expect(waiting.concept('earth.volcanoes')).toMatchObject({ servable: false, parent: 'earth' });
    expect(waiting.systemOf('earth.volcanoes')).toBe('earth');
    expect(waiting.topics().some((topic) => topic.id === 'earth.volcanoes')).toBe(false);
    expect(waiting.children('earth').some((topic) => topic.id === 'earth.volcanoes')).toBe(false);
    expect(waiting.allTopics().some((topic) => topic.id === 'earth.volcanoes')).toBe(true);
    // What existed keeps its ids, order and the identity of every pinned meaning.
    expect(waiting.topics().map((topic) => topic.id)).toEqual(seeded.topics().map((topic) => topic.id));
    expect(waiting.meaningSha256('earth.tides', 'earth.tides.coasts')).toBe(
      seeded.meaningSha256('earth.tides', 'earth.tides.coasts'),
    );
    expect(waiting.digest).not.toBe(seeded.digest);

    const shown = view(
      release(made, planRelease(made, [{ kind: 'show', nodeId: 'earth.volcanoes' }], canonicalSha256)),
    );
    expect(shown.releaseId).toBe(3);
    expect(shown.children('earth').map((topic) => topic.id)).toEqual([
      'earth.seasons',
      'earth.tides',
      'earth.greenhouse-effect',
      'earth.volcanoes',
    ]);
  });

  it('serves a pinned release for ever: an older snapshot never sees what a later release added', () => {
    const made = release(
      seedRows,
      planRelease(
        seedRows,
        newTopic.map((draft) => ({ kind: 'add', draft })),
        canonicalSha256,
      ),
    );
    expect(view(seedRows).concept('earth.volcanoes')).toBeUndefined();
    expect(view(made).concept('earth.volcanoes')).toBeDefined();
    expect(view(seedRows).digest).toBe(seeded.digest);
  });

  it('adds a facet after the existing ones, so no facet ever changes its site', () => {
    const add = [growthDraft('earth.tides.depth', 'earth.tides', 'facet', 'Ocean depth changes how a tide travels.')];
    const made = view(
      release(
        seedRows,
        planRelease(
          seedRows,
          add.map((draft) => ({ kind: 'add', draft })),
          canonicalSha256,
        ),
      ),
    );
    expect(made.concept('earth.tides')!.facets.map((facet) => facet.id)).toEqual([
      ...seeded.concept('earth.tides')!.facets.map((facet) => facet.id),
      'earth.tides.depth',
    ]);
  });

  it('keeps a retired topic resolvable and out of every listing, and never lets its id be used again', () => {
    const retired = release(
      seedRows,
      planRelease(seedRows, [{ kind: 'retire', nodeId: 'earth.tides' }], canonicalSha256),
    );
    const after = view(retired);
    expect(after.concept('earth.tides')).toMatchObject({ retired: true });
    expect(after.topics().some((topic) => topic.id === 'earth.tides')).toBe(false);
    expect(after.allTopics().some((topic) => topic.id === 'earth.tides')).toBe(false);
    expect(after.meaningSha256('earth.tides', 'earth.tides.coasts')).toBe(
      seeded.meaningSha256('earth.tides', 'earth.tides.coasts'),
    );
    expect(after.has('earth.tides.coasts')).toBe(true);
    const again = planRelease(
      retired,
      [{ kind: 'add', draft: growthDraft('earth.tides', 'earth', 'topic', 'A different thing with the same id.') }],
      canonicalSha256,
    );
    expect(again).toMatchObject({ kind: 'refused', refusals: [{ code: 'id_taken' }] });
  });

  it('a system is servable only while one of its topics is', () => {
    const system = [growthDraft('geology', null, 'system', 'The solid Earth and how it changes over deep time.')];
    const topic = [
      growthDraft('geology.rocks', 'geology', 'topic', 'Rocks form and change in a cycle.'),
      growthDraft('geology.rocks.igneous', 'geology.rocks', 'facet', 'Igneous rock cools from melt.'),
      growthDraft('geology.rocks.sediment', 'geology.rocks', 'facet', 'Sediment settles and is pressed into rock.'),
    ];
    const made = release(
      seedRows,
      planRelease(
        seedRows,
        [...system, ...topic].map((draft) => ({ kind: 'add', draft })),
        canonicalSha256,
      ),
    );
    expect(view(made).concept('geology')).toMatchObject({ servable: false });
    expect(
      view(made)
        .systems()
        .map((entry) => entry.id),
    ).not.toContain('geology');
    const shown = view(release(made, planRelease(made, [{ kind: 'show', nodeId: 'geology.rocks' }], canonicalSha256)));
    expect(shown.systems().map((entry) => entry.id)).toContain('geology');
  });
});

describe('what a revision does to the certificates decided against the old wording', () => {
  const [earthTides] = nodesOfPlan(LIBRARY_SYSTEMS).filter((draft) => draft.id === 'earth.tides.coasts');
  const wordingOnly = {
    ...earthTides!,
    meaning: 'Coastlines and basin dynamics limit simple global tide predictions (rephrased).',
    sameMeaningAs: [earthTides!.meaning],
  };
  const semantic = {
    ...earthTides!,
    meaning: 'A coast is where land meets the sea and tides are higher in bays.',
    sameMeaningAs: [],
  };

  it('keeps a certificate valid when the revision declares the old wording the same meaning', () => {
    const before = seeded.meaningSha256('earth.tides', 'earth.tides.coasts')!;
    const rows = release(seedRows, planRelease(seedRows, [{ kind: 'revise', draft: wordingOnly }], canonicalSha256));
    const after = view(rows);
    const now = after.meaningSha256('earth.tides', 'earth.tides.coasts')!;
    expect(now).not.toBe(before);
    expect(after.acceptsMeaning('earth.tides', 'earth.tides.coasts', before)).toBe(true);
    expect(after.acceptsMeaning('earth.tides', 'earth.tides.coasts', now)).toBe(true);
    expect(after.concept('earth.tides')!.facets.find((facet) => facet.id === 'earth.tides.coasts')!.meaning).toBe(
      wordingOnly.meaning,
    );
  });

  it('does not keep it valid when the meaning changed', () => {
    const before = seeded.meaningSha256('earth.tides', 'earth.tides.coasts')!;
    const rows = release(seedRows, planRelease(seedRows, [{ kind: 'revise', draft: semantic }], canonicalSha256));
    const after = view(rows);
    expect(after.acceptsMeaning('earth.tides', 'earth.tides.coasts', before)).toBe(false);
    expect(
      after.acceptsMeaning(
        'earth.tides',
        'earth.tides.coasts',
        after.meaningSha256('earth.tides', 'earth.tides.coasts')!,
      ),
    ).toBe(true);
    // The other facets are untouched.
    const other = seeded.meaningSha256('earth.tides', 'earth.tides.forcing')!;
    expect(after.acceptsMeaning('earth.tides', 'earth.tides.forcing', other)).toBe(true);
  });

  it('keeps the earlier wordings valid through a second wording-only revision', () => {
    const first = release(seedRows, planRelease(seedRows, [{ kind: 'revise', draft: wordingOnly }], canonicalSha256));
    const again = {
      ...wordingOnly,
      meaning: 'Tide predictions are limited by the shape of coasts and basins.',
      sameMeaningAs: [wordingOnly.meaning],
    };
    const second = view(release(first, planRelease(first, [{ kind: 'revise', draft: again }], canonicalSha256)));
    const original = seeded.meaningSha256('earth.tides', 'earth.tides.coasts')!;
    expect(second.acceptsMeaning('earth.tides', 'earth.tides.coasts', original)).toBe(true);
    expect(
      second.acceptsMeaning(
        'earth.tides',
        'earth.tides.coasts',
        view(first).meaningSha256('earth.tides', 'earth.tides.coasts')!,
      ),
    ).toBe(true);
  });

  it('accepts a topic’s wording-only revision for each of its facets', () => {
    const topic = nodesOfPlan(LIBRARY_SYSTEMS).find((draft) => draft.id === 'earth.tides')!;
    const rows = release(
      seedRows,
      planRelease(
        seedRows,
        [
          {
            kind: 'revise',
            draft: {
              ...topic,
              meaning: 'Ocean tides under differential gravity and local conditions.',
              sameMeaningAs: [topic.meaning],
            },
          },
        ],
        canonicalSha256,
      ),
    );
    const after = view(rows);
    for (const facet of seeded.concept('earth.tides')!.facets)
      expect(after.acceptsMeaning('earth.tides', facet.id, seeded.meaningSha256('earth.tides', facet.id)!)).toBe(true);
  });
});
