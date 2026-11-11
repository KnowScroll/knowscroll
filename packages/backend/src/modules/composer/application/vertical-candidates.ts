import {
  UNSEEN_FIRST_MAX_UNITS,
  systemOfTopic,
  type DiscoveryLanes,
  type EncounterSnapshot,
  type ReadDiscoveryCandidates,
  type UnseenFirst,
} from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ComposeEncounter, InterestRollups, ReadInterestContext, ReadMetUnitIds } from './ports.js';

/** Retrieval cap of blueprint §9 (100 retrieved). */
export const VERTICAL_RETRIEVAL_LIMIT = 100;

/** Whether the configured policy wants retrieval to read the person's unseen explanations first (policy v2, D-408). */
export const wantsUnseenFirst = (compose: ComposeEncounter): boolean => compose.policy?.encountered === 'unseen-first';

/** Whether the configured policy reads named retrieval lanes and the person's long-term interest (policy v3, D-420). */
export const wantsLanes = (compose: ComposeEncounter): boolean => compose.policy?.retrieval === 'lanes';

/**
 * What a lane-reading retrieval needs of the person before it reads (policy v3): their top interest topics, as one index range
 * scan of Evidence, and the units a valid Planner opportunity names. Content gets them as data.
 */
export async function readInterestLeads(
  read: ReadInterestContext,
  scope: PersonalScopeTx,
  query: { readonly evaluatedAt: string; readonly topK: number },
): Promise<DiscoveryLanes> {
  const leads = await read.leads(scope, query);
  return { continueTopicIds: leads.topics.map((topic) => topic.topicId), plannedUnitIds: leads.plannedUnitIds };
}

/** The catalogue systems of the candidates' non-incidental topics, in first-seen order, bounded for one roll-up read. */
export function systemIdsOf(candidates: readonly Pick<EncounterSnapshot, 'topics'>[], limit = 100): readonly string[] {
  const systems = candidates.flatMap((candidate) =>
    candidate.topics.filter((t) => t.role !== 'incidental').flatMap((t) => systemOfTopic(t.topicId) ?? []),
  );
  return [...new Set(systems)].slice(0, limit);
}

/**
 * The roll-ups policy v3's interest and format features shrink toward: the person's overall level and the systems of the
 * retrieved candidates. Read after retrieval, in the same transaction, and written into the snapshot beside the topic rows.
 */
export function readInterestRollups(
  read: ReadInterestContext,
  scope: PersonalScopeTx,
  candidates: readonly Pick<EncounterSnapshot, 'topics'>[],
  evaluatedAt: string,
): Promise<InterestRollups> {
  return read.rollups(scope, { evaluatedAt, systemIds: systemIdsOf(candidates) });
}

/**
 * What policy v2's retrieval needs of the person's history: the explanation units they have met, read through Experience's
 * public port, newest first and bounded by {@link UNSEEN_FIRST_MAX_UNITS}. Past the bound a heavier reader's oldest met units
 * are not named, so retrieval may order them as unseen; the Composer's own `encountered` exclusion still filters the final pick
 * (D-408).
 */
export async function readUnseenFirst(read: ReadMetUnitIds, scope: PersonalScopeTx): Promise<UnseenFirst> {
  const met = await read(scope, { limit: UNSEEN_FIRST_MAX_UNITS });
  return { metUnitIds: met.unitIds };
}

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
     * Policy v2: the explanation units the person has met. Every lane then reads the explanations not in the list first and
     * fills what is left with the rest, so unseen explanations outside a random slice are found, and the format the person is
     * not in has unseen candidates to give way to. The source's own unit is always read, so its format twin (and so its
     * series) is found.
     */
    readonly unseenFirst?: UnseenFirst;
    /** Policy v3: read named lanes with quotas (the person's top interest topics, planned units) and label each candidate with its lane. */
    readonly lanes?: DiscoveryLanes;
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
      ...(input.lanes === undefined ? {} : { lanes: input.lanes }),
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
