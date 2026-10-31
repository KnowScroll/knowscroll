import { describe, expect, it } from 'vitest';
import {
  describeStarState,
  lifetimeInSunLifetimes,
  mainSequenceRadiusInSuns,
  MASS_IN_SUNS,
  settleStarState,
  STAR_ENUMS,
  starParts,
  starPhysics,
  type StarState,
} from './star.js';

const MASSES = STAR_ENUMS.mass;

const states = STAR_ENUMS.view.flatMap((view) =>
  STAR_ENUMS.balance.flatMap((balance) =>
    MASSES.flatMap((mass) =>
      STAR_ENUMS.stage.flatMap((stage) =>
        STAR_ENUMS.focus.map((focus): StarState => ({ view, balance, mass, stage, focus })),
      ),
    ),
  ),
);

describe('the star physics against its first principles', () => {
  it('lives for its fuel over its output: fuel goes as the mass and output as the mass to the power 3.5', () => {
    for (const mass of MASSES) {
      const suns = MASS_IN_SUNS[mass];
      const fuel = suns;
      const output = suns ** 3.5;
      expect(lifetimeInSunLifetimes(mass), mass).toBeCloseTo(fuel / output, 12);
    }
    expect(lifetimeInSunLifetimes('sun-like')).toBe(1);
  });

  it('lives longer the lighter it is: a low-mass star outlasts the Sun and a high-mass star is gone first', () => {
    expect(lifetimeInSunLifetimes('low')).toBeGreaterThan(lifetimeInSunLifetimes('sun-like'));
    expect(lifetimeInSunLifetimes('sun-like')).toBeGreaterThan(lifetimeInSunLifetimes('high'));
    expect(lifetimeInSunLifetimes('high')).toBeLessThan(0.01);
  });

  it('is bigger and hotter the more massive it is', () => {
    expect(mainSequenceRadiusInSuns('low')).toBeLessThan(mainSequenceRadiusInSuns('sun-like'));
    expect(mainSequenceRadiusInSuns('sun-like')).toBeLessThan(mainSequenceRadiusInSuns('high'));
    expect(mainSequenceRadiusInSuns('sun-like')).toBe(1);
    expect(MASSES.map((mass) => starPhysics({ balance: 'steady', mass }).surface)).toEqual(['cool', 'middle', 'hot']);
  });

  it('ends only a high-mass star in a supernova; a low or Sun-like star ends as a white dwarf', () => {
    expect(MASSES.map((mass) => starPhysics({ balance: 'steady', mass }).end)).toEqual([
      'white-dwarf',
      'white-dwarf',
      'supernova',
    ]);
  });

  it('holds its size when gravity and pressure are equal, shrinks when gravity wins and swells when pressure wins', () => {
    const motion = (balance: StarState['balance']) => starPhysics({ balance, mass: 'sun-like' });
    expect(motion('steady')).toMatchObject({ gravity: 1, pressure: 1, motion: 'holds' });
    expect(motion('gravity-wins').pressure).toBeLessThan(motion('gravity-wins').gravity);
    expect(motion('gravity-wins').motion).toBe('shrinks');
    expect(motion('pressure-wins').pressure).toBeGreaterThan(motion('pressure-wins').gravity);
    expect(motion('pressure-wins').motion).toBe('swells');
  });
});

describe('settling and describing a star state', () => {
  it('keeps only the keys the view uses, and a remnant only at the end of a life', () => {
    for (const state of states) {
      const settled = settleStarState(state);
      expect(settled.balance === state.balance, JSON.stringify(state)).toBe(
        state.view === 'balance' || state.balance === 'steady',
      );
      expect(settled.stage === state.stage).toBe(state.view === 'life' || state.stage === 'main-sequence');
      if (state.view === 'balance') expect(settled.mass).toBe('sun-like');
      if (settled.focus === 'remnant') expect(settled.view === 'life' && settled.stage === 'end').toBe(true);
      if (settled.focus === 'lifetime') expect(settled.view).toBe('mass');
      if (['core', 'gravity', 'pressure'].includes(settled.focus)) expect(settled.view).toBe('balance');
      if (settled.focus !== 'none') expect(starParts(settled)).toContain(settled.focus);
    }
  });

  it('never says a Sun-like or low-mass star explodes, and never names a black hole', () => {
    for (const state of states) {
      const settled = settleStarState(state);
      const text = describeStarState(state);
      if (settled.view !== 'balance' && settled.mass !== 'high' && settled.view === 'life')
        expect(text, JSON.stringify(state)).not.toMatch(/supernova|explod|black hole/iu);
      expect(text, JSON.stringify(state)).not.toMatch(/black hole|\d/iu);
    }
  });

  it('ends a high-mass life with a supernova and a low-mass one with a white dwarf, in the words of the physics', () => {
    const end = (mass: StarState['mass']) =>
      describeStarState({ view: 'life', balance: 'steady', mass, stage: 'end', focus: 'none' });
    expect(end('high')).toContain('explodes as a supernova');
    expect(end('low')).toContain('white dwarf');
    expect(end('sun-like')).toContain('white dwarf');
    expect(end('high')).not.toContain('white dwarf');
  });

  it('describes the balance in the words of the forces, and says the bars are stretched', () => {
    const balance = (state: StarState['balance']) =>
      describeStarState({ view: 'balance', balance: state, mass: 'sun-like', stage: 'main-sequence', focus: 'none' });
    expect(balance('steady')).toContain('equal strength, so the star holds its size');
    expect(balance('gravity-wins')).toContain('would shrink');
    expect(balance('pressure-wins')).toContain('would swell');
    expect(
      describeStarState({ view: 'mass', balance: 'steady', mass: 'high', stage: 'main-sequence', focus: 'none' }),
    ).toContain('stretched scale');
  });
});
