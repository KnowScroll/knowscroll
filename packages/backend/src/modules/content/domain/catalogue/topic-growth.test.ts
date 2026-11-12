import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { LIBRARY_SYSTEMS } from '../library/index.js';
import { planRelease } from './release.js';
import { seedRelease, seedSnapshot } from './seed.js';
import { makeSnapshot } from './snapshot.js';
import {
  TOPIC_GROWTH_POLICY,
  TOPIC_REFUSALS,
  TopicProposalOutputSchema,
  admitTopicProposal,
  candidateVerdict,
  cleanTitle,
  duplicatesTopic,
  leadPassages,
  offeredSystems,
  seedLinkVerdict,
  slugOfLabel,
  titleVerdict,
  urlTitleOf,
  type TopicAdmissionContext,
  type TopicProposalOutput,
} from './topic-growth.js';

const seeded = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);
const SYSTEM = 'earth';

/** A page of invented prose: each paragraph is its own passage and every quote below is a stretch of one. */
const PASSAGES = [
  'The invented moon Orrin carries two small seas, and each of them rises and falls twice during one lunar day.',
  'Orrin holds one face toward its planet, because the pull of the planet locked its spin over very long ages.',
  'In a narrow bay on Orrin the incoming water is squeezed into a smaller space, so the sea climbs higher there.',
  'Sailors of Orrin learned to read the two high waters and the two low waters, and they kept a calendar by them.',
  'The pull of the second moon adds to the first at the new moon and the full moon, which makes the highest seas.',
] as const;
const QUOTES = [
  'each of them rises and falls twice during one lunar day',
  'the pull of the planet locked its spin over very long ages',
  'the incoming water is squeezed into a smaller space',
  'Sailors of Orrin learned to read the two high waters',
] as const;

const proposal = (overrides: Partial<TopicProposalOutput['topics'][number]> = {}): TopicProposalOutput => ({
  topics: [
    {
      systemId: SYSTEM,
      label: 'Moon seas',
      meaning: 'How the seas of a small moon rise and fall under the pull of its planet and its neighbour.',
      facets: [
        {
          label: 'Daily rhythm',
          meaning: 'How often the sea of a moon rises and falls in one day of the moon.',
          quote: QUOTES[0],
        },
        {
          label: 'Locked face',
          meaning: 'Why a moon keeps one face turned to its planet.',
          quote: QUOTES[1],
        },
        {
          label: 'Narrow bays',
          meaning: 'Why the water climbs higher where a bay narrows.',
          quote: QUOTES[2],
        },
      ],
      ...overrides,
    },
  ],
});

const context = (overrides: Partial<TopicAdmissionContext> = {}): TopicAdmissionContext => ({
  snapshot: seeded,
  offered: [SYSTEM],
  maxTopicsPerSystem: 12,
  passages: PASSAGES,
  ...overrides,
});

