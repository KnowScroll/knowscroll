import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { plainText } from '../primitives.js';
import {
  applyStagePatch,
  AXIAL_TILT_DEGREES,
  describeStageState,
  INITIAL_STAGE_STATE,
  NORTH_LEAN_PERCENT,
  settleStageState,
  STAGE_ENUMS,
  STAGE_KEYS,
  stageParts,
  stagePhysics,
  StageStateSchema,
  type StageState,
} from './kit.js';
import { FIELD_LIMITS_V2 } from './limits.js';

const anyState = fc.record(
  Object.fromEntries(STAGE_KEYS.map((key) => [key, fc.constantFrom(...STAGE_ENUMS[key])])) as {
    [Key in keyof StageState]: fc.Arbitrary<StageState[Key]>;
  },
);

/** Every state a writer could choose: 5 views x 12 months x 5 Moon phases x 9 focuses. */
const EVERY_STATE: readonly StageState[] = STAGE_ENUMS.view.flatMap((view) =>
  STAGE_ENUMS.earthAt.flatMap((earthAt) =>
    STAGE_ENUMS.moonAt.flatMap((moonAt) => STAGE_ENUMS.focus.map((focus) => ({ view, earthAt, moonAt, focus }))),
  ),
);

/**
 * The geometry the kit is derived from, written out again independently: the Sun's declination
 * through the year (the sine of the date, greatest at the June and December solstices), and how high
 * the noon Sun stands at 40 degrees north and south. The kit never computes this; the test does.
 */
const MONTH_OF_YEAR = Object.fromEntries(STAGE_ENUMS.earthAt.map((month, index) => [month, index + 1]));
function noonSunHeights(month: StageState['earthAt']): { north: number; south: number } {
  const declination = 23.44 * Math.sin((2 * Math.PI * ((MONTH_OF_YEAR[month] ?? 0) - 3)) / 12);
  return { north: 90 - Math.abs(40 - declination), south: 90 - Math.abs(-40 - declination) };
}

describe('the Earth & sky kit', () => {
  it('starts from a state every schema accepts, and every value of each key is a word', () => {
    expect(StageStateSchema.safeParse(INITIAL_STAGE_STATE).success).toBe(true);
    expect(settleStageState(INITIAL_STAGE_STATE)).toEqual(INITIAL_STAGE_STATE);
    for (const key of STAGE_KEYS) for (const value of STAGE_ENUMS[key]) expect(value).toMatch(/^[a-z-]+$/u);
  });

  it('gives the writer no word for the tilt, the pins or Ray: only the view, the month, the Moon and the focus', () => {
    expect([...STAGE_KEYS]).toEqual(['view', 'earthAt', 'moonAt', 'focus']);
    for (const old of ['axis', 'northPin', 'southPin', 'ray', 'orbit']) expect(STAGE_KEYS).not.toContain(old);
    expect(StageStateSchema.safeParse({ ...INITIAL_STAGE_STATE, axis: 'sideways' }).success).toBe(false);
  });

  it('carries unnamed keys over and replaces the named ones', () => {
    const next = applyStagePatch(INITIAL_STAGE_STATE, { earthAt: 'dec', focus: 'axis' });
    expect(next).toEqual({ ...INITIAL_STAGE_STATE, earthAt: 'dec', focus: 'axis' });
    expect(applyStagePatch(next, undefined)).toBe(next);
  });
});

