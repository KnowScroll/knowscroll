import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { plainText } from '../primitives.js';
import {
  applyStagePatch,
  AXIAL_TILT_DEGREES,
  describeStageAtTilt,
  describeStageRecap,
  recapMonths,
  describeStageState,
  INITIAL_STAGE_STATE,
  NORTH_LEAN_PERCENT,
  physicsAtTilt,
  PIN_LATITUDE_DEGREES,
  settleStageState,
  STAGE_ENUMS,
  STAGE_FIGURE_SLOTS,
  STAGE_KEYS,
  stageParts,
  stagePhysics,
  StageStateSchema,
  sunLatitudeDegrees,
  TILT_RANGE,
  tiltMatters,
  type StageFigure,
  type StageKey,
  type StageState,
} from './kit.js';
import { FIELD_LIMITS_V2 } from './limits.js';

const anyState = fc.record(
  Object.fromEntries(STAGE_KEYS.map((key) => [key, fc.constantFrom(...STAGE_ENUMS[key])])) as {
    [Key in StageKey]: fc.Arbitrary<StageState[Key]>;
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

describe('the tilt a reader turns at the Final call (D-187)', () => {
  const MONTHS = STAGE_ENUMS.earthAt;
  const TILTS = Array.from({ length: TILT_RANGE.max - TILT_RANGE.min + 1 }, (_, step) => TILT_RANGE.min + step);

  it('puts the noon Sun over the tilt itself at the June solstice, minus it in December and over the equator at the equinoxes', () => {
    for (const tilt of TILTS) {
      expect(sunLatitudeDegrees('jun', tilt)).toBeCloseTo(tilt, 9);
      expect(sunLatitudeDegrees('dec', tilt)).toBeCloseTo(-tilt, 9);
      expect(sunLatitudeDegrees('mar', tilt)).toBeCloseTo(0, 9);
      expect(sunLatitudeDegrees('sep', tilt)).toBeCloseTo(0, 9);
    }
  });

  it('is finite and inside the hemispheres over every month and every whole degree of the range, and clamps outside it', () => {
    for (const month of MONTHS)
      for (const tilt of TILTS) {
        const latitude = sunLatitudeDegrees(month, tilt);
        expect(Number.isFinite(latitude)).toBe(true);
        expect(Math.abs(latitude)).toBeLessThanOrEqual(tilt + 1e-9);
        const physics = physicsAtTilt({ earthAt: month }, tilt);
        for (const distance of [physics.northDistance, physics.southDistance]) {
          expect(Number.isFinite(distance)).toBe(true);
          expect(distance).toBeGreaterThanOrEqual(0);
          expect(distance).toBeLessThanOrEqual(90);
        }
      }
    expect(sunLatitudeDegrees('jun', -40)).toBeCloseTo(0, 9);
    expect(sunLatitudeDegrees('jun', 400)).toBeCloseTo(TILT_RANGE.max, 9);
  });

  it("agrees with the derived physics in every month at today's tilt, so turning the slider starts from the same picture", () => {
    for (const month of MONTHS) {
      const turned = physicsAtTilt({ earthAt: month }, AXIAL_TILT_DEGREES);
      const derived = stagePhysics({ earthAt: month });
      expect({ leansToward: turned.leansToward, north: turned.north, south: turned.south }).toEqual({
        leansToward: derived.leansToward,
        north: derived.north,
        south: derived.south,
      });
    }
  });

  it('leans neither half toward the Sun, in any month, when the axis stands straight up', () => {
    for (const month of MONTHS) {
      const upright = physicsAtTilt({ earthAt: month }, 0);
      expect(upright.leansToward).toBe('neither');
      expect(upright.north).toEqual(upright.south);
      expect(upright.north.pin).toBe('neutral');
    }
  });

  it('brings the Sun nearer the northern pin as the tilt grows, up to the latitude of the pin, mirrored six months apart', () => {
    let previous = Infinity;
    for (const tilt of TILTS) {
      const june = physicsAtTilt({ earthAt: 'jun' }, tilt);
      if (tilt <= PIN_LATITUDE_DEGREES) {
        expect(june.northDistance).toBeLessThanOrEqual(previous + 1e-9);
        previous = june.northDistance;
      }
      const december = physicsAtTilt({ earthAt: 'dec' }, tilt);
      expect(december.northDistance).toBeCloseTo(june.southDistance, 9);
      expect(december.southDistance).toBeCloseTo(june.northDistance, 9);
    }
  });

  it("describes today's tilt exactly as the stage does, and any other tilt in words that cannot contradict its picture", () => {
    const state: StageState = { view: 'sun-earth', earthAt: 'jun', moonAt: 'off', focus: 'none' };
    expect(describeStageAtTilt(state, AXIAL_TILT_DEGREES)).toBe(describeStageState(state));
    const upright = describeStageAtTilt(state, 0);
    expect(upright).toMatch(/stands straight up/u);
    expect(upright).toMatch(/Neither half leans toward the Sun/u);
    expect(upright).toMatch(/pin in the north is marked neither warm nor cool/u);
    const steeper = describeStageAtTilt(state, 60);
    expect(steeper).toMatch(/tilted by 60 degrees, more than the tilt it has now/u);
    expect(describeStageAtTilt(state, 10)).toMatch(/less than the tilt it has now/u);
    // Earth's axis is tilted or upright, never "sideways": that word belongs to another world.
    for (const tilt of TILTS) expect(describeStageAtTilt(state, tilt)).not.toMatch(/sideways|on its side/iu);
  });

  it('matters where the view draws the axis and the season and the month has a lean to lose, and not at an equinox or on the Moon view', () => {
    for (const state of EVERY_STATE.filter((candidate) => candidate.moonAt === 'off' && candidate.focus === 'none')) {
      const drawsSeason = state.view !== 'moon-orbit';
      const equinox = state.earthAt === 'mar' || state.earthAt === 'sep';
      expect(tiltMatters(state), `${state.view} ${state.earthAt}`).toBe(drawsSeason && !equinox);
    }
  });

  it('agrees with the pictures: where the tilt matters, turning it moves the pins; where it does not, it never does', () => {
    for (const month of MONTHS) {
      const state: StageState = { view: 'sun-earth', earthAt: month, moonAt: 'off', focus: 'none' };
      const spread = new Set(TILTS.map((tilt) => physicsAtTilt(state, tilt).northDistance.toFixed(6)));
      expect(spread.size > 1, month).toBe(tiltMatters(state));
    }
  });

  it('describes only what the view draws: no axis, pins or Ray in the Moon view', () => {
    const moon: StageState = { view: 'moon-orbit', earthAt: 'jun', moonAt: 'full', focus: 'none' };
    const text = describeStageAtTilt(moon, 0);
    expect(text).not.toMatch(/axis|pin|Ray/u);
  });
});

describe('the recap of a stage (V3 F10)', () => {
  const at = (view: StageState['view'], earthAt: StageState['earthAt']): StageState => ({
    view,
    earthAt,
    moonAt: 'off',
    focus: 'none',
  });

  it('numbers the months the orbit views stood at, once each, in the order the Scroll shows them', () => {
    const states = [
      at('sun-earth', 'jun'),
      at('orbit', 'jun'),
      at('orbit-stretched', 'jan'),
      at('earth-close', 'jul'),
      at('orbit', 'mar'),
      at('orbit', 'jun'),
    ];
    expect(recapMonths(states)).toEqual(['jun', 'jan', 'mar']);
    expect(recapMonths([at('sun-earth', 'jun'), at('earth-close', 'dec')])).toEqual([]);
  });

  it('says them in words that follow the months, and the lean that is the same in every one', () => {
    const text = describeStageRecap(['jun', 'jan', 'mar']);
    expect(text).toMatch(/marked 1 in June, 2 in January and 3 in March, numbered in the order the Scroll shows them/u);
    expect(text).toMatch(/leans the same way in every one/u);
    expect(describeStageRecap(['dec', 'jun'])).toMatch(/marked 1 in December and 2 in June/u);
  });
});

describe('the figures a state may carry (D-382)', () => {
  const nearest: StageFigure = { slot: 'nearest', value: 41_000_000, unit: 'kilometres' };
  const farthest: StageFigure = { slot: 'farthest', value: 43_000_000, unit: 'kilometres' };
  const june: StageFigure = { slot: 'june-daylight', value: 14, unit: 'hours', place: 'Pell' };
  const december: StageFigure = { slot: 'december-daylight', value: 10, unit: 'hours', place: 'Pell' };
  const orbit = { view: 'orbit', earthAt: 'oct', moonAt: 'off', focus: 'none' } as const;
  const sunEarth = { ...orbit, view: 'sun-earth', earthAt: 'jun' } as const;

  it('has four slots, and a state with none is described and settled exactly as before', () => {
    expect([...STAGE_FIGURE_SLOTS]).toEqual(['nearest', 'farthest', 'june-daylight', 'december-daylight']);
    expect(describeStageState(orbit)).not.toMatch(/nearest|farthest|You are here|not drawn to scale/u);
    expect(settleStageState(orbit)).toEqual(orbit);
    expect(settleStageState(orbit)).not.toHaveProperty('figures');
  });

  it('keeps the distances on the orbit views and the daylight on the Sun and Earth view, and sets aside the rest', () => {
    for (const view of ['orbit', 'orbit-stretched'] as const)
      expect(settleStageState({ ...orbit, view, figures: [nearest, farthest, june] }).figures).toEqual([
        nearest,
        farthest,
      ]);
    expect(settleStageState({ ...sunEarth, figures: [nearest, june, december] }).figures).toEqual([june, december]);
    for (const view of ['earth-close', 'moon-orbit'] as const)
      expect(settleStageState({ ...orbit, view, figures: [nearest, june] })).not.toHaveProperty('figures');
  });

  it('puts the figures in the order of the slots, once each, a daylight figure only with a place and a distance never with one', () => {
    expect(settleStageState({ ...orbit, figures: [farthest, nearest, { ...nearest, value: 1 }] }).figures).toEqual([
      nearest,
      farthest,
    ]);
    expect(settleStageState({ ...orbit, figures: [{ ...nearest, place: 'Pell' }] }).figures).toEqual([nearest]);
    expect(settleStageState({ ...sunEarth, figures: [{ ...june, place: undefined }, december] }).figures).toEqual([
      december,
    ]);
  });

  it('keeps a daylight figure only in hours and never more than a day, because the picture draws it as a share of a day', () => {
    const kept = (change: Partial<StageFigure>) =>
      settleStageState({ ...sunEarth, figures: [{ ...june, ...change }] }).figures?.length ?? 0;
    expect(kept({})).toBe(1);
    expect(kept({ unit: 'Hour', value: 1 })).toBe(1);
    expect(kept({ value: 24 })).toBe(1);
    expect(kept({ value: 24.5 })).toBe(0);
    expect(kept({ unit: 'minutes' })).toBe(0);
    expect(kept({ unit: 'kilometres' })).toBe(0);
  });

  it('is idempotent for every figure on every view', () => {
    const figures = fc.subarray([nearest, farthest, june, december, { ...june, place: undefined }]);
    fc.assert(
      fc.property(anyState, figures, (state, chosen) => {
        const settled = settleStageState({ ...state, figures: chosen });
        expect(settleStageState(settled)).toEqual(settled);
        expect(StageStateSchema.safeParse(settled).success).toBe(true);
      }),
    );
  });

  it('describes a distance, a daylight figure and what the picture says beside the distances, from the figures alone', () => {
    const words = describeStageState({ ...orbit, figures: [nearest, farthest] });
    expect(words).toContain(
      'At its nearest, Earth is 41,000,000 kilometres from the Sun; at its farthest, 43,000,000 kilometres.',
    );
    // One distance alone is said on its own.
    expect(describeStageState({ ...orbit, figures: [farthest] })).toContain(
      'At its farthest, Earth is 43,000,000 kilometres from the Sun.',
    );
    expect(words).toContain('Earth is marked “You are here”, and the Sun is not drawn to scale.');
    const bands = describeStageState({ ...sunEarth, figures: [june, december] });
    expect(bands).toContain('In Pell, daylight lasts 14 hours in June and 10 hours in December.');
    expect(describeStageState({ ...sunEarth, figures: [december] })).toContain(
      'In Pell, daylight lasts 10 hours in December.',
    );
    expect(bands).not.toContain('You are here');
    // A figure the view cannot draw is not described either: the words are of the settled state.
    expect(describeStageState({ ...sunEarth, figures: [nearest] })).toBe(describeStageState(sunEarth));
  });

  it('says them at a turned tilt too, since the picture still draws them', () => {
    expect(describeStageAtTilt({ ...orbit, figures: [nearest] }, 60)).toContain('At its nearest, Earth is 41,000,000');
  });

  it('is carried by no patch: a stop that changes the picture clears them, and no word of a patch can name one', () => {
    const next = applyStagePatch({ ...orbit, figures: [nearest] }, { focus: 'sun' });
    expect(next).not.toHaveProperty('figures');
    expect(applyStagePatch({ ...orbit, figures: [nearest] }, undefined).figures).toEqual([nearest]);
    expect([...STAGE_KEYS]).not.toContain('figures');
  });

  it('holds a number, a unit and a place a person could read: no zero, no negative, no empty unit, no further key', () => {
    const accepts = (state: unknown) => StageStateSchema.safeParse(state).success;
    expect(accepts({ ...orbit, figures: [nearest] })).toBe(true);
    expect(accepts({ ...orbit, figures: [{ ...nearest, value: 0 }] })).toBe(false);
    expect(accepts({ ...orbit, figures: [{ ...nearest, value: -4 }] })).toBe(false);
    expect(accepts({ ...orbit, figures: [{ ...nearest, unit: '' }] })).toBe(false);
    expect(accepts({ ...orbit, figures: [{ ...nearest, extra: 1 }] })).toBe(false);
    expect(accepts({ ...orbit, figures: [] })).toBe(false);
    expect(accepts({ ...orbit, figures: [nearest, farthest, june, december, nearest] })).toBe(false);
  });
});

describe('a picture states one measure and one place (D-382)', () => {
  const orbit = { view: 'orbit', earthAt: 'oct', moonAt: 'off', focus: 'none' } as const;
  const sunEarth = { ...orbit, view: 'sun-earth', earthAt: 'jun' } as const;
  const nearest: StageFigure = { slot: 'nearest', value: 91_400_000, unit: 'miles' };
  const farthest: StageFigure = { slot: 'farthest', value: 94_500_000, unit: 'miles' };
  const june: StageFigure = { slot: 'june-daylight', value: 14, unit: 'hours', place: 'Delhi' };
  const december: StageFigure = { slot: 'december-daylight', value: 10, unit: 'hours', place: 'Delhi' };

  it('keeps the two distances only in one unit, whatever the case or a plural s', () => {
    expect(settleStageState({ ...orbit, figures: [nearest, farthest] }).figures).toEqual([nearest, farthest]);
    expect(settleStageState({ ...orbit, figures: [nearest, { ...farthest, unit: 'Miles' }] }).figures).toHaveLength(2);
    expect(settleStageState({ ...orbit, figures: [nearest, { ...farthest, unit: ' mile ' }] }).figures).toHaveLength(2);
    // 91.4 million miles beside 152.1 million kilometres is no comparison any passage made.
    expect(settleStageState({ ...orbit, figures: [nearest, { ...farthest, unit: 'kilometres' }] })).not.toHaveProperty(
      'figures',
    );
    // One distance alone has nothing to disagree with.
    expect(settleStageState({ ...orbit, figures: [{ ...farthest, unit: 'kilometres' }] }).figures).toHaveLength(1);
  });

  it('keeps the two bands only for one place, whatever the case or the spacing', () => {
    expect(settleStageState({ ...sunEarth, figures: [june, december] }).figures).toEqual([june, december]);
    expect(settleStageState({ ...sunEarth, figures: [june, { ...december, place: ' DELHI ' }] }).figures).toHaveLength(
      2,
    );
    // Delhi's June beside Sydney's December is a picture of no place.
    expect(settleStageState({ ...sunEarth, figures: [june, { ...december, place: 'Sydney' }] })).not.toHaveProperty(
      'figures',
    );
    expect(settleStageState({ ...sunEarth, figures: [{ ...december, place: 'Sydney' }] }).figures).toHaveLength(1);
  });

  it('is idempotent with the new rules, for every pair of figures', () => {
    const figures = fc.subarray([
      nearest,
      farthest,
      { ...farthest, unit: 'kilometres' },
      june,
      december,
      { ...december, place: 'Sydney' },
    ]);
    fc.assert(
      fc.property(anyState, figures, (state, chosen) => {
        const settled = settleStageState({ ...state, figures: chosen });
        expect(settleStageState(settled)).toEqual(settled);
        expect(StageStateSchema.safeParse(settled).success).toBe(true);
      }),
    );
  });
});

describe('the words of a state never pass the document’s limit, with the longest figures there can be (D-382)', () => {
  const limit = FIELD_LIMITS_V2.stateDescriptionChars;
  /** The longest of everything a figure holds: fifteen digits, a unit and a place of the longest length the document allows. */
  const longest = (slot: StageFigure['slot']): StageFigure =>
    slot === 'nearest' || slot === 'farthest'
      ? { slot, value: 999_999_999_999_999, unit: 'k'.repeat(FIELD_LIMITS_V2.unitChars) }
      : {
          slot,
          value: 24,
          unit: 'hours',
          place: 'Thiruvananthapuram Kerala South India'.slice(0, FIELD_LIMITS_V2.pointLabelChars),
        };
  const everything = STAGE_FIGURE_SLOTS.map(longest);

  it('is within the limit for every state, whatever figures and place names are asked for', () => {
    const over: string[] = [];
    let kept = 0;
    for (const state of EVERY_STATE) {
      const settled = settleStageState({ ...state, figures: everything });
      const text = describeStageState({ ...state, figures: everything });
      if (text.length > limit) over.push(JSON.stringify(state));
      if (settled.figures !== undefined) kept += 1;
      expect(StageStateSchema.safeParse(settled).success).toBe(true);
      expect(settleStageState(settled)).toEqual(settled);
    }
    expect(over).toEqual([]);
    // Some states have room for the figures and keep them: leaving all out would also be within the limit.
    expect(kept).toBeGreaterThan(0);
  });

  it('is within the limit for the places the writer is most likely to name, short and long', () => {
    for (const place of ['Delhi', 'Thiruvananthapuram', 'New York City', 'Rio de Janeiro', 'Pell']) {
      for (const state of EVERY_STATE) {
        const bands: StageFigure[] = [
          { slot: 'june-daylight', value: 14.25, unit: 'hours', place },
          { slot: 'december-daylight', value: 9.75, unit: 'hours', place },
        ];
        expect(
          describeStageState({ ...state, figures: bands }).length,
          `${place} ${JSON.stringify(state)}`,
        ).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('gives up the later band first, then the earlier, and keeps both where both fit', () => {
    const state = { view: 'sun-earth', earthAt: 'jun', moonAt: 'off', focus: 'ray' } as const;
    const place = 'Thiruvananthapuram Kerala South India';
    const bands: StageFigure[] = [
      { slot: 'june-daylight', value: 14, unit: 'hours', place },
      { slot: 'december-daylight', value: 10, unit: 'hours', place },
    ];
    const kept = (figures: StageFigure[]) =>
      (settleStageState({ ...state, figures }).figures ?? []).map((figure) => figure.slot);
    // With a short name both fit; with a very long one the picture's words would pass the limit, so December goes first.
    const short = bands.map((band) => ({ ...band, place: 'Pell' }));
    expect(kept(short)).toEqual(['june-daylight', 'december-daylight']);
    const widths = [place, `${place} ${place}`.slice(0, FIELD_LIMITS_V2.pointLabelChars)].map((name) =>
      kept(bands.map((band) => ({ ...band, place: name }))),
    );
    for (const slots of widths) expect(['june-daylight', 'december-daylight']).toEqual(expect.arrayContaining(slots));
    const states = EVERY_STATE.filter((candidate) => candidate.view === 'sun-earth');
    const outcomes = new Set(
      states.map((candidate) =>
        JSON.stringify((settleStageState({ ...candidate, figures: bands }).figures ?? []).map((figure) => figure.slot)),
      ),
    );
    // Only ever both, the earlier alone or none: never the later band without the earlier.
    for (const outcome of outcomes)
      expect(['[]', '["june-daylight"]', '["june-daylight","december-daylight"]']).toContain(outcome);
  });
});
