import { describe, expect, it } from 'vitest';
import {
  describeGreenhouseState,
  GREENHOUSE_ENUMS,
  greenhouseParts,
  greenhousePhysics,
  LAYER_ABSORPTION,
  REFLECTED_SHARE,
  settleGreenhouseState,
  type GreenhouseLayer,
  type GreenhouseState,
} from './greenhouse.js';

const LAYERS = GREENHOUSE_ENUMS.layer;
const ABSORBED = 1 - REFLECTED_SHARE;

/**
 * The ground's energy written out again independently, by letting it warm in small steps. The ground
 * gains the sunlight it takes up and the infrared the layer sends back down, and loses the infrared it
 * sends up; its temperature rises while it gains more than it loses. The kit never does this: it solves
 * the balance in one line. Temperature is in units where the infrared sent up is the fourth power of it.
 */
function warmGround(share: number, startEmission: number, steps: number): { emission: number; gainAtStart: number } {
  const rate = 0.01;
  let temperature = startEmission ** 0.25;
  const gain = (): number => ABSORBED + (share * temperature ** 4) / 2 - temperature ** 4;
  const gainAtStart = gain();
  for (let step = 0; step < steps; step += 1) temperature += rate * gain();
  return { emission: temperature ** 4, gainAtStart };
}

describe('the greenhouse physics against a ground that warms in small steps', () => {
  it('settles at the infrared the ground sends up that the energy balance gives, for each layer', () => {
    for (const layer of LAYERS) {
      const settled = warmGround(LAYER_ABSORPTION[layer], ABSORBED, 400_000).emission;
      expect(greenhousePhysics({ layer, change: 'settled' }).surfaceEmission, layer).toBeCloseTo(settled, 6);
    }
  });

  it('has the ground gain exactly the imbalance in the first moment after the layer thickens, then nothing once settled', () => {
    for (const layer of ['thin', 'thick'] as const) {
      const before: GreenhouseLayer = layer === 'thin' ? 'none' : 'thin';
      const warmBefore = warmGround(LAYER_ABSORPTION[before], ABSORBED, 400_000).emission;
      const justAfter = warmGround(LAYER_ABSORPTION[layer], warmBefore, 0);
      const physics = greenhousePhysics({ layer, change: 'just-thickened' });
      expect(physics.surfaceEmission, layer).toBeCloseTo(warmBefore, 6);
      expect(physics.imbalance, layer).toBeCloseTo(justAfter.gainAtStart, 6);
      expect(physics.imbalance).toBeGreaterThan(0);
      expect(greenhousePhysics({ layer, change: 'settled' }).imbalance, layer).toBeCloseTo(0, 12);
    }
  });

  it('keeps the books: every flow adds up, and the layer makes no energy', () => {
    for (const layer of LAYERS)
      for (const change of GREENHOUSE_ENUMS.change) {
        const physics = greenhousePhysics({ layer, change });
        const share = LAYER_ABSORPTION[layer];
        expect(physics.reflected + physics.absorbed, `${layer} ${change}`).toBeCloseTo(1, 12);
        // The layer sends out as much as it takes in, half up and half down.
        expect(physics.layerUp + physics.backDown).toBeCloseTo(share * physics.surfaceEmission, 12);
        expect(physics.layerUp).toBeCloseTo(physics.backDown, 12);
        expect(physics.passesThrough + share * physics.surfaceEmission).toBeCloseTo(physics.surfaceEmission, 12);
        expect(physics.toSpace).toBeCloseTo(physics.passesThrough + physics.layerUp, 12);
        // No energy is made: what reaches space never exceeds what arrives, and settled it is exactly that.
        expect(physics.toSpace).toBeLessThanOrEqual(physics.absorbed + 1e-12);
        expect(physics.imbalance).toBeCloseTo(physics.absorbed - physics.toSpace, 12);
      }
  });

  it('sends more up from the ground the thicker the layer, returns more of it, and warms the ground more', () => {
    const settled = LAYERS.map((layer) => greenhousePhysics({ layer, change: 'settled' }));
    for (let index = 1; index < settled.length; index += 1) {
      expect(settled[index]?.surfaceEmission ?? 0).toBeGreaterThan(settled[index - 1]?.surfaceEmission ?? 0);
      expect(settled[index]?.backDown ?? 0).toBeGreaterThan(settled[index - 1]?.backDown ?? 0);
      expect(settled[index]?.warmth ?? 0).toBeGreaterThan(settled[index - 1]?.warmth ?? 0);
    }
    expect(settled[0]?.warmth).toBeCloseTo(0, 12);
    expect(settled.at(-1)?.warmth).toBeCloseTo(1, 12);
    expect(settled[0]?.backDown).toBe(0);
  });

  it('keeps the ground as warm as it was just after the layer thickens', () => {
    expect(greenhousePhysics({ layer: 'thick', change: 'just-thickened' }).warmth).toBeCloseTo(
      greenhousePhysics({ layer: 'thin', change: 'settled' }).warmth,
      12,
    );
    expect(greenhousePhysics({ layer: 'thin', change: 'just-thickened' }).warmth).toBeCloseTo(0, 12);
  });
});

