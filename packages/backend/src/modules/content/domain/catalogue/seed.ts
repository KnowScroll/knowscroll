import type { LibrarySystem } from '../library/plan.js';
import { nodesOfPlan } from './plan-import.js';
import { planRelease, type ReleasePlan } from './release.js';
import { makeSnapshot, type CatalogueSnapshot } from './snapshot.js';
import type { JsonHash } from './types.js';

/** The first release: the library plan as it was when the catalogue was code, every topic servable (nothing changes for a reader). */
export function seedRelease(
  systems: readonly LibrarySystem[],
  hash: JsonHash,
): Extract<ReleasePlan, { kind: 'release' }> {
  const plan = planRelease(
    { releaseId: 0, digest: '', nodes: [], revisions: [] },
    nodesOfPlan(systems).map((draft) => ({ kind: 'add', draft })),
    hash,
    { visibleOnAdd: true },
  );
  if (plan.kind !== 'release') throw new Error(`CATALOGUE_SEED_INVALID:${plan.kind}`);
  return plan;
}

/**
 * The catalogue the library plan seeds, as a snapshot: for tests and for the plan import, never for a use case, which reads
 * the `Catalogue` port. Its digest is the one stored for the seeded release, which `catalogue-equivalence` checks against a migrated database.
 */
export const seedSnapshot = (systems: readonly LibrarySystem[], hash: JsonHash): CatalogueSnapshot =>
  makeSnapshot(seedRelease(systems, hash).rows, hash);
