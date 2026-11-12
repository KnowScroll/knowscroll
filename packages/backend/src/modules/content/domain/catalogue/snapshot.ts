import type { HazeFamilyName, SceneFamilyName } from '../library/plan.js';
import {
  CONCEPT_CATALOGUE_VERSION,
  FORMATION_DEFAULTS,
  type FormationPolicy,
  type JsonHash,
  type NodeRow,
  type ReleaseRows,
  type RevisionRow,
} from './types.js';

/** A facet of a topic: a kind of angle it can be explained from. */
export interface CatalogueFacet {
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
}

/**
 * A system or a topic as the code reads it. Facets are in the order they were added, which never changes: a facet's place in
 * the list is the site its region is drawn on.
 */
export interface CatalogueConcept {
  readonly id: string;
  readonly kind: 'system' | 'topic';
  /** The system a topic belongs to; `null` for a system. */
  readonly parent: string | null;
  /** A short plain name, for a person's list or a room: "Greenhouse effect". */
  readonly label: string;
  readonly meaning: string;
  /** The angles a topic can be explained from; always empty for a system. */
  readonly facets: readonly CatalogueFacet[];
  readonly retired: boolean;
  /**
   * A topic is servable (offered, matched, listed) once the library has released supply for it; a new topic is not until then.
   * Always true for a system that has a servable topic, never for a retired node.
   */
  readonly servable: boolean;
  /** The silhouette family set on the node itself; a topic without one is drawn with its system's. */
  readonly sceneFamily: SceneFamilyName | null;
  /** The haze around a system's sun; `null` on a topic. */
  readonly haze: HazeFamilyName | null;
  /** The formation thresholds the node carries (D-419). */
  readonly policy: FormationPolicy;
  /** The release that introduced the node. */
  readonly introducedIn: number;
}

/** What a coverage binding pins: the exact meanings of a topic and one of its facets. */
export interface FacetMeaning {
  readonly topicId: string;
  readonly topicMeaning: string;
  readonly facetId: string;
  readonly facetMeaning: string;
}

/**
 * One release of the catalogue, immutable and synchronous: everything a use case reads of the catalogue comes from one
 * snapshot, so a rule that looks at it twice never sees two catalogues. A lookup by id finds a node of any status; only the
 * listings leave out retired nodes and, for topics, the ones that are not yet servable.
 */
export interface CatalogueSnapshot {
  readonly releaseId: number;
  /** The digest of the release: the value a coverage mapping records as `catalogueSha256`. */
  readonly digest: string;
  /** Every active system and topic, servable or not, in catalogue order. The digest covers exactly these. */
  readonly all: () => readonly CatalogueConcept[];
  /** A system or a topic by its exact id, whatever its status. Prefixes, labels and lookalikes never match. */
  readonly concept: (id: string) => CatalogueConcept | undefined;
  /** Whether the id was ever a node of this release, of any kind and status: a stable id is never reused. */
  readonly has: (id: string) => boolean;
  /** The systems that have a servable topic, in catalogue order. */
  readonly systems: () => readonly CatalogueConcept[];
  /** The servable topics (planets), in catalogue order. */
  readonly topics: () => readonly CatalogueConcept[];
  /** Every active topic including the ones not yet servable: what production and the gap loop work on. */
  readonly allTopics: () => readonly CatalogueConcept[];
  /** The servable topics of a system, in catalogue order. */
  readonly children: (systemId: string) => readonly CatalogueConcept[];
  /** The named nodes in catalogue order, whatever their status; ids the catalogue does not hold are skipped. */
  readonly slice: (ids: Iterable<string>) => readonly CatalogueConcept[];
  /** The system a topic belongs to (a system belongs to itself), or `undefined` for an id the catalogue does not hold. */
  readonly systemOf: (id: string) => string | undefined;
  /** The exact meanings a binding of `topicId` and `facetId` pins, or `undefined` when either is not held. */
  readonly meaning: (topicId: string, facetId: string) => FacetMeaning | undefined;
  /** The identity of the pinned meaning as certificates record it, or `undefined` when it is not held. */
  readonly meaningSha256: (topicId: string, facetId: string) => string | undefined;
  /**
   * Whether a certificate's recorded meaning identity still stands: it is the current wording, or an earlier wording a
   * revision declared to mean the same. A semantic change is not listed, so it never matches.
   */
  readonly acceptsMeaning: (topicId: string, facetId: string, sha256: string) => boolean;
  /** A short plain label for a topic, or a topic and one of its facets ("Greenhouse effect: radiation"); made from the id when the node is not held. */
  readonly label: (topicId: string, facetId?: string) => string;
  /** The silhouette family of a system, star or planet; `undefined` for an id the catalogue does not hold. */
  readonly sceneFamilyOf: (id: string) => SceneFamilyName | undefined;
  /** The haze family of a system; `undefined` for an id the catalogue does not hold. */
  readonly hazeOf: (systemId: string) => HazeFamilyName | undefined;
}

const phrase = (id: string) => id.replaceAll('-', ' ');