describe('settling and describing a greenhouse state', () => {
  const states = GREENHOUSE_ENUMS.view.flatMap((view) =>
    LAYERS.flatMap((layer) =>
      GREENHOUSE_ENUMS.change.flatMap((change) =>
        GREENHOUSE_ENUMS.focus.map((focus): GreenhouseState => ({ view, layer, change, focus })),
      ),
    ),
  );

  it('draws the layer and what it sends back only where there is a layer, and a thickening only where it can show', () => {
    for (const state of states) {
      const parts = greenhouseParts(state);
      expect(parts.includes('layer') && state.view !== 'energy-balance', JSON.stringify(state)).toBe(
        state.layer !== 'none' && state.view !== 'energy-balance',
      );
      expect(parts.includes('back-down')).toBe(state.view === 'infrared' && state.layer !== 'none');
      const settled = settleGreenhouseState(state);
      expect(settled.change === 'just-thickened').toBe(
        state.change === 'just-thickened' && state.view !== 'sunlight' && state.layer !== 'none',
      );
      if (settled.focus !== 'none') expect(greenhouseParts(settled)).toContain(settled.focus);
    }
    expect(
      settleGreenhouseState({ view: 'infrared', layer: 'none', change: 'just-thickened', focus: 'back-down' }),
    ).toEqual({ view: 'infrared', layer: 'none', change: 'settled', focus: 'none' });
  });

  it('never calls the layer a lid, a blanket or a trap, and never says energy is made', () => {
    for (const state of states)
      expect(describeGreenhouseState(state), JSON.stringify(state)).not.toMatch(
        /\blid\b|blanket|\btrap|create|produce|\bmakes? (?:more )?energy|\d/iu,
      );
  });

  it('says it is a simple one-layer picture, and that the layer lets sunlight through only in this picture', () => {
    for (const state of states) expect(describeGreenhouseState(state)).toContain('not the real atmosphere');
    expect(describeGreenhouseState({ view: 'sunlight', layer: 'thin', change: 'settled', focus: 'none' })).toContain(
      'the real atmosphere absorbs a little of it too',
    );
  });

  it('agrees with the flows: more infrared up than sunlight in, once settled with a layer; level energy bars once settled', () => {
    for (const state of states) {
      const settled = settleGreenhouseState(state);
      const text = describeGreenhouseState(state);
      const physics = greenhousePhysics(settled);
      if (settled.view === 'infrared' && settled.layer !== 'none' && settled.change === 'settled')
        expect(text, JSON.stringify(state)).toContain('sends up more infrared than the sunlight it takes up');
      if (settled.view === 'energy-balance') {
        expect(text.includes('The two bars are equal'), JSON.stringify(state)).toBe(Math.abs(physics.imbalance) < 1e-9);
        expect(text.includes('for now more arrives than leaves'), JSON.stringify(state)).toBe(
          Math.abs(physics.imbalance) >= 1e-9,
        );
      }
    }
  });

  it('describes a layer just thickened as letting less energy leave than arrives, and only that', () => {
    const thin = describeGreenhouseState({ view: 'infrared', layer: 'thin', change: 'just-thickened', focus: 'none' });
    expect(thin).toContain('for now less infrared reaches space than the sunlight the ground takes up');
    const thick = describeGreenhouseState({
      view: 'energy-balance',
      layer: 'thick',
      change: 'just-thickened',
      focus: 'none',
    });
    expect(thick).toContain('warms until the two bars match');
    expect(thick).toContain('as warm as it was before the layer thickened');
  });
});
