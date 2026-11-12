import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import type { HazeFamilyName, LibrarySystem } from '../library/plan.js';
import { RELEASE_1_COUNTS, RELEASE_1_PLAN } from './release-1.fixture.js';
import { changesToMatch } from './diff.js';
import { assignedHaze, nodesOfPlan, type NodeDraft } from './plan-import.js';
import { planRelease, type RefusalCode, type ReleaseChange, type ReleasePlan } from './release.js';
import { seedRelease } from './seed.js';
import { makeSnapshot } from './snapshot.js';
import type { ReleaseRows } from './types.js';

const seedRows = seedRelease(RELEASE_1_PLAN, canonicalSha256).rows;
const plan = (changes: readonly ReleaseChange[], base: ReleaseRows = seedRows): ReleasePlan =>
  planRelease(base, changes, canonicalSha256);
const add = (draft: NodeDraft): ReleaseChange => ({ kind: 'add', draft });

const draft = (
  id: string,
  kind: NodeDraft['kind'],
  parentId: string | null,
  overrides: Partial<NodeDraft> = {},
): NodeDraft => ({
  id,
  kind,
  parentId,
  label: id.slice(id.lastIndexOf('.') + 1).replace(/^./u, (c) => c.toUpperCase()),
  meaning: `An authored meaning for ${id} that is long enough.`,
  sceneFamily: kind === 'system' ? 'ridged.v1' : null,
  haze: kind === 'system' ? 'pink' : null,
  sameMeaningAs: [],
  ...overrides,
});
const topicWithFacets = (id: string, system: string, facets: readonly string[] = ['one', 'two']): NodeDraft[] => [
  draft(id, 'topic', system, { label: 'Volcanoes' }),
  ...facets.map((facet, at) => draft(`${id}.${facet}`, 'facet', id, { label: `Angle ${String(at + 1)}` })),
];

function refusedWith(result: ReleasePlan): readonly RefusalCode[] {
  if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
  return result.refusals.map((refusal) => refusal.code);
}

