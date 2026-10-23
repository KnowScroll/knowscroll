import type { EncounterSnapshot, ReadDiscoveryCandidates } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';

/** Retrieval cap of blueprint §9 (100 retrieved). */
export const VERTICAL_RETRIEVAL_LIMIT = 100;

/**
 * Retrieves the admitted candidates for a vertical move (a subject move, not a series, related,
 * variant or return move) in the source's language and on its topics, restricted to the formats
 * the client can render. No formats means nothing can be shown, so nothing is retrieved.
 */
export async function readVerticalCandidates(
  read: ReadDiscoveryCandidates,
  scope: PersonalScopeTx,
  input: {
    readonly source?: EncounterSnapshot;
    readonly formats: readonly ('reel' | 'scroll')[];
    readonly capabilities: unknown;
  },
): Promise<readonly EncounterSnapshot[]> {
  if (input.formats.length === 0) return [];
  return read(scope, {
    languages: [input.source?.metadata.language ?? 'en'],
    formats: input.formats,
    capabilities: input.capabilities,
    topicIds: input.source?.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId) ?? [],
    limit: VERTICAL_RETRIEVAL_LIMIT,
  });
}

/** The renderable formats a client's declared document schemas allow. */
export function renderableFormats(documentSchemas: readonly string[]): readonly ('reel' | 'scroll')[] {
  return (['reel', 'scroll'] as const).filter((format) => documentSchemas.includes(`${format}-document.v1`));
}
