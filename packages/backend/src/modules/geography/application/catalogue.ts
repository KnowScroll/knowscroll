import { FORMATION_DEFAULTS, type CatalogueConcept, type CatalogueSnapshot } from '../../content/public.js';
import type { Catalogue, CatalogueTopic } from '../domain/catalogue.js';

/** The formation thresholds a node sets, only where they are not the defaults, so a catalogue that never changed them freezes what it always did. */
function policyOf(concept: CatalogueConcept): CatalogueTopic['policy'] {
  const { systemUnits, planetUnits, planetFacets } = concept.policy;
  const policy = {
    ...(concept.kind === 'system' && systemUnits !== FORMATION_DEFAULTS.systemUnits ? { systemUnits } : {}),
    ...(concept.kind === 'topic' && planetUnits !== FORMATION_DEFAULTS.planetUnits ? { planetUnits } : {}),
    ...(concept.kind === 'topic' && planetFacets !== FORMATION_DEFAULTS.planetFacets ? { planetFacets } : {}),
  };
  return Object.keys(policy).length === 0 ? undefined : policy;
}

const pinned = new WeakMap<CatalogueSnapshot, Catalogue>();

/**
 * One release of the topic catalogue as Cartographer evaluates against it (D-416, D-419): the same immutable release for a whole
 * evaluation, so a context and its re-check at apply read one catalogue however many have been released since. A retired node
 * resolves by id (what is stored for it stays valid) but is left out of the children, so no new place forms on it. A snapshot is
 * immutable, so its pin is made once and its indexes only when first asked for.
 */
export function pinCatalogue(snapshot: CatalogueSnapshot): Catalogue {
  const known = pinned.get(snapshot);
  if (known !== undefined) return known;
  const entries = new Map<string, CatalogueTopic>();
  const lookup = (id: string): CatalogueTopic | undefined => {
    const made = entries.get(id);
    if (made !== undefined) return made;
    const concept = snapshot.concept(id);
    if (concept === undefined) return undefined;
    const policy = policyOf(concept);
    const entry: CatalogueTopic = {
      id: concept.id,
      parent: concept.parent,
      meaning: concept.meaning,
      label: concept.label,
      facets: concept.facets,
      ...(policy === undefined ? {} : { policy }),
    };
    entries.set(id, entry);
    return entry;
  };
  let order: ReadonlyMap<string, number> | undefined;
  let children: ReadonlyMap<string, readonly CatalogueTopic[]> | undefined;
  const catalogue: Catalogue = {
    releaseId: snapshot.releaseId,
    topic: lookup,
    childrenOf(systemId) {
      if (children === undefined) {
        const byParent = new Map<string, CatalogueTopic[]>();
        for (const concept of snapshot.allTopics())
          if (concept.parent !== null)
            byParent.set(concept.parent, [...(byParent.get(concept.parent) ?? []), lookup(concept.id)!]);
        children = byParent;
      }
      return children.get(systemId) ?? [];
    },
    rank(id) {
      order ??= new Map(snapshot.all().map((concept, index) => [concept.id, index]));
      return order.get(id) ?? Number.MAX_SAFE_INTEGER;
    },
    retired: (id) => snapshot.concept(id)?.retired ?? false,
    acceptsMeaning: (topicId, facetId, sha256) => snapshot.acceptsMeaning(topicId, facetId, sha256),
  };
  pinned.set(snapshot, catalogue);
  return catalogue;
}
