import { describe, expect, it } from 'vitest';
import { peakNanometres } from './spectrum.js';
import {
  describeStarlightState,
  DISTANCE_STEPS,
  dimmedShare,
  habitableZoneOf,
  mainSequenceLuminosityAt,
  ORBIT_ASTRONOMICAL_UNITS,
  settleStarlightState,
  starGroup,
  STARLIGHT_ENUMS,
  starlightAt,
  starlightParts,
  starlightPhysics,
  starlightStar,
  STARS_BY_TEMPERATURE,
  SUN_SURFACE_KELVINS,
  ZONE_STARLIGHT,
  ZONE_STARS,
  zoneVerdict,
  type StarKind,
  type StarlightState,
  type ZoneStar,
} from './starlight.js';

const SOLAR_RADIUS_METRES = 6.957e8;
const STEFAN_BOLTZMANN = 5.670374419e-8;
const ASTRONOMICAL_UNIT_METRES = 1.495978707e11;
const SOLAR_OUTPUT_WATTS = 4 * Math.PI * SOLAR_RADIUS_METRES ** 2 * STEFAN_BOLTZMANN * SUN_SURFACE_KELVINS ** 4;

const states = STARLIGHT_ENUMS.view.flatMap((view) =>
  STARLIGHT_ENUMS.star.flatMap((star) =>
    STARLIGHT_ENUMS.distance.flatMap((distance) =>
      STARLIGHT_ENUMS.orbit.flatMap((orbit) =>
        STARLIGHT_ENUMS.focus.map((focus): StarlightState => ({ view, star, distance, orbit, focus })),
      ),
    ),
  ),
);

const physicsOf = (star: StarKind) => starlightPhysics({ star, distance: 'near', orbit: 'none' });
const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);

describe('a star’s light against first principles', () => {
  it('gives each kind the output of a sphere of its radius and temperature, worked out in SI units', () => {
    for (const kind of STARLIGHT_ENUMS.star) {
      const star = starlightStar(kind);
      const watts = 4 * Math.PI * (star.radius * SOLAR_RADIUS_METRES) ** 2 * STEFAN_BOLTZMANN * star.kelvins ** 4;
      expect(watts / SOLAR_OUTPUT_WATTS, kind).toBeCloseTo(star.luminosity, 8);
    }
    expect(starlightStar('sun-like')).toMatchObject({ kelvins: SUN_SURFACE_KELVINS, radius: 1 });
    expect(starlightStar('sun-like').luminosity).toBeCloseTo(1, 12);
  });

  it('takes the three main-sequence stars from the mass power laws, and gets their temperature from them', () => {
    const mass = { 'low-mass': 0.5, 'sun-like': 1, bright: 2 } as const;
    for (const kind of ZONE_STARS) {
      const star = starlightStar(kind);
      expect(star.radius).toBeCloseTo(mass[kind] ** 0.8, 12);
      expect(star.luminosity).toBeCloseTo(mass[kind] ** 3.5, 12);
      expect(star.kelvins ** 4 / SUN_SURFACE_KELVINS ** 4).toBeCloseTo(star.luminosity / star.radius ** 2, 9);
    }
    expect(starlightStar('low-mass').kelvins).toBeGreaterThan(3500);
    expect(starlightStar('low-mass').kelvins).toBeLessThan(5000);
    expect(starlightStar('bright').kelvins).toBeGreaterThan(7000);
    expect(starlightStar('bright').kelvins).toBeLessThan(10000);
  });

  it('makes a hotter star shine most strongly at a shorter wavelength and look bluer, in the order of the temperatures', () => {
    const blueness = (kind: StarKind) => {
      const { colour } = starlightStar(kind);
      return channel(colour, 5) - channel(colour, 1);
    };
    const kelvins = STARS_BY_TEMPERATURE.map((kind) => starlightStar(kind).kelvins);
    expect(kelvins).toEqual([...kelvins].sort((first, second) => first - second));
    expect(STARS_BY_TEMPERATURE).toEqual(['giant', 'low-mass', 'sun-like', 'bright', 'white-dwarf']);
    STARS_BY_TEMPERATURE.forEach((kind, index) => {
      expect(starlightStar(kind).peakNanometres).toBeCloseTo(peakNanometres(starlightStar(kind).kelvins), 9);
      const cooler = STARS_BY_TEMPERATURE[index - 1];
      if (cooler === undefined) return;
      expect(starlightStar(kind).peakNanometres).toBeLessThan(starlightStar(cooler).peakNanometres);
      expect(blueness(kind)).toBeGreaterThan(blueness(cooler));
    });
  });

  it('lets a star be dim because it is small or bright because it is large: size and temperature together decide the output', () => {
    // The giant is cooler than the Sun yet far brighter; the white dwarf is hotter yet far dimmer.
    expect(physicsOf('giant').heatDex).toBeLessThan(0);
    expect(physicsOf('giant').outputDex).toBeGreaterThan(1);
    expect(physicsOf('white-dwarf').heatDex).toBeGreaterThan(0);
    expect(physicsOf('white-dwarf').outputDex).toBeLessThan(-1);
    for (const kind of STARLIGHT_ENUMS.star) {
      const physics = physicsOf(kind);
      expect(physics.sizeDex + physics.heatDex).toBeCloseTo(physics.outputDex, 12);
    }
  });

  it('thins the light as one over the distance squared: a square on a sphere of twice the radius catches a quarter', () => {
    const sphereArea = (radius: number) => 4 * Math.PI * radius ** 2;
    for (const distance of STARLIGHT_ENUMS.distance)
      expect(dimmedShare(distance)).toBeCloseTo(sphereArea(1) / sphereArea(DISTANCE_STEPS[distance]), 12);
    expect(DISTANCE_STEPS).toEqual({ near: 1, middle: 2, far: 4 });
    expect(dimmedShare('middle')).toBe(0.25);
    expect(dimmedShare('far')).toBe(1 / 16);
  });
});

