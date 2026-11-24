import { describe, expect, it } from 'vitest';
import { bookRecipeOf, type StoredRecipeRow } from './stored-recipes.js';

const row = (over: Partial<StoredRecipeRow> = {}): StoredRecipeRow => ({
  key: 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d',
  origin: 'proposal',
  status: 'checked',
  title: 'How heart valves keep blood moving',
  topic_id: 'human.heart',
  facet_id: 'human.heart.mechanism',
  supporting_facet_id: null,
  asset_id: 'e0a7e0a7-0000-4000-8000-000000000001',
  explanation_unit_id: 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d-v1',
  brief: 'Explain how the valves open and close. Ask only for what the pages say.',
  pages: ['https://en.wikipedia.org/wiki/Heart'],
  scroll_v3: { shape: 'mechanism', sections: ['What the valves are', 'How one beat works'] },
  proposing_run_id: 'e0a7e0a7-0000-4000-8000-0000000000aa',
  check_results: { pool: 20, closest: 0.1 },
  created_at: new Date('2026-11-22T00:00:00Z'),
  ...over,
});

describe('bookRecipeOf: a stored recipe as the library plan reads it', () => {
  it('reads a v3 row into scrollV3, with no misconception and no pictures', () => {
    const recipe = bookRecipeOf(row(), 'human-body');
    expect(recipe.scrollV3).toEqual({
      shape: 'mechanism',
      sections: ['What the valves are', 'How one beat works'],
      misconception: { kind: 'none' },
    });
    expect(recipe.scrollV3?.pictures).toBeUndefined();
    expect(recipe).toMatchObject({
      key: 'gen-how-heart-valves-keep-blood-moving-1a2b3c4d',
      origin: 'proposal',
      status: 'checked',
      systemId: 'human-body',
      interactive: false,
      interactiveKind: null,
    });
  });

  it('keeps three sections as they are', () => {
    const recipe = bookRecipeOf(row({ scroll_v3: { shape: 'story', sections: ['One', 'Two', 'Three'] } }), '');
    expect(recipe.scrollV3).toMatchObject({ shape: 'story', sections: ['One', 'Two', 'Three'] });
  });

  it('reads a row that holds only the old v2 plan as a recipe with no plan, which production refuses (#815)', () => {
    const plain = { variant: 'plain', misconception: { kind: 'none' } } as const;
    const recipe = bookRecipeOf({ ...row({ scroll_v3: null }), scroll_v2: plain } as StoredRecipeRow, '');
    expect('scrollV2' in recipe).toBe(false);
    expect('scrollV3' in recipe).toBe(false);
  });

  it('refuses a row whose v3 plan does not parse, loudly, and never reads it as having none', () => {
    const bad: unknown[] = [
      { shape: 'essay', sections: ['One', 'Two'] },
      { shape: 'story', sections: ['Only one'] },
      { shape: 'story', sections: ['1', '2', '3', '4'] },
      { shape: 'story', sections: ['One', 'Two'], pictures: [] },
      { shape: 'story' },
      'story',
      [],
      42,
    ];
    for (const scroll_v3 of bad)
      expect(() => bookRecipeOf(row({ scroll_v3 }), ''), JSON.stringify(scroll_v3)).toThrow(
        /^STORED_RECIPE_PLAN_INVALID: gen-/u,
      );
  });
});