/** A plain label made from the last part of an id: `earth.greenhouse-effect` is "Greenhouse effect". */
export function labelOfId(id: string): string {
  const text = phrase(id.slice(id.lastIndexOf('.') + 1));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A facet's label as it follows its topic's: the first letter lowered unless the word is an acronym. */
export function lowerFirst(label: string): string {
  return /^[A-Z][A-Z0-9]/u.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The text of the label a topic and one facet make together. The seeded labels are made from ids, so for them this is exactly the
 * label `conceptLabel` made before the catalogue was data.
 */
export function facetLabel(topicLabel: string, facetLabelText: string): string {
  return `${topicLabel}: ${lowerFirst(facetLabelText)}`;
}

function newestRevisions(rows: readonly RevisionRow[]): Map<string, RevisionRow> {
  const newest = new Map<string, RevisionRow>();
  for (const row of rows) {
    const known = newest.get(row.nodeId);
    if (known === undefined || row.revision > known.revision) newest.set(row.nodeId, row);
  }
  return newest;
}

/**
 * The digest of a release's rows: the SHA-256 of the catalogue's meanings in the shape the first catalogue had
 * (`content-concepts.v1`), so the digest of the seeded release is the one every earlier coverage mapping recorded. It also covers
 * the topics that are not yet servable and the nodes that are retired, and only when there are any, so the first release's
 * digest is unchanged by them.
 */
export function digestOfRows(rows: Omit<ReleaseRows, 'digest'>, hash: JsonHash): string {
  const snapshot = makeSnapshot({ ...rows, digest: '' }, hash);
  const concepts = snapshot.all().map((concept) => ({
    id: concept.id,
    parent: concept.parent,
    meaning: concept.meaning,
    facets: concept.facets.map(({ id, meaning }) => ({ id, meaning })),
  }));
  const unservable = snapshot
    .all()
    .filter((concept) => concept.kind === 'topic' && !concept.servable)
    .map((concept) => concept.id);
  const retired = [...rows.nodes]
    .filter((node) => node.retiredIn !== null && node.retiredIn <= rows.releaseId)
    .sort((a, b) => a.seq - b.seq)
    .map((node) => node.nodeId);
  return hash({
    version: CONCEPT_CATALOGUE_VERSION,
    concepts,
    ...(unservable.length === 0 ? {} : { unservable }),
    ...(retired.length === 0 ? {} : { retired }),
  });
}

/**
 * Builds a snapshot from the rows of one release. Pure: the same rows always give the same snapshot. `hash` makes
 * the identity of a pinned meaning (the same value the coverage catalogue made from the code plan).
 */
export function makeSnapshot(rows: ReleaseRows, hash: JsonHash): CatalogueSnapshot {
  const newest = newestRevisions(rows.revisions);
  const byHash = new Map<string, RevisionRow>(
    rows.revisions.map((row) => [`${row.nodeId}\u0000${row.meaningSha256}`, row]),
  );
  const nodes = [...rows.nodes].sort((a, b) => a.seq - b.seq);
  const kids = new Map<string, NodeRow[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = kids.get(node.parentId);
    if (list === undefined) kids.set(node.parentId, [node]);
    else list.push(node);
  }
  const nodeOf = new Map(nodes.map((node) => [node.nodeId, node]));
  const revisionOf = (node: NodeRow): RevisionRow => {
    const revision = newest.get(node.nodeId);
    if (revision === undefined) throw new Error(`CATALOGUE_REVISION_MISSING:${node.nodeId}`);
    return revision;
  };
  const retiredAt = (node: NodeRow) => node.retiredIn !== null && node.retiredIn <= rows.releaseId;
  const servableAt = (node: NodeRow) =>
    node.kind === 'topic' && node.visibleIn !== null && node.visibleIn <= rows.releaseId && !retiredAt(node);

  // A facet is never retired alone, only with its topic, so a retired topic still lists the facets a stored place or certificate names.
  const facetsOf = (topic: NodeRow): CatalogueFacet[] =>
    (kids.get(topic.nodeId) ?? [])
      .filter((node) => node.kind === 'facet')
      .map((node) => ({ id: node.nodeId, label: revisionOf(node).label, meaning: revisionOf(node).meaning }));

  const concepts = new Map<string, CatalogueConcept>();
  for (const node of nodes) {
    if (node.kind === 'facet') continue;
    const revision = revisionOf(node);
    concepts.set(node.nodeId, {
      id: node.nodeId,
      kind: node.kind,
      parent: node.parentId,
      label: revision.label,
      meaning: revision.meaning,
      facets: node.kind === 'topic' ? facetsOf(node) : [],
      retired: retiredAt(node),
      servable: servableAt(node),
      sceneFamily: revision.sceneFamily,
      haze: revision.haze,
      policy: {
        systemUnits: revision.systemUnits ?? FORMATION_DEFAULTS.systemUnits,
        planetUnits: revision.planetUnits ?? FORMATION_DEFAULTS.planetUnits,
        planetFacets: revision.planetFacets ?? FORMATION_DEFAULTS.planetFacets,
      },
      introducedIn: node.introducedIn,
    });
  }
  // A system is servable when one of its topics is (and it is not retired itself).
  const servableSystems = new Set<string>();
  for (const concept of concepts.values())
    if (concept.kind === 'topic' && concept.servable && concept.parent !== null) servableSystems.add(concept.parent);
  for (const [id, concept] of concepts)
    if (concept.kind === 'system')
      concepts.set(id, { ...concept, servable: servableSystems.has(id) && !concept.retired });

  const ordered = [...concepts.values()];
  const active = ordered.filter((concept) => !concept.retired);
  const topicsAll = active.filter((concept) => concept.kind === 'topic');
  const topicsServable = topicsAll.filter((concept) => concept.servable);
  const systemsServable = active.filter((concept) => concept.kind === 'system' && concept.servable);
  const childrenOf = new Map<string, CatalogueConcept[]>();
  for (const topic of topicsServable) {
    if (topic.parent === null) continue;
    const list = childrenOf.get(topic.parent);
    if (list === undefined) childrenOf.set(topic.parent, [topic]);
    else list.push(topic);
  }
  const index = new Map(ordered.map((concept, at) => [concept.id, at]));
  const facetIndex = new Map<string, { readonly topic: CatalogueConcept; readonly facet: CatalogueFacet }>();
  for (const concept of concepts.values())
    for (const facet of concept.facets) facetIndex.set(facet.id, { topic: concept, facet });

  /** The wordings a node's current revision stands for: itself and every earlier one it declared the same. */
  const wordings = (nodeId: string): readonly string[] => {
    const revision = newest.get(nodeId);
    if (revision === undefined) return [];
    const texts = [revision.meaning];
    for (const earlier of revision.compatibleWith) {
      const known = byHash.get(`${nodeId}\u0000${earlier}`);
      if (known !== undefined) texts.push(known.meaning);
    }
    return texts;
  };
  const pinned = (topicId: string, topicMeaning: string, facetId: string, facetMeaning: string) =>
    hash({ topicId, topicMeaning, facetId, facetMeaning });

  const facetOf = (topicId: string, facetId: string) => {
    const topic = concepts.get(topicId);
    const found = facetIndex.get(facetId);
    return topic !== undefined && topic.kind === 'topic' && found?.topic.id === topicId ? found.facet : undefined;
  };

  const snapshot: CatalogueSnapshot = {
    releaseId: rows.releaseId,
    digest: rows.digest,
    all: () => active,
    concept: (id) => concepts.get(id),
    has: (id) => nodeOf.has(id),
    systems: () => systemsServable,
    topics: () => topicsServable,
    allTopics: () => topicsAll,
    children: (systemId) => childrenOf.get(systemId) ?? [],
    slice(ids) {
      const found = new Set<CatalogueConcept>();
      for (const id of ids) {
        const concept = concepts.get(id);
        if (concept !== undefined) found.add(concept);
      }
      return [...found].sort((a, b) => index.get(a.id)! - index.get(b.id)!);
    },
    systemOf(id) {
      const concept = concepts.get(id);
      return concept === undefined ? undefined : (concept.parent ?? concept.id);
    },
    meaning(topicId, facetId) {
      const topic = concepts.get(topicId);
      const facet = facetOf(topicId, facetId);
      return topic !== undefined && facet !== undefined
        ? { topicId, topicMeaning: topic.meaning, facetId, facetMeaning: facet.meaning }
        : undefined;
    },
    meaningSha256(topicId, facetId) {
      const meaning = snapshot.meaning(topicId, facetId);
      return meaning === undefined
        ? undefined
        : pinned(meaning.topicId, meaning.topicMeaning, meaning.facetId, meaning.facetMeaning);
    },
    acceptsMeaning(topicId, facetId, sha256) {
      if (facetOf(topicId, facetId) === undefined) return false;
      for (const topicText of wordings(topicId))
        for (const facetText of wordings(facetId))
          if (pinned(topicId, topicText, facetId, facetText) === sha256) return true;
      return false;
    },
    label(topicId, facetId) {
      const topic = concepts.get(topicId);
      const heading = topic?.label ?? labelOfId(topicId);
      if (facetId === undefined || !facetId.startsWith(`${topicId}.`)) return heading;
      const facet = facetOf(topicId, facetId);
      return facetLabel(heading, facet?.label ?? labelOfId(facetId));
    },
    sceneFamilyOf(id) {
      const concept = concepts.get(id);
      if (concept === undefined) return undefined;
      if (concept.sceneFamily !== null) return concept.sceneFamily;
      const system = concept.parent === null ? undefined : concepts.get(concept.parent);
      return system?.sceneFamily ?? undefined;
    },
    hazeOf(systemId) {
      const concept = concepts.get(systemId);
      return concept?.kind === 'system' ? (concept.haze ?? undefined) : undefined;
    },
  };
  return snapshot;
}