describe('the chart of stars', () => {
  it('puts the three main-sequence stars on the band, the giant above it and the white dwarf below it', () => {
    expect(ZONE_STARS.map((kind) => starlightStar(kind).group)).toEqual([
      'main-sequence',
      'main-sequence',
      'main-sequence',
    ]);
    expect(starlightStar('giant').group).toBe('giants');
    expect(starlightStar('white-dwarf').group).toBe('white-dwarfs');
    for (const kind of ZONE_STARS) {
      const star = starlightStar(kind);
      expect(mainSequenceLuminosityAt(star.kelvins), kind).toBeCloseTo(star.luminosity, 9);
    }
    expect(starGroup(5772, 1000)).toBe('giants');
    expect(starGroup(5772, 0.01)).toBe('white-dwarfs');
  });
});

describe('the habitable zone against first principles', () => {
  const solarConstant = SOLAR_OUTPUT_WATTS / (4 * Math.PI * ASTRONOMICAL_UNIT_METRES ** 2);

  it('has edges where a planet gets the limiting starlight, worked out from the output in SI units', () => {
    expect(solarConstant).toBeGreaterThan(1355);
    expect(solarConstant).toBeLessThan(1367);
    for (const kind of ZONE_STARS) {
      const { luminosity } = starlightStar(kind);
      const zone = habitableZoneOf(luminosity);
      const watts = (astronomicalUnits: number) =>
        (luminosity * SOLAR_OUTPUT_WATTS) / (4 * Math.PI * (astronomicalUnits * ASTRONOMICAL_UNIT_METRES) ** 2);
      expect(watts(zone.innerAstronomicalUnits) / solarConstant, kind).toBeCloseTo(ZONE_STARLIGHT.inner, 9);
      expect(watts(zone.outerAstronomicalUnits) / solarConstant, kind).toBeCloseTo(ZONE_STARLIGHT.outer, 9);
    }
    expect(habitableZoneOf(1).innerAstronomicalUnits).toBeGreaterThan(0.9);
    expect(habitableZoneOf(1).outerAstronomicalUnits).toBeLessThan(1.8);
  });

  it('puts a hotter, brighter star’s zone farther out and wider, and a cooler star’s closer in and narrower', () => {
    const zoneOf = (kind: ZoneStar) => habitableZoneOf(starlightStar(kind).luminosity);
    const width = (kind: ZoneStar) => zoneOf(kind).outerAstronomicalUnits - zoneOf(kind).innerAstronomicalUnits;
    expect(zoneOf('low-mass').innerAstronomicalUnits).toBeLessThan(zoneOf('sun-like').innerAstronomicalUnits);
    expect(zoneOf('sun-like').innerAstronomicalUnits).toBeLessThan(zoneOf('bright').innerAstronomicalUnits);
    expect(width('low-mass')).toBeLessThan(width('sun-like'));
    expect(width('sun-like')).toBeLessThan(width('bright'));
    // The distances go as the square root of the output: a star 100 times as bright has a zone 10 times as far.
    expect(habitableZoneOf(100).innerAstronomicalUnits).toBeCloseTo(10 * habitableZoneOf(1).innerAstronomicalUnits, 12);
  });

  it('decides each orbit against the starlight there, so every orbit is in exactly one of the three zones', () => {
    for (const [orbit, astronomicalUnits] of Object.entries(ORBIT_ASTRONOMICAL_UNITS)) {
      const verdicts = ZONE_STARS.map((kind) => zoneVerdict(starlightStar(kind).luminosity, astronomicalUnits));
      expect(
        verdicts.filter((verdict) => verdict === 'in-zone'),
        orbit,
      ).toHaveLength(1);
      for (const kind of ZONE_STARS) {
        const light = starlightAt(starlightStar(kind).luminosity, astronomicalUnits);
        const expected =
          light > ZONE_STARLIGHT.inner ? 'too-hot' : light < ZONE_STARLIGHT.outer ? 'too-cold' : 'in-zone';
        expect(zoneVerdict(starlightStar(kind).luminosity, astronomicalUnits)).toBe(expected);
      }
    }
    const verdicts = (orbit: 'inner' | 'earth' | 'outer') =>
      starlightPhysics({ star: 'sun-like', distance: 'near', orbit }).planet?.verdicts;
    expect(verdicts('inner')).toEqual({ 'low-mass': 'in-zone', 'sun-like': 'too-hot', bright: 'too-hot' });
    expect(verdicts('earth')).toEqual({ 'low-mass': 'too-cold', 'sun-like': 'in-zone', bright: 'too-hot' });
    expect(verdicts('outer')).toEqual({ 'low-mass': 'too-cold', 'sun-like': 'too-cold', bright: 'in-zone' });
    expect(physicsOf('sun-like').planet).toBeUndefined();
  });
});