describe('admission is decided by code', () => {
  it('admits a topic with its facets under a system, as the next release', () => {
    const result = plan(topicWithFacets('earth.volcanoes', 'earth').map(add));
    expect(result).toMatchObject({
      kind: 'release',
      releaseId: 2,
      summary: { addedTopics: 1, addedFacets: 2, addedSystems: 0 },
    });
  });

  it('refuses a topic whose parent does not exist, is not a system or is retired', () => {
    expect(refusedWith(plan(topicWithFacets('nowhere.volcanoes', 'nowhere').map(add)))).toContain('parent_missing');
    expect(refusedWith(plan(topicWithFacets('earth.tides.volcanoes', 'earth.tides').map(add)))).toContain(
      'parent_kind',
    );
    const retired = plan([{ kind: 'retire', nodeId: 'earth' }]);
    if (retired.kind !== 'release') throw new Error('expected a release');
    expect(refusedWith(plan(topicWithFacets('earth.volcanoes', 'earth').map(add), retired.rows))).toContain(
      'parent_retired',
    );
  });

  it('refuses an id that is not under its parent, is not a slug or is already taken', () => {
    expect(refusedWith(plan(topicWithFacets('space.volcanoes', 'earth').map(add)))).toContain('id_not_under_parent');
    expect(refusedWith(plan(topicWithFacets('earth.Big_Volcano', 'earth').map(add)))).toContain('id_shape');
    expect(refusedWith(plan(topicWithFacets('earth.seasons', 'earth').map(add)))).toContain('id_taken');
  });

  it('refuses a second sibling whose normalised id or label is the same', () => {
    const lookalike = topicWithFacets('earth.sea-sons', 'earth');
    expect(refusedWith(plan(lookalike.map(add)))).toContain('id_duplicate');
    const sameLabel = [
      draft('earth.quakes', 'topic', 'earth', { label: 'SEASONS' }),
      ...topicWithFacets('earth.quakes', 'earth').slice(1),
    ];
    expect(refusedWith(plan(sameLabel.map(add)))).toContain('label_duplicate');
    // Two new siblings in one batch are compared with each other too.
    const twins = [...topicWithFacets('earth.ash', 'earth'), ...topicWithFacets('earth.a-sh', 'earth')];
    expect(refusedWith(plan(twins.map(add)))).toContain('id_duplicate');
  });

  it('compares a new system or topic with every system or topic of the catalogue, not only its siblings (#674)', () => {
    // A topic of another system whose normalised id or label is that of a topic that exists elsewhere.
    expect(refusedWith(plan(topicWithFacets('space.sea-sons', 'space').map(add)))).toContain('id_duplicate');
    const sameLabel = [
      draft('space.quakes', 'topic', 'space', { label: 'Seasons' }),
      ...topicWithFacets('space.quakes', 'space').slice(1),
    ];
    expect(refusedWith(plan(sameLabel.map(add)))).toContain('label_duplicate');
    // Likewise for systems.
    expect(refusedWith(plan([add(draft('e-arth', 'system', null))]))).toContain('id_duplicate');
    expect(refusedWith(plan([add(draft('terra', 'system', null, { label: 'EARTH' }))]))).toContain('label_duplicate');
    // Two new topics of different systems in one batch are compared with each other too.
    const twins = [...topicWithFacets('earth.ash', 'earth'), ...topicWithFacets('space.a-sh', 'space')];
    expect(refusedWith(plan(twins.map(add)))).toContain('id_duplicate');
  });

  it('lets facets repeat their labels across topics, as the seeded catalogue does with “Limits”', () => {
    const facets = [
      draft('space.quasars', 'topic', 'space', { label: 'Quasars' }),
      draft('space.quasars.limits', 'facet', 'space.quasars', { label: 'Limits' }),
      draft('space.quasars.light', 'facet', 'space.quasars', { label: 'Light' }),
    ];
    expect(plan(facets.map(add)).kind).toBe('release');
  });

  it('frees the names of a retired topic for a topic of another system, and keeps its id taken', () => {
    const retired = plan([{ kind: 'retire', nodeId: 'earth.seasons' }]);
    if (retired.kind !== 'release') throw new Error('expected a release');
    expect(plan(topicWithFacets('space.sea-sons', 'space').map(add), retired.rows).kind).toBe('release');
    expect(refusedWith(plan(topicWithFacets('earth.seasons', 'earth').map(add), retired.rows))).toContain('id_taken');
  });

  it('refuses a meaning that is too short, too long or carries an address or markup', () => {
    const [topic, ...facets] = topicWithFacets('earth.volcanoes', 'earth');
    const attempt = (meaning: string) => refusedWith(plan([add({ ...topic!, meaning }), ...facets.map(add)]));
    expect(attempt('Too short')).toContain('meaning_length');
    expect(attempt('x'.repeat(301))).toContain('meaning_length');
    expect(attempt('See https://example.com for the whole story of it.')).toContain('meaning_text');
    expect(attempt('A meaning with <b>markup</b> in the middle of it.')).toContain('meaning_text');
    expect(refusedWith(plan([add({ ...topic!, label: 'Bad <label>' }), ...facets.map(add)]))).toContain('label_shape');
    expect(refusedWith(plan([add({ ...topic!, label: 'x' }), ...facets.map(add)]))).toContain('label_shape');
  });

  it('needs at least two facets for a topic, and no more than sixteen', () => {
    expect(refusedWith(plan(topicWithFacets('earth.volcanoes', 'earth', ['one']).map(add)))).toContain(
      'topic_facet_count',
    );
    expect(refusedWith(plan(topicWithFacets('earth.volcanoes', 'earth', []).map(add)))).toContain('topic_facet_count');
    const many = Array.from({ length: 17 }, (_, at) => `angle-${String(at)}`);
    expect(refusedWith(plan(topicWithFacets('earth.volcanoes', 'earth', many).map(add)))).toContain(
      'topic_facet_count',
    );
    expect(plan(topicWithFacets('earth.volcanoes', 'earth', ['one', 'two']).map(add)).kind).toBe('release');
  });

  it('refuses the whole release when any one change is refused: nothing is half admitted', () => {
    const good = topicWithFacets('earth.volcanoes', 'earth').map(add);
    const bad = topicWithFacets('earth.seasons', 'earth').map(add);
    expect(plan([...good, ...bad]).kind).toBe('refused');
  });

  it('refuses a facet under a system and a system under a topic', () => {
    expect(refusedWith(plan([add(draft('earth.loose', 'facet', 'earth'))]))).toContain('parent_kind');
    expect(refusedWith(plan([add(draft('earth.tides.sub', 'system', 'earth.tides'))]))).toContain('parent_kind');
    expect(refusedWith(plan([add(draft('earthy', 'topic', null))]))).toContain('parent_kind');
  });

  it('assigns a new topic no visibility: it waits for released supply', () => {
    const result = plan(topicWithFacets('earth.volcanoes', 'earth').map(add));
    if (result.kind !== 'release') throw new Error('expected a release');
    expect(result.newNodes.find((node) => node.nodeId === 'earth.volcanoes')?.visibleIn).toBeNull();
    expect(result.newRevisions.find((revision) => revision.nodeId === 'earth.volcanoes')).toMatchObject({
      planetUnits: 3,
      planetFacets: 2,
    });
    expect(makeSnapshot(result.rows, canonicalSha256).concept('earth.volcanoes')?.servable).toBe(false);
  });
});

