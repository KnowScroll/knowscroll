import { describe, expect, it } from 'vitest';
import {
  MAX_LISTED_PAGES,
  MAX_PROPOSAL_RETRY,
  MAX_LISTED_RECIPES,
  oneLineBriefOf,
  recipeBriefContext,
  recipeBriefRequestKey,
  recipeBriefRole,
  RECIPE_BRIEF_ROLE_VERSION,
  utcDayOf,
  type RecipeBriefFacts,
} from './recipe-brief.js';

const facts: RecipeBriefFacts = {
  topicId: 'human.heart',
  meaning: 'How the heart pumps blood around the body.',
  facets: [
    { id: 'human.heart.mechanism', meaning: 'How it works.', recipes: 2 },
    { id: 'human.heart.limits', meaning: 'What the explanation leaves out.', recipes: 0 },
  ],
  existing: [
    {
      facetId: 'human.heart.mechanism',
      title: 'Why the heart beats',
      brief: 'Explain the pacemaker cells. Ask only for what the pages say. Do not give advice.',
    },
  ],
  candidates: [
    {
      url: 'https://en.wikipedia.org/wiki/Heart',
      title: 'Heart',
      passages: 20,
      excerpt: 'The heart is a muscular organ.',
    },
  ],
};

describe('the frozen context of a recipe proposal', () => {
  it('is built from facts alone: the same facts give the same items', () => {
    const a = recipeBriefContext(facts);
    expect(recipeBriefContext({ ...facts })).toEqual(a);
    expect(a.map((item) => item.kind)).toEqual(['planet', 'facets', 'target', 'existing_recipes', 'candidate_page']);
  });

  it('lists the facets with how many recipes each has, the existing recipes by title and one line, and each candidate page', () => {
    const items = recipeBriefContext(facts);
    expect(items[1]?.text).toContain('human.heart.limits (0 recipes)');
    expect(items[3]?.text).toBe('[human.heart.mechanism] Why the heart beats: Explain the pacemaker cells.');
    expect(items[4]?.text).toContain('https://en.wikipedia.org/wiki/Heart');
    expect(items[4]?.text).toContain('passages: 20');
  });

  it('names the target facet, or tells the model to prefer a facet with few recipes', () => {
    expect(recipeBriefContext({ ...facts, targetFacetId: 'human.heart.limits' })[2]?.text).toBe(
      'Every draft is for the facet human.heart.limits.',
    );
    expect(recipeBriefContext(facts)[2]?.text).toContain('few recipes');
  });

  it('names a request by planet, facet, UTC day, retry and role version, and by nothing a proposal goes on to change', () => {
    const base = recipeBriefRequestKey({ topicId: 'human.heart', day: '2026-11-11', retry: 0 });
    expect(recipeBriefRequestKey({ topicId: 'human.heart', day: '2026-11-11', retry: 0 })).toBe(base);
    expect(base).toContain(RECIPE_BRIEF_ROLE_VERSION);
    expect(recipeBriefRequestKey({ topicId: 'human.heart', day: '2026-11-12', retry: 0 })).not.toBe(base);
    expect(recipeBriefRequestKey({ topicId: 'human.heart', day: '2026-11-11', retry: 1 })).not.toBe(base);
    expect(
      recipeBriefRequestKey({ topicId: 'human.heart', facetId: 'human.heart.limits', day: '2026-11-11', retry: 0 }),
    ).not.toBe(base);
    expect(recipeBriefRequestKey({ topicId: 'human.blood', day: '2026-11-11', retry: 0 })).not.toBe(base);
    expect(utcDayOf(new Date('2026-11-11T23:59:59Z'))).toBe('2026-11-11');
    expect(MAX_PROPOSAL_RETRY).toBe(2);
  });

  it('is bounded: only so many recipes and pages are listed, and a brief is cut to one line', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      facetId: 'human.heart.limits',
      title: `T${String(index)}`,
      brief: 'x. y.',
    }));
    const pages = Array.from({ length: 20 }, (_, index) => ({
      url: `https://en.wikipedia.org/wiki/P${String(index)}`,
      title: 'P',
      passages: 9,
      excerpt: 'e',
    }));
    const items = recipeBriefContext({ ...facts, existing: many, candidates: pages });
    expect(items.filter((item) => item.kind === 'candidate_page')).toHaveLength(MAX_LISTED_PAGES);
    expect(items.find((item) => item.kind === 'existing_recipes')?.text.split('\n')).toHaveLength(MAX_LISTED_RECIPES);
    expect(oneLineBriefOf(`${'word '.repeat(100)}. Second sentence.`).length).toBeLessThanOrEqual(200);
  });
});

describe('the brief role', () => {
  it('is nonpersonal, background class, versioned and asks for strict JSON drafts', () => {
    const role = recipeBriefRole();
    expect(role.id).toBe('content.recipe-brief');
    expect(role.version).toBe(RECIPE_BRIEF_ROLE_VERSION);
    expect(role.budgetClass).toBe('background');
    expect(role.repairWithPreviousAnswer).toBe(true);
    expect(role.instructions).toContain('exactly one JSON object');
    expect(role.instructions).toContain('copied exactly from the candidate pages');
    expect(role.outputSchema.safeParse({ drafts: [] }).success).toBe(true);
    expect(role.outputSchema.safeParse('prose').success).toBe(false);
  });
});