describe('what a title and a first paragraph show of a page', () => {
  it('cleans the site off a title and reads the title an address names', () => {
    expect(cleanTitle('Heart valve - Wikipedia')).toBe('Heart valve');
    expect(cleanTitle('Spring tide')).toBe('Spring tide');
    expect(cleanTitle('  Cause-and-effect  ')).toBe('Cause-and-effect');
    expect(urlTitleOf('https://en.wikipedia.org/wiki/Heart_valve')).toBe('Heart valve');
    expect(urlTitleOf('https://en.wikipedia.org/wiki/Heart_(disambiguation)')).toBe('Heart (disambiguation)');
    expect(urlTitleOf('https://science.nasa.gov/')).toBeUndefined();
  });

  it('refuses a namespace page, a disambiguation and a list by their titles, and an ordinary article by none', () => {
    expect(titleVerdict('Category:Tides')).toBe('not_an_article');
    expect(titleVerdict('Template:Infobox')).toBe('not_an_article');
    expect(titleVerdict('Tide (disambiguation)')).toBe('disambiguation');
    expect(titleVerdict('List of tidal power stations')).toBe('list_page');
    expect(titleVerdict('Timeline of the Moon')).toBe('list_page');
    expect(titleVerdict('Glossary of oceanography')).toBe('list_page');
    expect(titleVerdict('Heart valve')).toBeUndefined();
    // A colon in the middle of an ordinary title is not a namespace.
    expect(titleVerdict('Star Wars: The Force Awakens')).toBeUndefined();
    expect(seedLinkVerdict('https://en.wikipedia.org/wiki/List_of_oceans')).toBe('list_page');
    expect(seedLinkVerdict('https://en.wikipedia.org/wiki/Category:Tides')).toBe('not_an_article');
    expect(seedLinkVerdict('https://en.wikipedia.org/wiki/Heart_valve')).toBe('ok');
  });

  it('finds a topic again by the words of its label, not by an id, a prefix or a substring', () => {
    const labels = seeded.allTopics().map((topic) => topic.label);
    expect(labels).toContain('Tides');
    expect(duplicatesTopic('Tide', labels)).toBe(true);
    expect(duplicatesTopic('Tides', labels)).toBe(true);
    expect(duplicatesTopic('Heart valve', labels)).toBe(false);
    expect(duplicatesTopic('Tidal force', labels)).toBe(false);
    expect(duplicatesTopic('', labels)).toBe(false);
  });

  it('decides a read page by the first filter it fails: title, lead, length, then an existing topic', () => {
    const labels = seeded.allTopics().map((topic) => topic.label);
    const ordinary = { title: 'Heart valve', lead: 'A heart valve lets blood flow one way.', evidencePassages: 20 };
    expect(candidateVerdict(ordinary, labels)).toEqual({ kind: 'eligible' });
    expect(candidateVerdict({ ...ordinary, title: 'Valve (disambiguation)' }, labels)).toEqual({
      kind: 'rejected',
      code: 'disambiguation',
    });
    expect(candidateVerdict({ ...ordinary, lead: 'Valve may refer to:' }, labels)).toEqual({
      kind: 'rejected',
      code: 'disambiguation',
    });
    expect(candidateVerdict({ ...ordinary, lead: 'This is a list of heart valves.' }, labels)).toEqual({
      kind: 'rejected',
      code: 'list_page',
    });
    expect(candidateVerdict({ ...ordinary, title: 'List of valves' }, labels)).toEqual({
      kind: 'rejected',
      code: 'list_page',
    });
    expect(candidateVerdict({ ...ordinary, evidencePassages: 7 }, labels)).toEqual({ kind: 'rejected', code: 'stub' });
    expect(
      candidateVerdict({ ...ordinary, evidencePassages: TOPIC_GROWTH_POLICY.minEvidencePassages }, labels).kind,
    ).toBe('eligible');
    expect(candidateVerdict({ ...ordinary, title: 'Tide' }, labels)).toEqual({
      kind: 'rejected',
      code: 'duplicate_topic',
    });
    // A title filter comes before the length one.
    expect(candidateVerdict({ ...ordinary, title: 'Category:Valves', evidencePassages: 1 }, labels)).toEqual({
      kind: 'rejected',
      code: 'not_an_article',
    });
  });
});

describe('the systems a model is offered', () => {
  it('are all the systems with room while there are few, and a bounded best-matching few when there are many', () => {
    expect(offeredSystems(seeded, 'anything at all', 12).map((system) => system.id)).toEqual(
      seeded
        .all()
        .filter((concept) => concept.kind === 'system')
        .map((concept) => concept.id),
    );
    const earth = offeredSystems(seeded, 'tide', 12).find((system) => system.id === 'earth')!;
    expect(earth.topics).toBeGreaterThan(0);
    expect(earth.topicLabels).toContain('Tides');
    expect(earth.topicLabels.length).toBeLessThanOrEqual(TOPIC_GROWTH_POLICY.topicsListedPerSystem);

    // Twenty invented systems: only twelve are offered, the ones that share words with the page, and none that share none.
    const drafts = Array.from({ length: 20 }, (_, n) => {
      const id = `sys${String.fromCharCode(97 + n)}`;
      return [
        {
          kind: 'add' as const,
          draft: {
            id,
            kind: 'system' as const,
            parentId: null,
            label: `Realm ${String(n)} of ${n < 15 ? 'zeppelin' : 'nothing'}`,
            meaning: `The realm ${String(n)} holds ${n < 15 ? 'zeppelin' : 'nothing'} matters of its own kind.`,
            sceneFamily: 'ridged.v1' as const,
            haze: 'pink' as const,
            sameMeaningAs: [],
          },
        },
      ];
    }).flat();
    const planned = planRelease(seedRelease(LIBRARY_SYSTEMS, canonicalSha256).rows, drafts, canonicalSha256);
    if (planned.kind !== 'release') throw new Error('expected a release');
    const large = makeSnapshot(planned.rows, canonicalSha256);
    const offered = offeredSystems(large, 'a zeppelin over the sea', 12);
    expect(offered).toHaveLength(12);
    expect(offered.every((system) => /zeppelin/u.test(system.label))).toBe(true);
    expect(offeredSystems(large, 'wholly unrelated words here', 12)).toEqual([]);
  });

  it('leaves out a system that has no room under the size limit, whatever the page says', () => {
    const topicsOfEarth = seeded.allTopics().filter((topic) => topic.parent === 'earth').length;
    expect(topicsOfEarth).toBeGreaterThan(0);
    expect(offeredSystems(seeded, 'tide', topicsOfEarth).map((system) => system.id)).not.toContain('earth');
    expect(offeredSystems(seeded, 'tide', topicsOfEarth + 1).map((system) => system.id)).toContain('earth');
  });

  it('gives the model the lead of a page within a bound, each passage cut at a word', () => {
    const long = `${'word '.repeat(300)}end`;
    const lead = leadPassages([long, ...PASSAGES]);
    expect(lead.length).toBeGreaterThan(0);
    expect(lead[0]!.length).toBeLessThanOrEqual(TOPIC_GROWTH_POLICY.leadPassageChars);
    expect(lead.join('').length).toBeLessThanOrEqual(TOPIC_GROWTH_POLICY.leadChars);
    expect(leadPassages(Array.from({ length: 30 }, () => 'a passage '.repeat(10))).length).toBeLessThanOrEqual(
      TOPIC_GROWTH_POLICY.leadPassages,
    );
  });
});