describe('revisions, visibility and retirement', () => {
  const coasts = nodesOfPlan(RELEASE_1_PLAN).find((node) => node.id === 'earth.tides.coasts')!;

  it('makes a no-change release nowhere: the same plan twice is one release', () => {
    expect(plan([]).kind).toBe('unchanged');
    expect(plan([{ kind: 'revise', draft: coasts }]).kind).toBe('unchanged');
  });

  it('declares a wording the same meaning only of the wording it replaces', () => {
    const reworded = {
      ...coasts,
      meaning: 'A reworded meaning for the coasts facet of tides.',
      sameMeaningAs: ['Something nobody wrote.'],
    };
    expect(refusedWith(plan([{ kind: 'revise', draft: reworded }]))).toContain('same_meaning_unknown');
    const fine = { ...reworded, sameMeaningAs: [coasts.meaning] };
    const result = plan([{ kind: 'revise', draft: fine }]);
    expect(result).toMatchObject({ kind: 'release', summary: { revised: 1, rewordedOnly: 1 } });
    if (result.kind !== 'release') return;
    expect(result.newRevisions[0]!.compatibleWith).toHaveLength(1);
    const semantic = plan([{ kind: 'revise', draft: { ...reworded, sameMeaningAs: [] } }]);
    if (semantic.kind !== 'release') throw new Error('expected a release');
    expect(semantic.newRevisions[0]!.compatibleWith).toEqual([]);
    expect(semantic.summary.rewordedOnly).toBe(0);
  });

  it('never changes a node’s identity, place, silhouette or haze', () => {
    const system = nodesOfPlan(RELEASE_1_PLAN).find((node) => node.id === 'earth')!;
    expect(refusedWith(plan([{ kind: 'revise', draft: { ...system, haze: 'pink' } }]))).toContain('look_changed');
    expect(refusedWith(plan([{ kind: 'revise', draft: { ...system, sceneFamily: 'ridged.v1' } }]))).toContain(
      'look_changed',
    );
    expect(refusedWith(plan([{ kind: 'revise', draft: { ...coasts, parentId: 'earth.seasons' } }]))).toContain(
      'identity_changed',
    );
    expect(refusedWith(plan([{ kind: 'revise', draft: { ...coasts, kind: 'topic' } }]))).toContain('identity_changed');
    expect(
      refusedWith(plan([{ kind: 'revise', draft: { ...coasts, id: 'earth.tides.nope', meaning: 'x'.repeat(40) } }])),
    ).toContain('node_missing');
  });

  it('shows a topic once, only a topic and never a retired one', () => {
    const added = plan(topicWithFacets('earth.volcanoes', 'earth').map(add));
    if (added.kind !== 'release') throw new Error('expected a release');
    const shown = plan([{ kind: 'show', nodeId: 'earth.volcanoes' }], added.rows);
    expect(shown).toMatchObject({ kind: 'release', releaseId: 3, summary: { shown: 1 } });
    if (shown.kind !== 'release') return;
    expect(refusedWith(plan([{ kind: 'show', nodeId: 'earth.volcanoes' }], shown.rows))).toContain('already_servable');
    expect(refusedWith(plan([{ kind: 'show', nodeId: 'earth' }], added.rows))).toContain('not_a_topic');
    expect(refusedWith(plan([{ kind: 'show', nodeId: 'earth.ghost' }], added.rows))).toContain('node_missing');
    expect(refusedWith(plan([{ kind: 'show', nodeId: 'earth.seasons' }]))).toContain('already_servable');
  });

  it('retires a node with what is under it, and refuses every merge: readers cannot be redirected yet', () => {
    const retired = plan([{ kind: 'retire', nodeId: 'earth.tides' }]);
    expect(retired).toMatchObject({ kind: 'release', summary: { retired: 4 } });
    // Even a well-formed merge (a topic into another topic of the same kind) is refused, and nothing is retired by it.
    for (const mergedInto of ['earth.seasons', 'earth', 'earth.tides'])
      expect(refusedWith(plan([{ kind: 'retire', nodeId: 'earth.tides', mergedInto }]))).toEqual(['merge_unsupported']);
  });

  it('never retires a facet alone: a stored place or certificate may name it', () => {
    expect(refusedWith(plan([{ kind: 'retire', nodeId: 'earth.tides.coasts' }]))).toContain('facet_retire');
  });

  it('changes the digest with every release, and leaves the seeded one alone', () => {
    const added = plan(topicWithFacets('earth.volcanoes', 'earth').map(add));
    if (added.kind !== 'release') throw new Error('expected a release');
    expect(added.digest).not.toBe(seedRows.digest);
    expect(makeSnapshot(seedRows, canonicalSha256).digest).toBe(seedRows.digest);
    const shown = plan([{ kind: 'show', nodeId: 'earth.volcanoes' }], added.rows);
    if (shown.kind !== 'release') throw new Error('expected a release');
    expect(shown.digest).not.toBe(added.digest);
  });
});

