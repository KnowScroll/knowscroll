import { paletteOf } from './planet-palette';
import { turnHue } from './hue';

const TYPES = ['lush', 'ocean', 'frozen', 'scorched', 'barren', 'gas'] as const;

/** The prototype's flat sea of the ground for each type (`WV.<type>.sea`, `Universe.dc.html` lines 1213 to 1220). */
const PROTOTYPE_FLAT_SEA = {
  lush: ['#1d7d97', '#0f5670'],
  ocean: ['#33a7ea', '#1667b6'],
  frozen: ['#4f8fcf', '#24599a'],
  scorched: ['#5c1a2a', '#360b1a'],
  barren: ['#8a7a9c', '#5a4c6c'],
  gas: ['#f592b0', '#c294e0'],
} as const;

describe('the planet palettes', () => {
  it.each(TYPES)("gives a %s planet the prototype's flat sea, which is not one of its globe stops", (type) => {
    const palette = paletteOf(type, 0);
    expect(palette.flatSea).toEqual(PROTOTYPE_FLAT_SEA[type]);
    for (const stop of palette.sea) expect(palette.flatSea).not.toContain(stop);
  });

  it('turns the flat sea with the hue as it turns the globe stops', () => {
    for (const type of TYPES) {
      const palette = paletteOf(type, -80);
      expect(palette.flatSea).toEqual(PROTOTYPE_FLAT_SEA[type].map((colour) => turnHue(colour, -80)));
      expect(palette.sea[1]).toBe(turnHue(paletteOf(type, 0).sea[1], -80));
    }
    expect(paletteOf('frozen', -80).flatSea[0]).not.toBe(paletteOf('frozen', 0).flatSea[0]);
  });

  it('has polar caps only for the frozen type', () => {
    expect(TYPES.filter((type) => paletteOf(type, 0).poleCaps)).toEqual(['frozen']);
  });
});
