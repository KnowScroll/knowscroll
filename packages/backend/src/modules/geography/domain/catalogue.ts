/** One catalogue entry: a system (`parent` null, no facets) or a topic of a system with its facets. */
export interface CatalogueTopic {
  readonly id: string;
  readonly parent: string | null;
  readonly meaning: string;
  readonly facets: readonly { readonly id: string; readonly meaning: string }[];
}

/**
 * The pinned catalogue Cartographer evaluates against (D-416): lookups by id and by system, with each entry's
 * position so an evaluation walks topics in catalogue order. A run reads only the entries of the topics it evaluates,
 * so lookups are by id, never a scan of the whole catalogue.
 */
export interface Catalogue {
  topic(id: string): CatalogueTopic | undefined;
  /** The topics of one system, in catalogue order. Empty for an unknown id or a topic. */
  childrenOf(systemId: string): readonly CatalogueTopic[];
  /** Position in the catalogue, for ordering. Unknown ids sort last. */
  rank(id: string): number;
}

export function catalogueOf(entries: readonly CatalogueTopic[]): Catalogue {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rank = new Map(entries.map((entry, index) => [entry.id, index]));
  const children = new Map<string, CatalogueTopic[]>();
  for (const entry of entries)
    if (entry.parent !== null) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry]);
  return {
    topic: (id) => byId.get(id),
    childrenOf: (systemId) => children.get(systemId) ?? [],
    rank: (id) => rank.get(id) ?? Number.MAX_SAFE_INTEGER,
  };
}
