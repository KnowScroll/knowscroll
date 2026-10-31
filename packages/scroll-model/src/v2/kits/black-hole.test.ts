import { describe, expect, it } from 'vitest';
import {
  BLACK_HOLE_ENUMS,
  blackHoleParts,
  blackHolePhysics,
  CORE_COLLAPSE_MASS_IN_SUNS,
  describeBlackHoleState,
  DISC_INNER_EDGE_IN_HORIZON_RADII,
  DISC_RINGS,
  discKelvins,
  escapeSpeedShare,
  formationPhysics,
  HOLE_MASS_IN_SUNS,
  horizonRadiusKilometres,
  massInsideOrbit,
  ORBIT_RADII,
  orbitPeriod,
  orbitSpeed,
  pullAt,
  separationAt,
  settleBlackHoleState,
  SHADOW_RADIUS_IN_HORIZON_RADII,
  TIME_TO_MERGER,
  waveFrequencyAt,
  waveStrengthAt,
  type BlackHoleState,
} from './black-hole.js';
import { peakNanometres } from './spectrum.js';

const G = 6.6743e-11;
const C = 299_792_458;
const SUN_KILOGRAMS = 1.98847e30;
const ASTRONOMICAL_UNIT_METRES = 1.495978707e11;

const states = BLACK_HOLE_ENUMS.view.flatMap((view) =>
  BLACK_HOLE_ENUMS.star.flatMap((star) =>
    BLACK_HOLE_ENUMS.stage.flatMap((stage) =>
      BLACK_HOLE_ENUMS.hole.flatMap((hole) =>
        BLACK_HOLE_ENUMS.merger.flatMap((merger) =>
          BLACK_HOLE_ENUMS.focus.map((focus): BlackHoleState => ({ view, star, stage, hole, merger, focus })),
        ),
      ),
    ),
  ),
);

const base: BlackHoleState = {
  view: 'formation',
  star: 'massive',
  stage: 'fusing',
  hole: 'small',
  merger: 'apart',
  focus: 'none',
};
const text = (patch: Partial<BlackHoleState>): string => describeBlackHoleState({ ...base, ...patch });

describe('the event horizon against first principles', () => {
  it('is where the speed needed to escape reaches the speed of light, worked out from Newton’s escape speed', () => {
    for (const massInSuns of [1, 10, 40, 4e6]) {
      const radiusMetres = horizonRadiusKilometres(massInSuns) * 1000;
      const escapeSpeed = Math.sqrt((2 * G * massInSuns * SUN_KILOGRAMS) / radiusMetres);
      expect(escapeSpeed / C, String(massInSuns)).toBeCloseTo(1, 12);
    }
  });

  it('goes as the mass: four times the mass, four times the radius, and about three kilometres for each Sun', () => {
    expect(horizonRadiusKilometres(40) / horizonRadiusKilometres(10)).toBeCloseTo(4, 12);
    expect(horizonRadiusKilometres(1)).toBeGreaterThan(2.9);
    expect(horizonRadiusKilometres(1)).toBeLessThan(3.0);
    expect(Math.round(horizonRadiusKilometres(1))).toBe(3);
    expect(HOLE_MASS_IN_SUNS.large / HOLE_MASS_IN_SUNS.small).toBe(4);
    expect(blackHolePhysics({ star: 'massive', hole: 'large', merger: 'apart' })).toMatchObject({ horizonRatio: 4 });
  });

  it('needs the speed of light to leave the horizon and less the farther out, as the square root of the distance', () => {
    expect(escapeSpeedShare(1)).toBe(1);
    expect(escapeSpeedShare(4)).toBe(0.5);
    const radiusMetres = horizonRadiusKilometres(10) * 1000;
    for (const times of [1.5, 3, 9, 100])
      expect(escapeSpeedShare(times)).toBeCloseTo(
        Math.sqrt((2 * G * 10 * SUN_KILOGRAMS) / (times * radiusMetres)) / C,
        12,
      );
  });

  it('pulls a faraway object alike whatever the mass is made of: the pull depends on the mass and distance only', () => {
    const distance = 1e12;
    const pull = pullAt(10, distance);
    expect(pullAt(10, 2 * distance)).toBeCloseTo(pull / 4, 12);
    expect(pullAt(20, distance)).toBeCloseTo(2 * pull, 12);
    // A circular orbit at that distance has the same period round a star or a black hole of this mass.
    const speed = Math.sqrt(pull * distance);
    expect((2 * Math.PI * distance) / speed).toBeCloseTo(
      2 * Math.PI * Math.sqrt(distance ** 3 / (G * 10 * SUN_KILOGRAMS)),
      3,
    );
  });
});

