import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { plainText } from '../../primitives.js';
import { Stage } from '../document.js';
import { EARTH_SKY_KIT } from '../kit.js';
import { FIELD_LIMITS_V2 } from '../limits.js';
import {
  applyKitPatch,
  isKitPatch,
  kitDefinition,
  kitKeys,
  STAGE_KIT_IDS,
  type KitDefinition,
  type WordState,
} from './index.js';

/** Every state a writer could choose for a kit: the product of the words of all its keys. */
function everyState(kit: KitDefinition): WordState[] {
  return kitKeys(kit).reduce<WordState[]>(
    (states, key) => states.flatMap((state) => (kit.enums[key] ?? []).map((word) => ({ ...state, [key]: word }))),
    [{}],
  );
}

const anyState = (kit: KitDefinition): fc.Arbitrary<WordState> =>
  fc.record(Object.fromEntries(kitKeys(kit).map((key) => [key, fc.constantFrom(...(kit.enums[key] ?? []))])));

describe.each(STAGE_KIT_IDS)('the generic rules of the kit %s', (id) => {
  const kit = kitDefinition(id);
  const states = everyState(kit);

  it('has a first state of its own words that is already settled, and words that are plain lower-case', () => {
    expect(kitKeys(kit)).toContain('view');
    expect(kitKeys(kit)).toContain('focus');
    for (const key of kitKeys(kit)) {
      expect(kit.initial[key], key).toBeDefined();
      expect(kit.enums[key]).toContain(kit.initial[key]);
      for (const word of kit.enums[key] ?? []) expect(word).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
    }
    expect(kit.settle(kit.initial)).toEqual(kit.initial);
  });

  it('settles every state to a state of its own words, idempotently, and keeps the view', () => {
    expect(states.length).toBeGreaterThan(10);
    for (const state of states) {
      const settled = kit.settle(state);
      expect(kit.settle(settled), JSON.stringify(state)).toEqual(settled);
      expect(settled['view']).toBe(state['view']);
      for (const key of kitKeys(kit)) expect(kit.enums[key], JSON.stringify(state)).toContain(settled[key]);
    }
  });

  it('describes every state in plain, bounded sentences that the document accepts, the same for states that settle alike', () => {
    for (const state of states) {
      const text = kit.describe(state);
      expect(text.length, JSON.stringify(state)).toBeGreaterThan(10);
      expect(text.length).toBeLessThanOrEqual(FIELD_LIMITS_V2.stateDescriptionChars);
      expect(plainText(10, FIELD_LIMITS_V2.stateDescriptionChars).safeParse(text).success, text).toBe(true);
      expect(text).toBe(kit.describe(kit.settle(state)));
    }
  });

  it('never mentions a prompt, a source, a score or a model', () => {
    for (const state of states) expect(kit.describe(state)).not.toMatch(/\b(?:prompt|source|score|model)\b/iu);
  });

  it('refuses a patch with a key or a word the kit does not have, and ignores it when assembling', () => {
    const word = kit.enums['view']?.[0] ?? '';
    expect(isKitPatch(kit, { view: word })).toBe(true);
    expect(isKitPatch(kit, {})).toBe(true);
    expect(isKitPatch(kit, { view: 'a-castle' })).toBe(false);
    expect(isKitPatch(kit, { x: word })).toBe(false);
    expect(isKitPatch(kit, { view: 4 })).toBe(false);
    expect(isKitPatch(kit, { constructor: word })).toBe(false);
    expect(applyKitPatch(kit, kit.initial, { view: 'a-castle', x: word })).toEqual(kit.initial);
    fc.assert(
      fc.property(anyState(kit), anyState(kit), (previous, patch) => {
        const next = applyKitPatch(kit, previous, patch);
        for (const key of kitKeys(kit)) expect(next[key]).toBe(patch[key]);
        expect(applyKitPatch(kit, next, undefined)).toBe(next);
      }),
    );
  });

  it('is a stage the document accepts, and a stage of another kit’s words is not', () => {
    const entry = (state: WordState) => ({ stop: 's1', state: kit.settle(state), alt: kit.describe(state) });
    const stage = { kit: id, states: [entry(kit.initial)] };
    expect(Stage.safeParse(stage).success).toBe(true);
    for (const other of STAGE_KIT_IDS.filter((candidate) => candidate !== id)) {
      const foreign = kitDefinition(other);
      expect(
        Stage.safeParse({
          kit: id,
          states: [{ stop: 's1', state: foreign.initial, alt: foreign.describe(foreign.initial) }],
        }).success,
        other,
      ).toBe(false);
    }
    expect(Stage.safeParse({ ...stage, kit: 'invented.v1' }).success).toBe(false);
  });
});

describe('the kits as a set', () => {
  it('lists Earth & sky first and every kit once', () => {
    expect(STAGE_KIT_IDS[0]).toBe(EARTH_SKY_KIT);
    expect(new Set(STAGE_KIT_IDS).size).toBe(STAGE_KIT_IDS.length);
    for (const id of STAGE_KIT_IDS) expect(kitDefinition(id).id).toBe(id);
  });
});
