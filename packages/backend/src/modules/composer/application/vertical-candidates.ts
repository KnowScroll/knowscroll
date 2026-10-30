import type { EncounterSnapshot, ReadDiscoveryCandidates } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';

/** Retrieval cap of blueprint §9 (100 retrieved). */
export const VERTICAL_RETRIEVAL_LIMIT = 100;

/**
 * Retrieves the admitted candidates for a vertical move (a subject move, not a series, related,
 * variant or return move) in the source's language and on its topics, restricted to the formats
 * the client can render. No formats means nothing can be shown, so nothing is retrieved.
 *
 * With `stickyFormat` the person's format is retrieved first and the other format fills what is left
 * of the cap, so a large catalogue of one format cannot crowd the person's format out of the 100.
 */
export async function readVerticalCandidates(
  read: ReadDiscoveryCandidates,
  scope: PersonalScopeTx,
  input: {
    readonly source?: EncounterSnapshot;
    readonly formats: readonly ('reel' | 'scroll')[];
    readonly capabilities: unknown;
    /** The format to retrieve first. Ignored when the client cannot render it. */
    readonly stickyFormat?: 'reel' | 'scroll';
  },
): Promise<readonly EncounterSnapshot[]> {
  if (input.formats.length === 0) return [];
  const query = (formats: readonly ('reel' | 'scroll')[], limit: number) =>
    read(scope, {
      languages: [input.source?.metadata.language ?? 'en'],
      formats,
      capabilities: input.capabilities,
      topicIds: input.source?.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId) ?? [],
      limit,
    });
  const { stickyFormat } = input;
  const others = input.formats.filter((format) => format !== stickyFormat);
  if (stickyFormat === undefined || !input.formats.includes(stickyFormat) || others.length === 0)
    return query(input.formats, VERTICAL_RETRIEVAL_LIMIT);
  const preferred = await query([stickyFormat], VERTICAL_RETRIEVAL_LIMIT);
  if (preferred.length >= VERTICAL_RETRIEVAL_LIMIT) return preferred;
  return [...preferred, ...(await query(others, VERTICAL_RETRIEVAL_LIMIT - preferred.length))];
}

/** The renderable formats a client's declared document schemas allow. */
export function renderableFormats(documentSchemas: readonly string[]): readonly ('reel' | 'scroll')[] {
  return (['reel', 'scroll'] as const).filter((format) =>
    [`${format}-document.v1`, ...(format === 'scroll' ? ['scroll-document.v2'] : [])].some((schema) =>
      documentSchemas.includes(schema),
    ),
  );
}
