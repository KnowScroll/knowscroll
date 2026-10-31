import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARTERIOLE_RADIUS,
  CIRCULATION_ENUMS,
  COLOUR_CONVENTION,
  circulationParts,
  describeCirculationState,
  haemoglobinSaturation,
  HALF_LOADED_PRESSURE,
  heartPhysics,
  INITIAL_CIRCULATION_STATE,
  HEART_PRESSURES,
  loopPhysics,
  LOOP_STRETCHES,
  oxygenPhysics,
  OXYGEN_PRESSURE,
  RELATIVE_FLOW,
  resistanceFactor,
  settleCirculationState,
  USUAL_RESISTANCE_SHARE,
  VENTRICLE_FILL,
  type CirculationState,
} from './circulation.js';

const states = CIRCULATION_ENUMS.view.flatMap((view) =>
  CIRCULATION_ENUMS.phase.flatMap((phase) =>
    CIRCULATION_ENUMS.flow.flatMap((flow) =>
      CIRCULATION_ENUMS.vessels.flatMap((vessels) =>
        CIRCULATION_ENUMS.where.flatMap((where) =>
          CIRCULATION_ENUMS.focus.map((focus): CirculationState => ({ view, phase, flow, vessels, where, focus })),
        ),
      ),
    ),
  ),
);

describe('the heartbeat against the textbook', () => {
  /** What every physiology text says of the valves at each point of the beat: (valves between atria and ventricles open, valves to the arteries open). */
  const TEXTBOOK_VALVES = {
    filling: [true, false],
    'atria-squeeze': [true, false],
    'ventricles-tense': [false, false],
    ejection: [false, true],
    relaxing: [false, false],
  } as const;

  it('opens each valve exactly where the textbook has it, from the pressures alone', () => {
    for (const phase of CIRCULATION_ENUMS.phase) {
      const physics = heartPhysics(phase);
      expect([physics.atrioventricularOpen, physics.semilunarOpen], phase).toEqual(TEXTBOOK_VALVES[phase]);
    }
  });

  it('never lets blood run backwards: a valve is open only with the higher pressure behind it, and the two sets are never open together', () => {
    for (const phase of CIRCULATION_ENUMS.phase) {
      const physics = heartPhysics(phase);
      const { atrium, ventricle, artery } = HEART_PRESSURES[phase];
      expect(physics.atrioventricularOpen, phase).toBe(atrium > ventricle);
      expect(physics.semilunarOpen, phase).toBe(ventricle > artery);
      expect(physics.atrioventricularOpen && physics.semilunarOpen, phase).toBe(false);
    }
  });

  it('squeezes the atria and then the ventricles, never all four chambers at once', () => {
    for (const phase of CIRCULATION_ENUMS.phase) {
      const physics = heartPhysics(phase);
      expect(physics.atriaSqueezing && physics.ventriclesSqueezing, phase).toBe(false);
    }
    expect(heartPhysics('atria-squeeze').atriaSqueezing).toBe(true);
    expect(heartPhysics('ejection').ventriclesSqueezing).toBe(true);
    // The atria squeeze before the ventricles do.
    expect(CIRCULATION_ENUMS.phase.indexOf('atria-squeeze')).toBeLessThan(
      CIRCULATION_ENUMS.phase.indexOf('ventricles-tense'),
    );
  });

  it('keeps the ventricles’ volume while they tense and while they relax with every valve shut, and empties them only while the valves to the arteries are open', () => {
    expect(VENTRICLE_FILL['ventricles-tense']).toBe(VENTRICLE_FILL['atria-squeeze']);
    for (const phase of CIRCULATION_ENUMS.phase) {
      expect(VENTRICLE_FILL[phase], phase).toBeLessThanOrEqual(1);
      expect(VENTRICLE_FILL[phase], phase).toBeGreaterThanOrEqual(VENTRICLE_FILL.relaxing);
    }
    expect(VENTRICLE_FILL.ejection).toBeLessThan(VENTRICLE_FILL['ventricles-tense']);
    expect(VENTRICLE_FILL.relaxing).toBeLessThan(VENTRICLE_FILL.filling);
    expect(VENTRICLE_FILL.filling).toBeLessThan(VENTRICLE_FILL['atria-squeeze']);
    expect(heartPhysics('relaxing').semilunarOpen || heartPhysics('relaxing').atrioventricularOpen).toBe(false);
  });
});