describe('settling a state', () => {
  it('is idempotent and keeps what the view draws', () => {
    fc.assert(
      fc.property(anyState, (state) => {
        const settled = settleStageState(state);
        expect(settleStageState(settled)).toEqual(settled);
        expect(settled.view).toBe(state.view);
        expect(StageStateSchema.safeParse(settled).success).toBe(true);
      }),
    );
  });

  it('draws the Moon, a month and a focus only where the view has them', () => {
    for (const state of EVERY_STATE) {
      const settled = settleStageState(state);
      const parts = stageParts(state.view);
      if (!parts.includes('moon')) expect(settled.moonAt, JSON.stringify(state)).toBe('off');
      else expect(settled.moonAt).toBe(state.moonAt);
      if (!parts.includes('season')) expect(settled.earthAt).toBe('mar');
      else expect(settled.earthAt).toBe(state.earthAt);
      if (settled.focus === 'moon') expect(parts).toContain('moon');
      if (settled.focus === 'ray') expect(parts).toContain('ray');
      if (settled.focus === 'orbit') expect(parts).toContain('orbit');
      if (settled.focus === 'north-pin' || settled.focus === 'south-pin') expect(parts).toContain('pins');
    }
    expect(settleStageState({ view: 'moon-orbit', earthAt: 'jun', moonAt: 'full', focus: 'ray' })).toEqual({
      view: 'moon-orbit',
      earthAt: 'mar',
      moonAt: 'full',
      focus: 'none',
    });
    expect(settleStageState({ view: 'earth-close', earthAt: 'jun', moonAt: 'full', focus: 'moon' })).toEqual({
      view: 'earth-close',
      earthAt: 'jun',
      moonAt: 'off',
      focus: 'none',
    });
  });
});

describe('the physics code derives from the month', () => {
  it('fixes Earth’s tilt at 23.4 degrees in every month', () => {
    for (const month of STAGE_ENUMS.earthAt) expect(stagePhysics({ earthAt: month }).tiltDegrees).toBe(23.4);
    expect(AXIAL_TILT_DEGREES).toBe(23.4);
  });

  it('is warm and steep in the north in June and in the south in December, and neutral at the equinoxes', () => {
    expect(stagePhysics({ earthAt: 'jun' })).toEqual({
      tiltDegrees: 23.4,
      leansToward: 'north',
      north: { sunHeight: 'high', pin: 'warm' },
      south: { sunHeight: 'low', pin: 'cool' },
    });
    expect(stagePhysics({ earthAt: 'dec' })).toEqual({
      tiltDegrees: 23.4,
      leansToward: 'south',
      north: { sunHeight: 'low', pin: 'cool' },
      south: { sunHeight: 'high', pin: 'warm' },
    });
    for (const month of ['mar', 'sep'] as const)
      expect(stagePhysics({ earthAt: month })).toMatchObject({
        leansToward: 'neither',
        north: { sunHeight: 'middle', pin: 'neutral' },
        south: { sunHeight: 'middle', pin: 'neutral' },
      });
  });

  it('puts the lean table on the sine of the year', () => {
    for (const month of STAGE_ENUMS.earthAt) {
      const sine = Math.sin((2 * Math.PI * ((MONTH_OF_YEAR[month] ?? 0) - 3)) / 12);
      expect(Math.abs(NORTH_LEAN_PERCENT[month] - 100 * sine), month).toBeLessThanOrEqual(0.5);
    }
  });

  it('agrees with the season of each hemisphere in every month: pins and Ray follow the height of the noon Sun', () => {
    for (const month of STAGE_ENUMS.earthAt) {
      const physics = stagePhysics({ earthAt: month });
      const heights = noonSunHeights(month);
      for (const half of ['north', 'south'] as const) {
        const height = heights[half];
        const expected = height >= 60 ? 'high' : height <= 40 ? 'low' : 'middle';
        expect(physics[half].sunHeight, `${month} ${half}`).toBe(expected);
        expect(physics[half].pin, `${month} ${half}`).toBe({ high: 'warm', middle: 'neutral', low: 'cool' }[expected]);
      }
    }
  });

  it('never has both halves warm, both cool, or one warm under a low Sun, in any month and any view', () => {
    for (const state of EVERY_STATE) {
      const physics = stagePhysics(settleStageState(state));
      const pins = [physics.north.pin, physics.south.pin];
      expect(pins.filter((pin) => pin === 'warm').length).toBeLessThanOrEqual(1);
      expect(pins.filter((pin) => pin === 'cool').length).toBeLessThanOrEqual(1);
      expect(physics.north.pin === 'warm').toBe(physics.south.pin === 'cool');
      expect(physics.north.pin === 'cool').toBe(physics.south.pin === 'warm');
      expect(physics.north.sunHeight === 'high').toBe(physics.south.sunHeight === 'low');
      for (const half of [physics.north, physics.south])
        expect(half.pin).toBe({ high: 'warm', middle: 'neutral', low: 'cool' }[half.sunHeight]);
    }
  });

  it('mirrors the year: six months later the halves swap', () => {
    const months = STAGE_ENUMS.earthAt;
    months.forEach((month, index) => {
      const later = months[(index + 6) % 12] ?? month;
      expect(stagePhysics({ earthAt: later }).north).toEqual(stagePhysics({ earthAt: month }).south);
    });
  });
});

