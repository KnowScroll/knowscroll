import { createFlightLegs } from './flight-legs';
import type { VoyageTarget } from './ladder';

const star = (systemId: string): VoyageTarget => ({ stop: 'star', systemId, planetId: null, regionId: null });
const universe: VoyageTarget = { stop: 'universe', systemId: null, planetId: null, regionId: null };

describe('timing a flight for the frame-rate readout', () => {
  it('runs from the ask to the first frame at rest, and counts the shader programs linked on the way', () => {
    const legs = createFlightLegs(universe);
    expect(legs.frame(false, 7, 0)).toBeNull();
    legs.asked(star('a'), 100);
    expect(legs.frame(true, 9, 133)).toBeNull();
    expect(legs.frame(true, 9, 2000)).toBeNull();
    expect(legs.frame(false, 9, 2033)).toEqual({ label: 'star', startMs: 100, endMs: 2033, programsLinked: 2 });
    expect(legs.frame(false, 9, 2066)).toBeNull();
  });

  it('labels a flight to a place already visited, the opening place included', () => {
    const legs = createFlightLegs(universe);
    legs.asked(star('a'), 0);
    legs.frame(false, 0, 10);
    legs.asked(universe, 20);
    expect(legs.frame(false, 0, 30)?.label).toBe('universe again');
    legs.asked(star('a'), 40);
    expect(legs.frame(false, 0, 50)?.label).toBe('star again');
    legs.asked(star('b'), 60);
    expect(legs.frame(false, 0, 70)?.label).toBe('star');
  });

  it('ends a cut (reduced motion) at the first frame after the ask', () => {
    const legs = createFlightLegs(universe);
    legs.frame(false, 3, 0);
    legs.asked(star('a'), 10);
    expect(legs.frame(false, 3, 33)).toEqual({ label: 'star', startMs: 10, endMs: 33, programsLinked: 0 });
  });
});
