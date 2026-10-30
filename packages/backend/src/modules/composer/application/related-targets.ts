import type { EncounterSnapshot, ReadContinuations } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';

/** A thread has at most a few parts; this bounds the continuity reads of one vertical move. */
const MAX_CONTINUITY_READS = 8;

/**
 * The assets the person can reach from the thread they are in by the Related tab, by asset id (any
 * revision): the related continuity of the source, of its format twins (so a Reel counts what its
 * Scroll has), and of every other part of the source's series found among `candidates` (the thread's
 * Related tab sits on one part, and the whole thread owns it). The series of a Reel is not known, so
 * for a Reel only its own and its twins' continuity count.
 *
 * Reads shared admitted links only; no personal data, no model, no network.
 */
export async function readRelatedAssetIds(
  read: ReadContinuations,
  scope: PersonalScopeTx,
  source: EncounterSnapshot,
  candidates: readonly EncounterSnapshot[],
): Promise<readonly string[]> {
  const seriesId = source.series?.seriesId;
  const parts = seriesId === undefined ? [] : candidates.filter((candidate) => candidate.series?.seriesId === seriesId);
  const refs = new Map(
    [source, ...source.siblings, ...parts]
      .slice(0, MAX_CONTINUITY_READS)
      .map((ref) => [`${ref.assetId}@${String(ref.assetRevision)}`, ref] as const),
  );
  const targets = new Set<string>();
  for (const ref of refs.values())
    for (const link of await read(scope, ref)) if (link.direction === 'related') targets.add(link.target.assetId);
  return [...targets];
}
