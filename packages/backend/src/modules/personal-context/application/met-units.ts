import type { ExplorationSnapshot } from './ports.js';

/**
 * Explanations the person has already met: qualified evidence and actual retained history. A read of
 * the snapshot, never a new fact; routing history includes unqualified encounters, because "something
 * new" means something they have not seen at all.
 */
export function encounteredUnitsOf(
  snapshot: Pick<ExplorationSnapshot, 'supportingEvidence' | 'routing'>,
): readonly string[] {
  return [
    ...new Set([
      ...snapshot.supportingEvidence.filter((x) => x.qualified).map((x) => x.explanationUnitId),
      ...snapshot.routing.recent.map((r) => r.explanationUnitId),
      ...snapshot.routing.established.filter((u) => u.encountered).map((u) => u.explanationUnitId),
    ]),
  ];
}