describe('importing the library plan', () => {
  const snapshot = makeSnapshot(seedRows, canonicalSha256);

  it('finds nothing to do when the catalogue already is the plan', () => {
    expect(changesToMatch(snapshot, nodesOfPlan(RELEASE_1_PLAN))).toEqual({ changes: [], missingFromPlan: [] });
  });

  it('adds a topic the plan gained, with its place after what exists, and nothing else', () => {
    const grown: LibrarySystem[] = RELEASE_1_PLAN.map((system) =>
      system.id === 'earth'
        ? {
            ...system,
            topics: [
              ...system.topics,
              {
                id: 'earth.volcanoes',
                meaning: 'How volcanoes build and reshape land.',
                facets: [
                  { id: 'earth.volcanoes.magma', meaning: 'Magma rises through the crust and erupts.' },
                  { id: 'earth.volcanoes.plates', meaning: 'Plate boundaries decide where volcanoes form.' },
                ],
              },
            ],
          }
        : system,
    );
    const { changes } = changesToMatch(snapshot, nodesOfPlan(grown));
    expect(changes.map((change) => (change.kind === 'add' ? change.draft.id : 'other'))).toEqual([
      'earth.volcanoes',
      'earth.volcanoes.magma',
      'earth.volcanoes.plates',
    ]);
    const result = plan(changes);
    if (result.kind !== 'release') throw new Error('expected a release');
    expect(result.newNodes.map((node) => node.seq)).toEqual([77, 78, 79]);
    // Importing it again, from the release it made, is nothing to do.
    expect(changesToMatch(makeSnapshot(result.rows, canonicalSha256), nodesOfPlan(grown)).changes).toEqual([]);
  });

  it('reports a node the plan no longer names and does not retire it', () => {
    const smaller: LibrarySystem[] = RELEASE_1_PLAN.map((system) =>
      system.id === 'history' ? { ...system, topics: [] } : system,
    );
    const { changes, missingFromPlan } = changesToMatch(snapshot, nodesOfPlan(smaller));
    expect(changes).toEqual([]);
    expect(missingFromPlan).toContain('history.industrial-revolution');
  });

  it('turns an edited meaning into a revision, and a declared rewording into one that keeps certificates', () => {
    const edited = (sameMeaningAs: boolean): LibrarySystem[] =>
      RELEASE_1_PLAN.map((system) => ({
        ...system,
        topics: system.topics.map((topic) =>
          topic.id === 'earth.tides'
            ? {
                ...topic,
                meaning: 'Ocean tides rise and fall under gravity and local conditions.',
                ...(sameMeaningAs ? { sameMeaningAs: [topic.meaning] } : {}),
              }
            : topic,
        ),
      }));
    const reworded = changesToMatch(snapshot, nodesOfPlan(edited(true)));
    expect(reworded.changes.map((change) => change.kind)).toEqual(['revise']);
    expect(plan(reworded.changes)).toMatchObject({ kind: 'release', summary: { rewordedOnly: 1 } });
    expect(plan(changesToMatch(snapshot, nodesOfPlan(edited(false))).changes)).toMatchObject({
      kind: 'release',
      summary: { revised: 1, rewordedOnly: 0 },
    });
  });
});