describe('settling and describing a starlight state', () => {
  const base: StarlightState = { view: 'output', star: 'sun-like', distance: 'near', orbit: 'none', focus: 'none' };

  it('keeps only the keys the view uses, a zone only for a star that has one, and a focus only on a part that is drawn', () => {
    for (const state of states) {
      const settled = settleStarlightState(state);
      expect(settled.distance === state.distance, JSON.stringify(state)).toBe(
        state.view === 'dimming' || state.distance === 'near',
      );
      expect(settled.orbit === state.orbit).toBe(state.view === 'zone' || state.orbit === 'none');
      if (state.view === 'dimming') expect(settled.star).toBe('sun-like');
      if (state.view === 'zone') expect((ZONE_STARS as readonly string[]).includes(settled.star)).toBe(true);
      if (settled.focus !== 'none') expect(starlightParts(settled)).toContain(settled.focus);
      if (settled.focus === 'planet') expect(settled.view === 'zone' && settled.orbit !== 'none').toBe(true);
    }
  });

  it('says in words what the physics says, and never gives a figure', () => {
    for (const state of states) expect(describeStarlightState(state), JSON.stringify(state)).not.toMatch(/\d/u);
    const text = (patch: Partial<StarlightState>) => describeStarlightState({ ...base, ...patch });
    expect(text({ star: 'giant' })).toContain('larger and its surface is cooler');
    expect(text({ star: 'giant' })).toContain('Its size counts for more, so its total output is far greater');
    expect(text({ star: 'white-dwarf' })).toContain('smaller and its surface is hotter');
    expect(text({ star: 'white-dwarf' })).toContain('Its size counts for more, so its total output is far less');
    expect(text({ star: 'low-mass' })).toContain('Both push the same way, so its total output is far less');
    expect(text({ star: 'bright' })).toContain('Both push the same way, so its total output is far greater');
    expect(text({ view: 'dimming', distance: 'far' })).toContain('catches a sixteenth of the light');
    expect(text({ view: 'dimming', distance: 'middle' })).toContain('catches a quarter of the light');
    expect(text({ view: 'diagram', star: 'giant' })).toContain('among the giants');
    expect(text({ view: 'diagram', star: 'white-dwarf' })).toContain('among the white dwarfs');
    expect(text({ view: 'diagram', star: 'sun-like' })).toContain('on the main sequence');
  });

  it('says for each orbit which zone it lies in, as the physics says, and that a zone is not water or life', () => {
    const zone = (orbit: StarlightState['orbit']) => describeStarlightState({ ...base, view: 'zone', orbit });
    expect(zone('inner')).toContain(
      'inside the zone for the low-mass star, too hot for the star like the Sun and too hot for the brighter one',
    );
    expect(zone('earth')).toContain(
      'too cold for the low-mass star, inside the zone for the star like the Sun and too hot for the brighter one',
    );
    expect(zone('outer')).toContain(
      'too cold for the low-mass star, too cold for the star like the Sun and inside the zone for the brighter one',
    );
    for (const orbit of STARLIGHT_ENUMS.orbit) {
      const text = zone(orbit);
      expect(text).toContain('could hold liquid water, if its air and other conditions allow');
      expect(text).toContain('is not thereby a planet with water or life');
      expect(text).not.toMatch(/\bis habitable\b|\binhabited\b|\blife exists\b|\bhas life\b|aliens?/iu);
    }
  });

  it('says the colours are strengthened and the sizes not to scale, and that colour alone does not give an age', () => {
    const colour = describeStarlightState({ ...base, view: 'colour' });
    expect(colour).toContain('Colours are strengthened');
    expect(colour).toContain('sizes are not to scale');
    expect(describeStarlightState({ ...base, view: 'diagram' })).toContain('colour alone does not give its age');
  });
});
