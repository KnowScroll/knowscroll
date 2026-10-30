import { describe, expect, it } from 'vitest';
import { LIBRARY_RELATED, LIBRARY_SERIES } from './continuity.js';
import { LIBRARY_SYSTEMS, RECIPES } from './index.js';

describe('library series and related moves', () => {
  it('names only recipes that exist', () => {
    const keys = [
      ...LIBRARY_SERIES.flatMap((series) => series.parts),
      ...LIBRARY_RELATED.flatMap((l) => [l.from, l.to]),
    ];
    for (const key of keys) expect(Object.hasOwn(RECIPES, key), key).toBe(true);
  });

  it('keeps each series to two to four distinct parts on one planet, and a recipe in one series only (so no series loops back)', () => {
    expect(new Set(LIBRARY_SERIES.map((series) => series.id)).size).toBe(LIBRARY_SERIES.length);
    const seen = new Set<string>();
    for (const series of LIBRARY_SERIES) {
      expect(series.id, series.id).toMatch(/^[a-z][a-z0-9.-]{0,159}$/u);
      expect(series.parts.length, series.id).toBeGreaterThanOrEqual(2);
      expect(series.parts.length, series.id).toBeLessThanOrEqual(4);
      expect(new Set(series.parts).size, series.id).toBe(series.parts.length);
      expect(new Set(series.parts.map((key) => RECIPES[key].topicId)).size, series.id).toBe(1);
      for (const key of series.parts) {
        expect(seen.has(key), `${key} is in two series`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('has a series in every system', () => {
    const systems = new Set(LIBRARY_SERIES.map((series) => RECIPES[series.parts[0]!].systemId));
    expect([...systems].sort()).toEqual(LIBRARY_SYSTEMS.map((system) => system.id).sort());
  });

  it('gives each recipe at most one related move, never to itself or to a series neighbour', () => {
    const sources = LIBRARY_RELATED.map((link) => link.from);
    expect(new Set(sources).size).toBe(sources.length);
    const neighbours = new Set(
      LIBRARY_SERIES.flatMap((series) =>
        series.parts.flatMap((key, index) => [
          `${key}>${series.parts[index + 1] ?? ''}`,
          `${key}>${series.parts[index - 1] ?? ''}`,
        ]),
      ),
    );
    for (const link of LIBRARY_RELATED) {
      expect(link.from, link.label).not.toBe(link.to);
      expect(neighbours.has(`${link.from}>${link.to}`), `${link.from} to ${link.to} is a series step`).toBe(false);
      expect(link.label.length, link.from).toBeGreaterThan(0);
      expect(link.label.length, link.from).toBeLessThanOrEqual(160);
      expect(RECIPES[link.from].explanationUnitId, link.from).not.toBe(RECIPES[link.to].explanationUnitId);
    }
  });

  it('makes "Seasons elsewhere" Part 3 of the Seasons thread, and reaches seasons-limits as a related move', () => {
    const seasons = LIBRARY_SERIES.find((series) => series.id === 'library.earth.seasons');
    expect(seasons?.parts).toEqual(['seasons', 'seasons-hemispheres', 'seasons-elsewhere']);
    expect(LIBRARY_RELATED).toContainEqual({
      from: 'seasons-elsewhere',
      to: 'seasons-limits',
      label: 'Where the simple tilt picture breaks down',
    });
    // seasons-limits is in no series, so no recipe is in two.
    expect(LIBRARY_SERIES.flatMap((series) => series.parts)).not.toContain('seasons-limits');
  });
});