describe('the proposal role’s answer', () => {
  it('is one topic or none, with three to five facets each quoting a passage, and nothing else', () => {
    expect(TopicProposalOutputSchema.safeParse(proposal()).success).toBe(true);
    expect(TopicProposalOutputSchema.safeParse({ topics: [] }).success).toBe(true);
    const only = proposal().topics[0]!;
    expect(TopicProposalOutputSchema.safeParse({ topics: [only, only] }).success).toBe(false);
    expect(
      TopicProposalOutputSchema.safeParse({ topics: [{ ...only, facets: only.facets.slice(0, 2) }] }).success,
    ).toBe(false);
    expect(
      TopicProposalOutputSchema.safeParse({
        topics: [{ ...only, facets: [...only.facets, ...only.facets] }],
      }).success,
    ).toBe(false);
    expect(TopicProposalOutputSchema.safeParse({ topics: [{ ...only, extra: 1 }] }).success).toBe(false);
    expect(TopicProposalOutputSchema.safeParse({ topics: [{ ...only, id: 'earth.moon-seas' }] }).success).toBe(false);
    const noQuote = { ...only, facets: only.facets.map((facet) => ({ label: facet.label, meaning: facet.meaning })) };
    expect(TopicProposalOutputSchema.safeParse({ topics: [noQuote] }).success).toBe(false);
  });
});

