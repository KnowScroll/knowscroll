import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { plainText } from '../primitives.js';
import {
  applyStagePatch,
  changesStage,
  describeStageState,
  INITIAL_STAGE_STATE,
  STAGE_ENUMS,
  STAGE_KEYS,
  StageStateSchema,
  type StageState,
} from './kit.js';
import { FIELD_LIMITS_V2 } from './limits.js';

const anyState = fc.record(
  Object.fromEntries(STAGE_KEYS.map((key) => [key, fc.constantFrom(...STAGE_ENUMS[key])])) as {
    [Key in keyof StageState]: fc.Arbitrary<StageState[Key]>;
  },
);

describe('the Earth & sky kit', () => {
  it('starts from a state every schema accepts, and every value of each key is a word', () => {
    expect(StageStateSchema.safeParse(INITIAL_STAGE_STATE).success).toBe(true);
    for (const key of STAGE_KEYS) for (const value of STAGE_ENUMS[key]) expect(value).toMatch(/^[a-z-]+$/u);
  });

  it('carries unnamed keys over and replaces the named ones', () => {
    const next = applyStagePatch(INITIAL_STAGE_STATE, { ray: 'low', northPin: 'cool' });
    expect(next).toEqual({ ...INITIAL_STAGE_STATE, ray: 'low', northPin: 'cool' });
    expect(applyStagePatch(next, undefined)).toBe(next);
    expect(changesStage(next, { ray: 'low' })).toBe(false);
    expect(changesStage(next, { ray: 'high' })).toBe(true);
    expect(changesStage(next, undefined)).toBe(false);
  });

  it('describes any state in plain, bounded sentences that the document schema accepts', () => {
    fc.assert(
      fc.property(anyState, (state) => {
        const text = describeStageState(state);
        expect(text.length).toBeGreaterThan(10);
        expect(text.length).toBeLessThanOrEqual(FIELD_LIMITS_V2.stateDescriptionChars);
        expect(plainText(10, FIELD_LIMITS_V2.stateDescriptionChars).safeParse(text).success).toBe(true);
        expect(describeStageState(state)).toBe(text);
      }),
    );
  });

  it('says what changed: Ray, the pins and the Moon show up in the description', () => {
    const low = describeStageState({ ...INITIAL_STAGE_STATE, ray: 'low', northPin: 'warm', southPin: 'cool' });
    expect(low).toContain('low angle');
    expect(low).toContain('pin in the north is marked warm');
    expect(low).toContain('pin in the south is marked cool');
    expect(describeStageState({ ...INITIAL_STAGE_STATE, moonAt: 'full' })).toContain('Moon is full');
    expect(describeStageState(INITIAL_STAGE_STATE)).not.toContain('Ray');
  });
});
