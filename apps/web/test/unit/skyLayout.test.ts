import { describe, expect, it } from 'vitest';
import { keptSlots, STAR_RADIUS, starSlots, worldOrbits } from '../../src/cosmos/skyLayout.ts';
import { deriveSky } from '../../src/cosmos/starView.ts';
import { ids, twoStarSky } from './skyFixture.ts';

/** Typical sky boxes: a 16:10 desktop and a 9:16 phone. Distances are measured in pixels of the box. */
const BOXES = { landscape: { portrait: false, width: 1280, height: 800 }, portrait: { portrait: true, width: 390, height: 700 } } as const;

function minDistance(slots: { left: number; top: number }[], width: number, height: number): number {
  let min = Infinity;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const dx = ((slots[i]!.left - slots[j]!.left) / 100) * width;
      const dy = ((slots[i]!.top - slots[j]!.top) / 100) * height;
      min = Math.min(min, Math.hypot(dx, dy));
    }
  }
  return min;
}

describe('sky layout', () => {
  it.each(Object.entries(BOXES))('keeps every pair of stars at least a tenth of the shorter side apart, 1..16 stars (%s)', (_, box) => {
    for (let count = 1; count <= 16; count++) {
      const slots = starSlots(count, box.portrait);
      expect(slots).toHaveLength(count);
      if (count > 1) expect(minDistance(slots, box.width, box.height), `${count} stars`).toBeGreaterThanOrEqual(0.1 * Math.min(box.width, box.height));
      expect(new Set(slots.map(slot => `${slot.left.toFixed(3)},${slot.top.toFixed(3)}`)).size).toBe(count);
    }
  });

  it.each([false, true])('keeps every star inside the sky (portrait: %s)', portrait => {
    for (let count = 1; count <= 16; count++) {
      for (const slot of starSlots(count, portrait)) {
        expect(slot.left).toBeGreaterThanOrEqual(9);
        expect(slot.left).toBeLessThanOrEqual(91);
        expect(slot.top).toBeGreaterThanOrEqual(8);
        expect(slot.top).toBeLessThanOrEqual(92);
      }
    }
  });

  it('is deterministic and gives the first (most developed) star the centre at every count', () => {
    expect(starSlots(0, false)).toEqual([]);
    expect(starSlots(7, true)).toEqual(starSlots(7, true));
    for (const portrait of [false, true]) {
      expect(starSlots(1, portrait)).toEqual([{ left: 50, top: 50 }]);
      for (let count = 2; count <= 16; count++) expect(starSlots(count, portrait)[0]).toEqual({ left: 50, top: 50 });
    }
  });

  it('draws a star by its condition, never by a count', () => {
    expect(Object.keys(STAR_RADIUS).sort()).toEqual(['luminous', 'quiet', 'stirring', 'tense']);
    expect(STAR_RADIUS.quiet).toBeLessThan(STAR_RADIUS.stirring);
    expect(STAR_RADIUS.stirring).toBeLessThanOrEqual(STAR_RADIUS.tense);
    expect(STAR_RADIUS.tense).toBeLessThan(STAR_RADIUS.luminous);
  });

  it.each([false, true])('keeps kept lights inside the sky and apart (with stars: %s)', hasStars => {
    for (let count = 0; count <= 12; count++) {
      const slots = keptSlots(count, hasStars);
      expect(slots).toHaveLength(count);
      for (const slot of slots) {
        expect(slot.left).toBeGreaterThanOrEqual(6);
        expect(slot.left).toBeLessThanOrEqual(94);
        expect(slot.top).toBeGreaterThanOrEqual(6);
        expect(slot.top).toBeLessThanOrEqual(95);
      }
      expect(new Set(slots.map(slot => `${slot.left.toFixed(3)},${slot.top.toFixed(3)}`)).size).toBe(count);
    }
    // Beside stars, kept lights stay low in the sky, under the star field.
    if (hasStars) for (const slot of keptSlots(8, true)) expect(slot.top).toBeGreaterThanOrEqual(80);
  });

  it('puts facet worlds on inner orbits and question worlds outside them, one orbit entry per world', () => {
    const gravity = deriveSky(twoStarSky()).stars.find(star => star.placeId === ids.gravity)!;
    const orbits = worldOrbits(gravity);
    expect(orbits.map(item => item.id)).toEqual(gravity.worlds.map(world => world.id));
    const facet = orbits.filter((_, i) => gravity.worlds[i]!.kind === 'facet').map(item => item.orbit);
    const question = orbits.filter((_, i) => gravity.worlds[i]!.kind === 'question').map(item => item.orbit);
    expect(Math.max(...facet)).toBeLessThan(Math.min(...question));
    expect(worldOrbits(gravity)).toEqual(orbits);
  });
});
