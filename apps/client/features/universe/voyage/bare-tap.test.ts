import { bareTapOf, type BareTapScene } from './bare-tap';
import type { Stop } from './ladder';

const scene = (more: Partial<BareTapScene> = {}): BareTapScene => ({ mapOpens: true, onGlobe: true, ...more });

describe('a tap on the planet that missed every name', () => {
  it('focuses the opened region under it at the planet stop and on the ground, whatever else is true', () => {
    for (const stop of ['planet', 'ground'] as const)
      for (const mapOpens of [true, false])
        for (const onGlobe of [true, false])
          expect(bareTapOf(stop, 'region-a', scene({ mapOpens, onGlobe }))).toEqual({ kind: 'region', id: 'region-a' });
  });

  it('lands on the planet from anywhere else on its globe, and does nothing in the sky round it', () => {
    expect(bareTapOf('planet', null, scene())).toEqual({ kind: 'land' });
    expect(bareTapOf('planet', null, scene({ mapOpens: false }))).toEqual({ kind: 'land' });
    expect(bareTapOf('planet', null, scene({ onGlobe: false }))).toEqual({ kind: 'nothing' });
  });

  it('opens the map from bare ground, and only where a map can open', () => {
    expect(bareTapOf('ground', null, scene())).toEqual({ kind: 'map' });
    expect(bareTapOf('ground', null, scene({ mapOpens: false }))).toEqual({ kind: 'nothing' });
  });

  it('has no land to tap from the outer stop to a star', () => {
    for (const stop of ['outer', 'universe', 'star'] as const satisfies readonly Stop[])
      for (const id of ['region-a', null]) expect(bareTapOf(stop, id, scene())).toEqual({ kind: 'nothing' });
  });
});
