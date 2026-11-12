/** One catalogue entry: a system (`parent` null, no facets) or a topic of a system with its facets. */
export interface CatalogueTopic {
  readonly id: string;
  readonly parent: string | null;
  readonly meaning: string;
  /** A short plain name (D-419); the catalogue's own, absent only for a catalogue built from bare entries. */
  readonly label?: string;
  readonly facets: readonly { readonly id: string; readonly meaning: string; readonly label?: string }[];
  /**
   * The formation thresholds this node sets where they are not the defaults (D-419): present only then, so a catalogue that never
   * changed them freezes the same facts as before. A system sets `systemUnits`; a topic sets `planetUnits` and `planetFacets`.
   */
  readonly policy?: { readonly systemUnits?: number; readonly planetUnits?: number; readonly planetFacets?: number };
}

/**
 * The pinned catalogue Cartographer evaluates against (D-416, D-419): one immutable release, with lookups by id and by system and
 * each entry's position so an evaluation walks topics in catalogue order. A run reads only the entries of the topics it evaluates,
 * so lookups are by id, never a scan of the whole catalogue.
 */
export interface Catalogue {
  /** The release this is (D-419): what a frozen context pins, and what its apply reads again. */
  readonly releaseId: number;
  /** An entry by id, of any status: a place stored for a topic a later release retired still resolves. */
  topic(id: string): CatalogueTopic | undefined;
  /** The topics of one system, in catalogue order, never a retired one. Empty for an unknown id or a topic. */
  childrenOf(systemId: string): readonly CatalogueTopic[];
  /** Position in the catalogue, for ordering. Unknown ids sort last. */
  rank(id: string): number;
  /** True for a node a release retired: nothing new forms on it, though what is stored for it stays valid. */
  retired(id: string): boolean;
  /** Whether a recorded meaning identity of a facet still stands: the current wording, or one a revision declared the same. */
  acceptsMeaning(topicId: string, facetId: string, sha256: string): boolean;
}

export function catalogueOf(
  entries: readonly CatalogueTopic[],
  options: {
    readonly releaseId?: number;
    readonly retired?: ReadonlySet<string>;
    readonly acceptsMeaning?: Catalogue['acceptsMeaning'];
  } = {},
): Catalogue {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rank = new Map(entries.map((entry, index) => [entry.id, index]));
  const retired = options.retired ?? new Set<string>();
  const children = new Map<string, CatalogueTopic[]>();
  for (const entry of entries)
    if (entry.parent !== null && !retired.has(entry.id))
      children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry]);
  return {
    releaseId: options.releaseId ?? 1,
    topic: (id) => byId.get(id),
    childrenOf: (systemId) => children.get(systemId) ?? [],
    rank: (id) => rank.get(id) ?? Number.MAX_SAFE_INTEGER,
    retired: (id) => retired.has(id),
    acceptsMeaning: options.acceptsMeaning ?? (() => false),
  };
}
