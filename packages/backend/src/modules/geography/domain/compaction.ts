import { FORMATION, type Support } from './policy.js';

/** A support with the size of what it adds to the frozen context (itself and its proof). */
export interface WeightedSupport {
  readonly support: Support;
  readonly bytes: number;
}

/** What one frozen context can hold. */
export interface SupportBudget {
  readonly count: number;
  readonly bytes: number;
}

const newestFirst = (a: WeightedSupport, b: WeightedSupport) =>
  Date.parse(b.support.activatedAt) - Date.parse(a.support.activatedAt) || a.support.ref.localeCompare(b.support.ref);

/**
 * Chooses the supports that go into one frozen context when there are more than it can hold. The
 * choice is deterministic and keeps what the formation rules read:
 *
 * 1. the newest support of every facet of every planet: every region stays supported, a planet keeps
 *    its facet variety, and a place's latest activity is exact;
 * 2. then, per planet, the newest supports of further distinct units until it holds as many units as
 *    a planet needs: unit thresholds for planets and systems stay exact;
 * 3. then whatever else fits, newest first.
 *
 * Within the budget this changes no place the rules would form and no activity they would set.
 * Past it, the oldest and most repetitive support goes first, so the rules degrade instead of
 * stopping.
 */
export function compactSupports<T extends WeightedSupport>(entries: readonly T[], budget: SupportBudget): readonly T[] {
  if (entries.length <= budget.count && entries.reduce((sum, entry) => sum + entry.bytes, 0) <= budget.bytes)
    return entries;
  const byPlanet = new Map<string, T[]>();
  for (const entry of entries)
    byPlanet.set(entry.support.topicId, [...(byPlanet.get(entry.support.topicId) ?? []), entry]);
  const facetTier: T[] = [],
    unitTier: T[] = [],
    restTier: T[] = [];
  for (const [, planet] of [...byPlanet].sort(([a], [b]) => a.localeCompare(b))) {
    const ranked = [...planet].sort(newestFirst),
      facets = new Set<string>(),
      units = new Set<string>(),
      chosen = new Set<T>();
    for (const entry of ranked) {
      if (facets.has(entry.support.facetId)) continue;
      facets.add(entry.support.facetId);
      units.add(entry.support.explanationUnitId);
      chosen.add(entry);
      facetTier.push(entry);
    }
    for (const entry of ranked) {
      if (units.size >= FORMATION.planetUnits) break;
      if (units.has(entry.support.explanationUnitId)) continue;
      units.add(entry.support.explanationUnitId);
      chosen.add(entry);
      unitTier.push(entry);
    }
    restTier.push(...ranked.filter((entry) => !chosen.has(entry)));
  }
  const kept = new Set<T>();
  let bytes = 0;
  for (const entry of [...facetTier.sort(newestFirst), ...unitTier.sort(newestFirst), ...restTier.sort(newestFirst)]) {
    if (kept.size >= budget.count || bytes + entry.bytes > budget.bytes) continue;
    kept.add(entry);
    bytes += entry.bytes;
  }
  return entries.filter((entry) => kept.has(entry));
}
