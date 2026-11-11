import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_RECIPE_PREFIX,
  GENERATED_SCROLL_V2_PLAN,
  generatedKeyOf,
  generatedUnitIdOf,
  isGeneratedRecipeKey,
  MAX_RECIPE_KEY_LENGTH,
  RECIPE_STATUSES,
  titleOfKey,
} from './generated.js';
import { RECIPES, RECIPE_KEYS } from './index.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const draft = {
  topicId: 'human.heart',
  facetId: 'human.heart.mechanism',
  title: 'How the heart valves keep blood moving',
};

describe('the key of a stored recipe', () => {
  it('starts with the reserved prefix, is a legal recipe key and is at most 64 characters', () => {
    const key = generatedKeyOf(draft, sha256Hex);
    expect(key.startsWith(GENERATED_RECIPE_PREFIX)).toBe(true);
    expect(key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u);
    expect(key.length).toBeLessThanOrEqual(MAX_RECIPE_KEY_LENGTH);
    expect(isGeneratedRecipeKey(key)).toBe(true);
  });

  it('is the same for the same draft and differs for another title, facet or planet', () => {
    const key = generatedKeyOf(draft, sha256Hex);
    expect(generatedKeyOf({ ...draft }, sha256Hex)).toBe(key);
    expect(generatedKeyOf({ ...draft, title: `  ${draft.title.toUpperCase()}  ` }, sha256Hex)).toBe(
      generatedKeyOf({ ...draft, title: draft.title.toLowerCase() }, sha256Hex),
    );
    expect(generatedKeyOf({ ...draft, title: 'Why a heart valve can leak' }, sha256Hex)).not.toBe(key);
    expect(generatedKeyOf({ ...draft, facetId: 'human.heart.limits' }, sha256Hex)).not.toBe(key);
    expect(generatedKeyOf({ ...draft, topicId: 'human.blood' }, sha256Hex)).not.toBe(key);
  });

  it('stays legal for a very long title, for symbols and for a title with no letters', () => {
    for (const title of ['x'.repeat(90), 'Ünïcödé — “quotes” & symbols!', '🙂🙂🙂🙂🙂🙂🙂🙂']) {
      const key = generatedKeyOf({ ...draft, title }, sha256Hex);
      expect(isGeneratedRecipeKey(key), title).toBe(true);
    }
  });

  it('is recognised only by its shape', () => {
    expect(isGeneratedRecipeKey('gen-heart-valves-1a2b3c4d')).toBe(true);
    expect(isGeneratedRecipeKey('seasons')).toBe(false);
    expect(isGeneratedRecipeKey('gen-')).toBe(false);
    expect(isGeneratedRecipeKey('gen--double')).toBe(false);
    expect(isGeneratedRecipeKey('Gen-upper')).toBe(false);
    expect(isGeneratedRecipeKey(`gen-${'a'.repeat(61)}`)).toBe(false);
  });

  it('gives an explanation unit derived from the key', () => {
    const key = generatedKeyOf(draft, sha256Hex);
    expect(generatedUnitIdOf(key)).toBe(`${key}-v1`);
  });

  it('never collides with a code recipe: no code key, explanation unit or asset id uses the reserved prefix', () => {
    for (const key of RECIPE_KEYS) {
      expect(key.startsWith(GENERATED_RECIPE_PREFIX), key).toBe(false);
      expect(RECIPES[key].explanationUnitId.startsWith(GENERATED_RECIPE_PREFIX), key).toBe(false);
    }
  });
});

describe('what every stored recipe asks of the writer', () => {
  it('is a plain, explanation-first Scroll: no misconception, no landmark, no picture, no play block (D-397)', () => {
    expect(GENERATED_SCROLL_V2_PLAN).toEqual({ variant: 'plain', misconception: { kind: 'none' } });
  });

  it('has the four statuses the table allows', () => {
    expect([...RECIPE_STATUSES]).toEqual(['checked', 'queued', 'produced', 'retired']);
  });

  it('writes a code recipe key as a title', () => {
    expect(titleOfKey('industrial-causes')).toBe('Industrial causes');
  });
});
