import type { EncounterSnapshot, ReadDiscoveryCandidates, UnitCondition } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ComposeEncounter } from './ports.js';

/** Retrieval cap of blueprint §9 (100 retrieved). */
export const VERTICAL_RETRIEVAL_LIMIT = 100;

/** Whether the configured policy wants retrieval to read the person's unseen explanations first (policy v2, D-408). */
export const wantsUnseenFirst = (compose: ComposeEncounter): boolean => compose.policy?.encountered === 'unseen-first';

/**
 * Candidates of the format the person is not in that are always read beside theirs. Format stickiness gives way when
 * nothing unseen is left in the person's format (policy v2), so there must be other-format candidates to give way to, even
 * in a library with more than 100 candidates in the person's format. Under v0 and v1 they are excluded while any of the
 * person's format is eligible, as before.
 */
export const OTHER_FORMAT_RESERVE = 20;

/**
 * Retrieves the admitted candidates for a vertical move (a subject move, not a series, related,
 * variant or return move) in the source's language and on its topics, restricted to the formats
 * the client can render. No formats means nothing can be shown, so nothing is retrieved.
 *
 * With `stickyFormat` the person's format is retrieved first (up to the cap less {@link OTHER_FORMAT_RESERVE}) and the other
 * format fills what is left of the cap, so a large catalogue of one format cannot crowd the person's format out of the 100
 * nor the other format out of them. `seed` (the decision's seed) picks where in each lane's random order retrieval starts.
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
    /** The decision's seed: each decision reads a different slice of a large library, the same seed the same slice. */
    readonly seed?: string;
    /**
     * Policy v2: holds for an explanation the person has not met. Every lane then reads those first and fills what is left
     * with the rest, so unseen explanations outside a random slice are found, and the format the person is not in has
     * unseen candidates to give way to. The source's own unit is always read, so its format twin (and so its series) is found.
     */
    readonly unseenFirst?: UnitCondition;
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
      ...(input.seed === undefined ? {} : { rotation: input.seed }),
      ...(input.unseenFirst === undefined
        ? {}
        : {
            unseenFirst: input.unseenFirst,
            alwaysUnits: input.source ? [input.source.explanationUnitId] : [],
          }),
    });
  const { stickyFormat } = input;
  const others = input.formats.filter((format) => format !== stickyFormat);
  if (stickyFormat === undefined || !input.formats.includes(stickyFormat) || others.length === 0)
    return query(input.formats, VERTICAL_RETRIEVAL_LIMIT);
  const preferred = await query([stickyFormat], VERTICAL_RETRIEVAL_LIMIT - OTHER_FORMAT_RESERVE);
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