describe('admission of a proposal, by code', () => {
  it('admits a topic with its facets under an offered system, ids derived from its words, none of it servable', () => {
    const verdict = admitTopicProposal(proposal(), context());
    expect(verdict).toMatchObject({
      kind: 'admitted',
      systemId: 'earth',
      topicId: 'earth.moon-seas',
      facetIds: ['earth.moon-seas.daily-rhythm', 'earth.moon-seas.locked-face', 'earth.moon-seas.narrow-bays'],
    });
    if (verdict.kind !== 'admitted') return;
    expect(verdict.changes.map((change) => (change.kind === 'add' ? change.draft.kind : change.kind))).toEqual([
      'topic',
      'facet',
      'facet',
      'facet',
    ]);
    // The catalogue's own admission accepts it, and the new topic waits for supply.
    const release = planRelease(seedRelease(LIBRARY_SYSTEMS, canonicalSha256).rows, verdict.changes, canonicalSha256);
    expect(release).toMatchObject({ kind: 'release', releaseId: 2, summary: { addedTopics: 1, addedFacets: 3 } });
    if (release.kind !== 'release') return;
    const next = makeSnapshot(release.rows, canonicalSha256);
    expect(next.concept('earth.moon-seas')).toMatchObject({ parent: 'earth', servable: false });
    expect(next.topics().some((topic) => topic.id === 'earth.moon-seas')).toBe(false);
  });

  it('says so when the model found no fit', () => {
    expect(admitTopicProposal({ topics: [] }, context())).toEqual({ kind: 'declined' });
  });

  const refusal = (output: TopicProposalOutput, overrides: Partial<TopicAdmissionContext> = {}) => {
    const verdict = admitTopicProposal(output, context(overrides));
    return verdict.kind === 'refused' ? verdict.code : verdict.kind;
  };
  const first = proposal().topics[0]!;
  const withFacets = (facets: typeof first.facets) => proposal({ facets });

  it('refuses a system that does not exist, one that was not offered, and one with no room', () => {
    expect(refusal(proposal({ systemId: 'oceans' }))).toBe('system_unknown');
    expect(refusal(proposal({ systemId: 'earth.tides' }))).toBe('system_unknown');
    expect(refusal(proposal({ systemId: 'space' }))).toBe('system_not_offered');
    const full = seeded.allTopics().filter((topic) => topic.parent === 'earth').length;
    expect(refusal(proposal(), { maxTopicsPerSystem: full })).toBe('system_full');
    expect(refusal(proposal(), { maxTopicsPerSystem: full + 1 })).toBe('admitted');
  });

  it('refuses a label or a meaning with an address or markup, and a label that makes no id', () => {
    expect(refusal(proposal({ meaning: 'See https://example.org for how the seas of a small moon behave.' }))).toBe(
      'text_has_address',
    );
    expect(
      refusal(proposal({ meaning: 'How the seas of a small moon behave, found at en.wikipedia.org/wiki/Tide.' })),
    ).toBe('text_has_address');
    expect(refusal(proposal({ label: 'Moon <b>seas</b>' }))).toBe('text_has_markup');
    expect(
      refusal(withFacets(first.facets.map((f, at) => (at === 0 ? { ...f, meaning: 'A [link](x) to nothing.' } : f)))),
    ).toBe('text_has_markup');
    expect(refusal(proposal({ label: '潮汐' }))).toBe('label_unsluggable');
    expect(refusal(proposal({ label: '9 moons' }))).toBe('label_unsluggable');
    expect(refusal(withFacets(first.facets.map((f, at) => (at === 1 ? { ...f, label: '???' } : f))))).toBe(
      'facet_label_unsluggable',
    );
  });

  it('refuses an id or a label an existing topic has, in any status, and a label that is one again in other words', () => {
    expect(refusal(proposal({ label: 'Tides' }))).toBe('id_collision');
    expect(refusal(proposal({ label: 'tides' }))).toBe('id_collision');
    // Another system's topic of the same label is still the same topic.
    const label =
      seeded.concept('space')!.kind === 'system' ? seeded.allTopics().find((t) => t.parent === 'space')!.label : '';
    expect(label).not.toBe('');
    expect(refusal(proposal({ label }))).toBe('label_collision');
    expect(refusal(proposal({ label: 'The tide' }))).toBe('duplicate_topic');
  });

  it('refuses facets that repeat a label, and fewer than three', () => {
    expect(refusal(withFacets(first.facets.map((f, at) => (at === 2 ? { ...f, label: 'Daily  rhythm!' } : f))))).toBe(
      'facet_duplicate',
    );
    // The schema forbids fewer than three; admission holds the same line for a caller that did not parse.
    expect(refusal({ topics: [{ ...first, facets: first.facets.slice(0, 2) }] })).toBe('facets_too_few');
  });

  it('refuses a facet whose quote is not in the page, and two facets that quote the same stretch', () => {
    expect(
      refusal(
        withFacets(
          first.facets.map((f, at) =>
            at === 1 ? { ...f, quote: 'The invented moon Orrin is made of cheese entirely.' } : f,
          ),
        ),
      ),
    ).toBe('quote_not_in_page');
    // Whitespace is not a difference.
    expect(
      refusal(
        withFacets(
          first.facets.map((f, at) =>
            at === 0 ? { ...f, quote: `  ${QUOTES[0].replace(' rises ', '\n rises ')}  ` } : f,
          ),
        ),
      ),
    ).toBe('admitted');
    expect(refusal(withFacets(first.facets.map((f, at) => (at === 2 ? { ...f, quote: QUOTES[0] } : f))))).toBe(
      'quote_repeated',
    );
    // A quote inside another one is the same stretch said shorter.
    expect(
      refusal(
        withFacets(
          first.facets.map((f, at) =>
            at === 2 ? { ...f, quote: 'each of them rises and falls twice during one lunar day, and each' } : f,
          ),
        ),
        { passages: [...PASSAGES, `${PASSAGES[0]} ${QUOTES[0]}, and each of them`] },
      ),
    ).toBe('quote_repeated');
    // A quote is read against the page's own passages only.
    expect(refusal(proposal(), { passages: [] })).toBe('quote_not_in_page');
  });

  it('names every refusal it can make', () => {
    // A small guard that the codes a test above relies on are the codes the step documents.
    for (const code of [
      'system_unknown',
      'system_not_offered',
      'system_full',
      'text_has_address',
      'text_has_markup',
      'label_unsluggable',
      'label_collision',
      'id_collision',
      'duplicate_topic',
      'facet_duplicate',
      'quote_not_in_page',
      'quote_repeated',
    ] as const)
      expect(TOPIC_REFUSALS).toContain(code);
  });
});

describe('ids made from labels', () => {
  it('are lower-case ASCII words joined by hyphens that start with a letter, or none', () => {
    expect(slugOfLabel('Moon seas')).toBe('moon-seas');
    expect(slugOfLabel('  Café  au lait! ')).toBe('cafe-au-lait');
    expect(slugOfLabel('Rock & roll, 2nd wave')).toBe('rock-roll-2nd-wave');
    expect(slugOfLabel('7 wonders')).toBeUndefined();
    expect(slugOfLabel('---')).toBeUndefined();
    expect(slugOfLabel('x'.repeat(61))).toBeUndefined();
    expect(slugOfLabel('x'.repeat(60))).toBe('x'.repeat(60));
  });
});