describe('the pressure along the loop against Ohm’s law for fluids and Poiseuille’s law', () => {
  /** Resistance of a tube of length L and radius r in a fluid of viscosity μ: 8μL / (π r⁴). Written again with its constants. */
  const poiseuille = (radius: number) => (8 * 3.5e-3 * 0.02) / (Math.PI * radius ** 4);

  it('has resistance shares that add up to the whole, the arterioles the largest', () => {
    const total = LOOP_STRETCHES.reduce((sum, stretch) => sum + USUAL_RESISTANCE_SHARE[stretch], 0);
    expect(total).toBeCloseTo(1, 12);
    for (const stretch of LOOP_STRETCHES.filter((candidate) => candidate !== 'arterioles'))
      expect(USUAL_RESISTANCE_SHARE.arterioles).toBeGreaterThan(USUAL_RESISTANCE_SHARE[stretch]);
  });

  it('makes narrower arterioles resist as one over the fourth power of their radius', () => {
    const wide = 1e-4;
    for (const width of CIRCULATION_ENUMS.vessels) {
      const radius = ARTERIOLE_RADIUS[width];
      expect(resistanceFactor(radius), width).toBeCloseTo(poiseuille(wide * radius) / poiseuille(wide), 9);
    }
    // At four fifths of the width the resistance is about two and a half times as much.
    expect(resistanceFactor(0.8)).toBeCloseTo(2.44, 2);
    expect(resistanceFactor(1.25)).toBeLessThan(1);
  });

  it('uses up pressure stretch by stretch: each drop is the flow times its resistance, and the drops add up to the pressure at the start', () => {
    for (const flow of CIRCULATION_ENUMS.flow)
      for (const vessels of CIRCULATION_ENUMS.vessels) {
        const physics = loopPhysics({ flow, vessels });
        let level = physics.pressureAtEnd;
        for (const stretch of [...LOOP_STRETCHES].reverse()) {
          level += RELATIVE_FLOW[flow] * physics.resistance[stretch];
          expect(physics.pressureAtStart[stretch], `${flow} ${vessels} ${stretch}`).toBeCloseTo(level, 12);
        }
        // Ohm's law for fluids the other way round: the flow is the pressure used up over the resistance.
        expect(physics.pressureAtStart.arteries / physics.totalResistance, `${flow} ${vessels}`).toBeCloseTo(
          RELATIVE_FLOW[flow],
          12,
        );
      }
  });

  it('falls all the way along, and falls most across the arterioles as usual', () => {
    const physics = loopPhysics({ flow: 'usual', vessels: 'usual' });
    const levels = [...LOOP_STRETCHES.map((stretch) => physics.pressureAtStart[stretch]), physics.pressureAtEnd];
    levels.slice(1).forEach((level, index) => expect(level).toBeLessThan(levels[index] ?? 0));
    expect(physics.biggestDrop).toBe('arterioles');
    expect(physics.pressureAtStart.arteries).toBeCloseTo(1, 12);
  });

  it('raises the pressure before narrowed arterioles for the same flow and leaves the pressure after them as it was', () => {
    const usual = loopPhysics({ flow: 'usual', vessels: 'usual' });
    const narrowed = loopPhysics({ flow: 'usual', vessels: 'narrowed' });
    const widened = loopPhysics({ flow: 'usual', vessels: 'widened' });
    expect(narrowed.pressureAtStart.arteries).toBeGreaterThan(usual.pressureAtStart.arteries);
    expect(widened.pressureAtStart.arteries).toBeLessThan(usual.pressureAtStart.arteries);
    expect(narrowed.pressureAtStart.capillaries).toBeCloseTo(usual.pressureAtStart.capillaries, 12);
    expect(narrowed.pressureAtStart.veins).toBeCloseTo(usual.pressureAtStart.veins, 12);
  });

  it('draws the same shape of fall whatever the flow, only scaled by it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CIRCULATION_ENUMS.flow),
        fc.constantFrom(...CIRCULATION_ENUMS.vessels),
        (flow, vessels) => {
          const physics = loopPhysics({ flow, vessels });
          const base = loopPhysics({ flow: 'usual', vessels });
          for (const stretch of LOOP_STRETCHES)
            expect(physics.drop[stretch]).toBeCloseTo(base.drop[stretch] * RELATIVE_FLOW[flow], 12);
        },
      ),
    );
  });
});