describe('how a star ends against first principles', () => {
  it('collapses only above about eight Suns’ mass, so the Sun’s kind of star ends as a white dwarf and a massive one explodes', () => {
    expect(CORE_COLLAPSE_MASS_IN_SUNS).toBe(8);
    expect(formationPhysics('sun-like')).toMatchObject({
      coreCollapses: false,
      ending: 'white-dwarf',
      canLeaveBlackHole: false,
    });
    expect(formationPhysics('massive')).toMatchObject({
      coreCollapses: true,
      ending: 'supernova',
      canLeaveBlackHole: true,
    });
    expect(formationPhysics('massive').massInSuns).toBeGreaterThan(CORE_COLLAPSE_MASS_IN_SUNS);
    expect(formationPhysics('sun-like').massInSuns).toBeLessThan(CORE_COLLAPSE_MASS_IN_SUNS);
  });

  it('says a black hole can form only from the massive star at its end, and never from the Sun’s kind of star', () => {
    for (const state of states) {
      const settled = settleBlackHoleState(state);
      const described = describeBlackHoleState(state);
      if (settled.view !== 'formation') continue;
      if (settled.star === 'sun-like') {
        expect(described, JSON.stringify(state)).not.toMatch(/supernova|can be a black hole|collapses/iu);
        expect(described).toContain('will not become one');
      } else {
        expect(/can be a black hole/u.test(described), JSON.stringify(state)).toBe(settled.stage === 'end');
        expect(described).toContain('above about eight times the Sun’s mass');
      }
    }
    expect(text({ stage: 'fuel-out' })).toContain('the core collapses inward');
    expect(text({ stage: 'end' })).toContain('what is left of the core can be a black hole');
    expect(text({ star: 'sun-like', stage: 'end' })).toContain('white dwarf');
  });
});

describe('the clues against first principles', () => {
  it('lets orbits tell the mass: every orbit round one mass gives the same mass, worked out in SI units', () => {
    const hiddenSuns = 4e6;
    const innermostMetres = 1000 * ASTRONOMICAL_UNIT_METRES;
    const periodSeconds = (radiusMetres: number) =>
      2 * Math.PI * Math.sqrt(radiusMetres ** 3 / (G * hiddenSuns * SUN_KILOGRAMS));
    const speedMetres = (radiusMetres: number) => Math.sqrt((G * hiddenSuns * SUN_KILOGRAMS) / radiusMetres);
    for (const radius of ORBIT_RADII) {
      expect(periodSeconds(radius * innermostMetres) / periodSeconds(innermostMetres), String(radius)).toBeCloseTo(
        orbitPeriod(radius),
        12,
      );
      expect(speedMetres(radius * innermostMetres) / speedMetres(innermostMetres)).toBeCloseTo(orbitSpeed(radius), 12);
      expect(massInsideOrbit(radius, orbitPeriod(radius))).toBeCloseTo(1, 12);
    }
    // Nearer stars move faster and go round sooner.
    expect(orbitSpeed(1)).toBeGreaterThan(orbitSpeed(2));
    expect(orbitPeriod(1)).toBeLessThan(orbitPeriod(2));
    // The orbits of S2 round the black hole at our galaxy’s centre: about 1000 astronomical units, 16 years, 4 million Suns.
    expect(1000 ** 3 / 16 ** 2 / 4e6).toBeCloseTo(1, 0);
  });

  it('heats the disc more the nearer the hole, to millions of kelvins, so the inner gas glows in X-rays', () => {
    expect(DISC_INNER_EDGE_IN_HORIZON_RADII).toBe(3);
    const temperatures = DISC_RINGS.map(discKelvins);
    expect(temperatures).toEqual([...temperatures].sort((first, second) => second - first));
    expect(discKelvins(8) / discKelvins(1)).toBeCloseTo(8 ** -0.75, 12);
    for (const rings of DISC_RINGS) {
      // X-rays have wavelengths from about 0.01 to 10 nanometres.
      expect(peakNanometres(discKelvins(rings)), String(rings)).toBeLessThan(10);
      expect(peakNanometres(discKelvins(rings))).toBeGreaterThan(0.01);
    }
  });

  it('makes the shadow the impact parameter of light that just circles the hole, wider than the horizon', () => {
    // Light at the photon sphere, one and a half horizon radii out: b = r / sqrt(1 - 1/r) in horizon radii.
    const photonSphere = 1.5;
    expect(SHADOW_RADIUS_IN_HORIZON_RADII).toBeCloseTo(photonSphere / Math.sqrt(1 - 1 / photonSphere), 12);
    expect(SHADOW_RADIUS_IN_HORIZON_RADII).toBeGreaterThan(2.5);
    expect(SHADOW_RADIUS_IN_HORIZON_RADII).toBeLessThan(2.7);
  });

  it('makes the ripples stronger and quicker toward the merger: the orbit’s frequency from Kepler, doubled, agrees with the chirp', () => {
    for (const merger of ['apart', 'close'] as const) {
      const time = TIME_TO_MERGER[merger];
      // Kepler: the orbit’s frequency goes as the separation to the power minus three halves; the waves have twice that frequency.
      expect(waveFrequencyAt(time) / waveFrequencyAt(1)).toBeCloseTo(separationAt(time) ** -1.5, 12);
      expect(waveStrengthAt(time)).toBeCloseTo(waveFrequencyAt(time) ** (2 / 3), 12);
    }
    expect(separationAt(TIME_TO_MERGER.close)).toBeLessThan(separationAt(TIME_TO_MERGER.apart));
    expect(waveFrequencyAt(TIME_TO_MERGER.close)).toBeGreaterThan(waveFrequencyAt(TIME_TO_MERGER.apart));
    expect(waveStrengthAt(TIME_TO_MERGER.close)).toBeGreaterThan(waveStrengthAt(TIME_TO_MERGER.apart));
    expect(TIME_TO_MERGER.merged).toBe(0);
  });
});