describe('the look of a new system', () => {
  it('is assigned from its id when the plan names none: stable, and repeats are allowed past six systems', () => {
    expect(assignedHaze('geology')).toBe(assignedHaze('geology'));
    const hazes = new Set<HazeFamilyName>(Array.from({ length: 40 }, (_, at) => assignedHaze(`system-${String(at)}`)));
    expect(hazes.size).toBeGreaterThan(1);
    expect(hazes.size).toBeLessThanOrEqual(6);
    const bare: LibrarySystem = {
      id: 'geology',
      meaning: 'The solid Earth and how it changes over deep time.',
      topics: [],
    };
    const [system] = nodesOfPlan([bare]);
    expect(system).toMatchObject({ haze: assignedHaze('geology'), kind: 'system' });
    expect(system!.sceneFamily).not.toBeNull();
  });
});

describe('a catalogue of ten thousand topics', () => {
  it('is planned, read and listed without any step reading the whole catalogue to find a few nodes (a quadratic step would not finish)', () => {
    const topics = 10_000;
    const drafts: NodeDraft[] = [];
    for (let n = 0; n < topics; n += 1) {
      const id = `earth.topic-${String(n)}`;
      drafts.push(
        draft(id, 'topic', 'earth', {
          label: `Topic number ${String(n)}`,
          meaning: `A meaning for topic number ${String(n)}, long enough to pass.`,
        }),
        draft(`${id}.one`, 'facet', id, { label: 'One' }),
        draft(`${id}.two`, 'facet', id, { label: 'Two' }),
        draft(`${id}.three`, 'facet', id, { label: 'Three' }),
      );
    }
    // The limit of one release is twenty thousand changes: ten thousand topics with their facets are two releases.
    const first = plan(drafts.slice(0, 20_000).map(add));
    if (first.kind !== 'release') throw new Error(`expected a release, got ${first.kind}`);
    const second = plan(drafts.slice(20_000).map(add), first.rows);
    if (second.kind !== 'release') throw new Error(`expected a release, got ${second.kind}`);
    const snapshot = makeSnapshot(second.rows, canonicalSha256);
    expect(snapshot.allTopics()).toHaveLength(RELEASE_1_COUNTS.topics + topics);
    expect(snapshot.slice(['earth.topic-9999', 'earth.topic-5', 'earth']).map((entry) => entry.id)).toEqual([
      'earth',
      'earth.topic-5',
      'earth.topic-9999',
    ]);
    expect(snapshot.concept('earth.topic-77')?.facets).toHaveLength(3);
  }, 60_000);
});