describe('the oxygen curve against the published one', () => {
  /** The adult curve of Severinghaus (1979), the standard fit to the measured one, written as a different formula from the kit's Hill equation. */
  const severinghaus = (pressure: number) =>
    (pressure ** 3 + 150 * pressure) / (pressure ** 3 + 150 * pressure + 23400);

  it('agrees with Severinghaus’ fit over the range the body uses, from working muscle to the lungs and beyond', () => {
    for (let pressure = 20; pressure <= 120; pressure += 2)
      expect(
        Math.abs(haemoglobinSaturation(pressure) - severinghaus(pressure)),
        `${String(pressure)} mmHg`,
      ).toBeLessThan(0.03);
  });

  it('puts the textbook’s anchor points in place: half loaded near 27 mmHg, about three quarters in resting venous blood, nearly full in the lungs', () => {
    expect(Math.abs(haemoglobinSaturation(26.8) - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(haemoglobinSaturation(40) - 0.75)).toBeLessThan(0.03);
    expect(Math.abs(haemoglobinSaturation(100) - 0.975)).toBeLessThan(0.01);
  });

  it('is half loaded at its half-loading pressure, rises with the oxygen pressure and is S-shaped: flat at the top, steep in the middle', () => {
    expect(haemoglobinSaturation(HALF_LOADED_PRESSURE)).toBeCloseTo(0.5, 12);
    expect(haemoglobinSaturation(0)).toBe(0);
    let previous = 0;
    for (let pressure = 1; pressure <= 150; pressure += 1) {
      const saturation = haemoglobinSaturation(pressure);
      expect(saturation).toBeGreaterThan(previous);
      expect(saturation).toBeLessThan(1);
      previous = saturation;
    }
    const slope = (pressure: number) => haemoglobinSaturation(pressure + 1) - haemoglobinSaturation(pressure - 1);
    expect(slope(OXYGEN_PRESSURE['active-tissue'])).toBeGreaterThan(slope(OXYGEN_PRESSURE.lungs) * 5);
    expect(slope(10)).toBeLessThan(slope(HALF_LOADED_PRESSURE));
  });

  it('is symmetric about the half-loading pressure on a log scale, as the Hill equation is', () => {
    fc.assert(
      fc.property(fc.double({ min: 1.05, max: 6, noNaN: true }), (factor) => {
        const above = haemoglobinSaturation(HALF_LOADED_PRESSURE * factor);
        const below = haemoglobinSaturation(HALF_LOADED_PRESSURE / factor);
        expect(above + below).toBeCloseTo(1, 12);
      }),
    );
  });

  it('loads nearly all haemoglobin in the lungs and gives up a little at rest and most of it in working tissue', () => {
    const lungs = oxygenPhysics('lungs');
    const resting = oxygenPhysics('resting-tissue');
    const active = oxygenPhysics('active-tissue');
    expect(lungs.saturation).toBeGreaterThan(0.95);
    expect(lungs.released).toBe(0);
    expect(resting.releasedShareOfLoad).toBeLessThan(0.35);
    expect(active.releasedShareOfLoad).toBeGreaterThan(0.5);
    expect(active.released).toBeGreaterThan(resting.released * 2);
    // Some oxygen stays on, even in working tissue.
    expect(active.saturation).toBeGreaterThan(0.1);
  });
});

describe('settling and describing a circulation state', () => {
  it('keeps only the keys a view uses, and a focus only for a part it draws', () => {
    for (const state of states) {
      const settled = settleCirculationState(state);
      if (state.view !== 'heart') expect(settled.phase).toBe('filling');
      if (state.view !== 'pressure') expect([settled.flow, settled.vessels]).toEqual(['usual', 'usual']);
      if (state.view !== 'oxygen') expect(settled.where).toBe('lungs');
      if (settled.focus !== 'none') expect(circulationParts(settled)).toContain(settled.focus);
    }
    expect(
      settleCirculationState({
        view: 'oxygen',
        phase: 'ejection',
        flow: 'more',
        vessels: 'narrowed',
        where: 'lungs',
        focus: 'handoff',
      }).focus,
    ).toBe('none');
    expect(
      settleCirculationState({
        view: 'oxygen',
        phase: 'filling',
        flow: 'usual',
        vessels: 'usual',
        where: 'active-tissue',
        focus: 'handoff',
      }).focus,
    ).toBe('handoff');
  });

  it('says a valve is open exactly where the physics says it is', () => {
    for (const phase of CIRCULATION_ENUMS.phase) {
      const physics = heartPhysics(phase);
      const text = describeCirculationState({ ...INITIAL_CIRCULATION_STATE, view: 'heart', phase, focus: 'none' });
      const expected = `The valves between atria and ventricles are ${physics.atrioventricularOpen ? 'open' : 'shut'}; those to the arteries are ${physics.semilunarOpen ? 'open' : 'shut'}.`;
      expect(text, phase).toContain(expected);
      expect(text.includes('Blood is pushed out'), phase).toBe(physics.semilunarOpen);
      expect(text.includes('No blood enters or leaves the ventricles'), phase).toBe(
        !physics.semilunarOpen && !physics.atrioventricularOpen,
      );
    }
  });

  it('says where the biggest fall in pressure is, and that narrowing or widening the arterioles moves the pressure before them', () => {
    const text = (flow: CirculationState['flow'], vessels: CirculationState['vessels']) =>
      describeCirculationState({ view: 'pressure', phase: 'filling', flow, vessels, where: 'lungs', focus: 'none' });
    expect(text('usual', 'usual')).toContain('The biggest fall is across the arterioles:');
    // Wide enough, the arterioles no longer hold the largest share, which the words follow from the physics.
    expect(loopPhysics({ flow: 'usual', vessels: 'widened' }).biggestDrop).toBe('capillaries');
    expect(text('usual', 'widened')).toContain('The biggest fall is across the capillaries:');
    expect(text('usual', 'narrowed')).toContain('narrowed');
    expect(text('usual', 'narrowed')).toContain('the pressure before them is higher');
    expect(text('usual', 'widened')).toContain('the pressure before them is lower');
    expect(text('more', 'usual')).toContain('More blood flows');
  });

  it('draws blood red and blue as a convention and says so, says haemoglobin carries oxygen by a curve of its own, and gives no figure or name', () => {
    for (const state of states) {
      const text = describeCirculationState(state);
      expect(text, JSON.stringify(state)).not.toMatch(/\d|mmHg|heart rate|beats per|disease|medicine|cardiac arrest/iu);
      if (settleCirculationState(state).view === 'circuits') expect(text).toContain(COLOUR_CONVENTION);
      if (settleCirculationState(state).view === 'oxygen') expect(text).toContain('S-shaped');
      expect(text).not.toMatch(/blood is blue|blue blood|all four chambers|at once/iu);
    }
  });
});