describe('settling and describing a black-hole state', () => {
  it('keeps only the keys the view uses, a remnant only at the end of a star’s life and a focus only on a part that is drawn', () => {
    for (const state of states) {
      const settled = settleBlackHoleState(state);
      const formation = state.view === 'formation';
      expect(settled.star === state.star, JSON.stringify(state)).toBe(formation || state.star === 'massive');
      expect(settled.stage === state.stage).toBe(formation || state.stage === 'fusing');
      expect(settled.hole === state.hole).toBe(state.view === 'horizon' || state.hole === 'small');
      expect(settled.merger === state.merger).toBe(state.view === 'waves' || state.merger === 'apart');
      if (settled.focus !== 'none') expect(blackHoleParts(settled)).toContain(settled.focus);
      if (settled.focus === 'remnant') expect(settled.view === 'formation' && settled.stage === 'end').toBe(true);
    }
  });

  it('says in words what the physics says, with only the figures the horizon needs', () => {
    for (const state of states) expect(describeBlackHoleState(state), JSON.stringify(state)).not.toMatch(/\d/u);
    expect(text({ view: 'horizon', hole: 'large' })).toContain('The larger hole is marked');
    expect(text({ view: 'horizon' })).toContain('four times the mass means a horizon four times as wide');
    expect(text({ view: 'horizon' })).toContain('about three kilometres from the centre for each Sun’s mass');
    expect(text({ view: 'waves', merger: 'close' })).toContain('stronger and quicker');
    expect(text({ view: 'shadow' })).toContain('about two and six-tenths times as wide as the horizon');
  });

  it('never says what the picture does not draw or what is not known', () => {
    for (const state of states) {
      const described = describeBlackHoleState(state);
      expect(described, JSON.stringify(state)).not.toMatch(/singularity|wormhole|another universe|spaghett/iu);
      // A black hole does not suck in everything, and the picture never says it does.
      expect(described).not.toMatch(/sucks? (?:in )?everything(?! around)/iu);
      if (/suck/iu.test(described)) expect(described).toContain('does not suck in everything');
      if (settleBlackHoleState(state).view === 'shadow') expect(described).toContain('so it is not the horizon itself');
      if (/\bhorizon\b/iu.test(described) && /surface/iu.test(described)) expect(described).toContain('not a surface');
    }
  });

  it('gives each clue as one clue, never as proof on its own', () => {
    for (const view of ['orbits', 'disc', 'waves', 'shadow'] as const)
      expect(text({ view })).toContain('one clue to a black hole, but it does not prove one by itself');
    for (const view of ['formation', 'horizon', 'pull'] as const) expect(text({ view })).not.toContain('one clue');
  });
});