describe('describing a state', () => {
  it('writes plain, bounded sentences that the document schema accepts, for every state', () => {
    for (const state of EVERY_STATE) {
      const text = describeStageState(state);
      expect(text.length).toBeGreaterThan(10);
      expect(text.length).toBeLessThanOrEqual(FIELD_LIMITS_V2.stateDescriptionChars);
      expect(plainText(10, FIELD_LIMITS_V2.stateDescriptionChars).safeParse(text).success).toBe(true);
    }
    fc.assert(
      fc.property(anyState, (state) => {
        expect(describeStageState(state)).toBe(describeStageState(state));
      }),
    );
  });

  it('never says the axis is on its side, in any state', () => {
    for (const state of EVERY_STATE)
      expect(describeStageState(state), JSON.stringify(state)).not.toMatch(
        /\bon its side\b|\bsideways\b|\btipped (?:right )?over\b|\blying down\b/iu,
      );
  });

  it('says the same tilt every time Earth’s axis is drawn, and nothing about it where it is not', () => {
    for (const state of EVERY_STATE) {
      const text = describeStageState(state);
      expect(text.includes('axis is tilted by 23.4 degrees'), JSON.stringify(state)).toBe(
        stageParts(state.view).includes('axis'),
      );
    }
  });

  it('mentions Ray, the pins and the lean only where the view draws them, and agrees with the physics', () => {
    for (const state of EVERY_STATE) {
      const text = describeStageState(state);
      const parts = stageParts(state.view);
      expect(text.includes('Ray the sunbeam'), JSON.stringify(state)).toBe(parts.includes('ray'));
      expect(text.includes('A pin in the north'), JSON.stringify(state)).toBe(parts.includes('pins'));
      expect(text.includes('Moon is'), JSON.stringify(state)).toBe(parts.includes('moon') && state.moonAt !== 'off');
      expect(text.includes('Earth between it'), JSON.stringify(state)).toBe(
        parts.includes('moon') && state.moonAt === 'full',
      );
      if (!parts.includes('season')) continue;
      const physics = stagePhysics(state);
      expect(text).toContain(
        {
          north: 'The northern half leans toward the Sun',
          south: 'The southern half leans toward the Sun',
          neither: 'Neither half leans',
        }[physics.leansToward],
      );
    }
  });

  it('describes June and December as opposite seasons, and the equinox as neither', () => {
    const june = describeStageState({ view: 'sun-earth', earthAt: 'jun', moonAt: 'off', focus: 'none' });
    expect(june).toContain('The northern half leans toward the Sun');
    expect(june).toContain('A pin in the north is marked warm, and a pin in the south is marked cool.');
    expect(june).toContain('In the north, Ray the sunbeam arrives from high in the sky');
    expect(june).toContain('In the south, Ray arrives at a low angle');
    const december = describeStageState({ view: 'sun-earth', earthAt: 'dec', moonAt: 'off', focus: 'none' });
    expect(december).toContain('A pin in the north is marked cool, and a pin in the south is marked warm.');
    expect(describeStageState({ view: 'earth-close', earthAt: 'mar', moonAt: 'off', focus: 'ray' })).toContain(
      'Neither half leans toward the Sun',
    );
  });
});
