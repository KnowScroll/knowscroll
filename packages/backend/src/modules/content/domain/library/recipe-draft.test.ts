import { describe, expect, it } from 'vitest';
import {
  BRIEF_OVERLAP_LIMIT,
  checkRecipeDraft,
  overlapOf,
  RecipeBriefOutputSchema,
  sentencesOf,
  tokensOf,
  type DraftCheckContext,
  type RecipeDraft,
} from './recipe-draft.js';

const TOPIC = 'human.heart';
const FACET = 'human.heart.mechanism';
const PAGE_A = 'https://en.wikipedia.org/wiki/Heart';
const PAGE_B = 'https://en.wikipedia.org/wiki/Heart_valve';

const draft: RecipeDraft = {
  title: 'How heart valves keep blood moving one way',
  facetId: FACET,
  brief:
    'Explain how the four heart valves open and close with each beat so blood flows forward and never back. Ask only for what the pages say about the valves and their timing. Do not turn the explanation into medical advice.',
  pages: [PAGE_A, PAGE_B],
};

const context = (over: Partial<DraftCheckContext> = {}): DraftCheckContext => ({
  topicId: TOPIC,
  facetIds: [FACET, 'human.heart.limits', 'human.heart.example'],
  candidates: [
    { url: PAGE_A, passages: 20 },
    { url: PAGE_B, passages: 14 },
    { url: 'https://en.wikipedia.org/wiki/Blood', passages: 3 },
  ],
  urlAllowed: () => true,
  existing: [
    {
      title: 'Why the heart beats',
      brief:
        'Explain what makes the heart beat on its own: the pacemaker cells and the electrical signal. Do not claim a person can feel it.',
    },
  ],
  taken: { keys: new Set(), unitIds: new Set(), assetIds: new Set() },
  identity: { key: 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d', assetId: 'e0a7e0a7-0000-4000-8000-000000000001' },
  ...over,
});

const refusalOf = (d: RecipeDraft, c: DraftCheckContext) => {
  const verdict = checkRecipeDraft(d, c);
  return verdict.kind === 'refused' ? verdict.code : verdict.kind;
};

describe('checkRecipeDraft: what code accepts of a model proposal', () => {
  it('accepts a draft that meets every rule and derives its identity from its key', () => {
    const verdict = checkRecipeDraft(draft, context());
    expect(verdict.kind).toBe('accepted');
    if (verdict.kind !== 'accepted') return;
    expect(verdict.recipe).toMatchObject({
      key: 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d',
      explanationUnitId: 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d-v1',
      assetId: 'e0a7e0a7-0000-4000-8000-000000000001',
      topicId: TOPIC,
      facetId: FACET,
      pages: [PAGE_A, PAGE_B],
      checks: { pool: 34 },
    });
  });

  it('refuses a facet the planet does not have', () => {
    expect(refusalOf({ ...draft, facetId: 'human.heart.invented' }, context())).toBe('facet_unknown');
    expect(refusalOf({ ...draft, facetId: 'human.lungs.mechanism' }, context())).toBe('facet_unknown');
  });

  it('refuses a draft for another facet than the one the operator asked to cover', () => {
    const asked = context({ requestedFacetId: 'human.heart.limits' });
    expect(refusalOf(draft, asked)).toBe('facet_not_requested');
    expect(refusalOf({ ...draft, facetId: 'human.heart.limits' }, asked)).toBe('accepted');
  });

  it('refuses a title or a brief that is not one plain line of the right size', () => {
    expect(refusalOf({ ...draft, title: ` ${draft.title}` }, context())).toBe('title_shape');
    expect(refusalOf({ ...draft, title: `${draft.title}\nsecond line` }, context())).toBe('title_shape');
    expect(refusalOf({ ...draft, brief: `${draft.brief}\u0000` }, context())).toBe('brief_shape');
    const oneSentence =
      'Explain how the four heart valves open and close with each beat so blood flows forward and never back.';
    expect(refusalOf({ ...draft, brief: oneSentence }, context())).toBe('brief_shape');
    const five = `${oneSentence} Name the valves. Keep it plain. Skip the surgery. Stay with the pages.`;
    expect(sentencesOf(five)).toHaveLength(5);
    expect(refusalOf({ ...draft, brief: five }, context())).toBe('brief_shape');
  });

  it('refuses a brief that names a block of a Scroll', () => {
    const brief = `${draft.brief} Add a diagram of the valves.`;
    expect(refusalOf({ ...draft, brief }, context())).toBe('brief_names_block');
    expect(refusalOf({ ...draft, brief: draft.brief.replace('Do not', 'Include a quiz. Do not') }, context())).toBe(
      'brief_names_block',
    );
  });

  it('refuses a page that is not one of the candidates, even a real address', () => {
    expect(refusalOf({ ...draft, pages: [PAGE_A, 'https://en.wikipedia.org/wiki/Something_else'] }, context())).toBe(
      'page_not_candidate',
    );
  });

  it('refuses a candidate the research URL rule refuses', () => {
    const allowed = (url: string) => url !== PAGE_B;
    expect(refusalOf(draft, context({ urlAllowed: allowed }))).toBe('page_refused');
  });

  it('refuses the same page twice', () => {
    expect(refusalOf({ ...draft, pages: [PAGE_A, PAGE_A] }, context())).toBe('pages_duplicate');
  });

  it('refuses a pool of passages the source checker would refuse: too few, or at the writer limit', () => {
    const small = context({
      candidates: [
        { url: PAGE_A, passages: 3 },
        { url: PAGE_B, passages: 2 },
      ],
    });
    expect(refusalOf(draft, small)).toBe('pool_out_of_range');
    const big = context({
      candidates: [
        { url: PAGE_A, passages: 40 },
        { url: PAGE_B, passages: 24 },
      ],
    });
    expect(refusalOf(draft, big)).toBe('pool_out_of_range');
    const edges = context({
      candidates: [
        { url: PAGE_A, passages: 6 },
        { url: PAGE_B, passages: 0 },
      ],
    });
    expect(refusalOf(draft, edges)).toBe('accepted');
    const top = context({
      candidates: [
        { url: PAGE_A, passages: 63 },
        { url: PAGE_B, passages: 0 },
      ],
    });
    expect(refusalOf(draft, top)).toBe('accepted');
  });

  it('refuses a near-duplicate of an existing recipe of the planet, by its brief or by its title', () => {
    const existing = [{ title: 'Heart valves and blood flow', brief: draft.brief.replace('Ask only for', 'Ask for') }];
    expect(refusalOf(draft, context({ existing }))).toBe('near_duplicate');
    const sameTitle = [
      {
        title: draft.title.toUpperCase(),
        brief: 'Something quite different about electrical signals and pacemaker cells.',
      },
    ];
    expect(refusalOf(draft, context({ existing: sameTitle }))).toBe('near_duplicate');
  });

  it('accepts a draft about a different part of the same planet', () => {
    const other = {
      title: 'What makes the heart beat on its own',
      brief:
        'Explain the pacemaker cells, the electrical signal that starts each beat and how it spreads through the muscle. Ask only for what the pages say. Do not describe how to treat a rhythm problem.',
    };
    expect(refusalOf(draft, context({ existing: [other] }))).toBe('accepted');
  });

  it('refuses a draft whose derived key, explanation unit or asset is already taken', () => {
    const key = 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d';
    expect(
      refusalOf(draft, context({ taken: { keys: new Set([key]), unitIds: new Set(), assetIds: new Set() } })),
    ).toBe('identity_taken');
    expect(
      refusalOf(draft, context({ taken: { keys: new Set(), unitIds: new Set([`${key}-v1`]), assetIds: new Set() } })),
    ).toBe('identity_taken');
    expect(
      refusalOf(
        draft,
        context({
          taken: { keys: new Set(), unitIds: new Set(), assetIds: new Set(['e0a7e0a7-0000-4000-8000-000000000001']) },
        }),
      ),
    ).toBe('identity_taken');
  });
});

describe('overlap of two texts', () => {
  it('is 1 for the same words in another order and 0 for texts with nothing in common', () => {
    expect(overlapOf('heart valves open and close', 'close and open heart valves')).toBe(1);
    expect(overlapOf('heart valves', 'granite quarry')).toBe(0);
    expect(overlapOf('', 'heart valves')).toBe(0);
  });

  it('treats a plural and a verb ending as the same word', () => {
    expect([...tokensOf('valves pumping')].sort()).toEqual([...tokensOf('valve pump')].sort());
  });

  it('keeps the brief limit between a related and a repeated brief', () => {
    expect(BRIEF_OVERLAP_LIMIT).toBeGreaterThan(0.3);
    expect(BRIEF_OVERLAP_LIMIT).toBeLessThan(0.8);
  });
});

describe('the strict shape of the brief role answer', () => {
  it('accepts up to three drafts or none and refuses extra keys and more drafts', () => {
    expect(RecipeBriefOutputSchema.safeParse({ drafts: [] }).success).toBe(true);
    expect(RecipeBriefOutputSchema.safeParse({ drafts: [draft] }).success).toBe(true);
    expect(RecipeBriefOutputSchema.safeParse({ drafts: [draft, draft, draft, draft] }).success).toBe(false);
    expect(RecipeBriefOutputSchema.safeParse({ drafts: [{ ...draft, extra: 1 }] }).success).toBe(false);
    expect(RecipeBriefOutputSchema.safeParse({ drafts: [{ ...draft, pages: [] }] }).success).toBe(false);
    expect(
      RecipeBriefOutputSchema.safeParse({
        drafts: [{ ...draft, pages: [PAGE_A, PAGE_B, 'https://x.y/z', 'https://x.y/w'] }],
      }).success,
    ).toBe(false);
    expect(RecipeBriefOutputSchema.safeParse({ drafts: [], other: true }).success).toBe(false);
  });
});
