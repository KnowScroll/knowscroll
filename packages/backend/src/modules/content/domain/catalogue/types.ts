import type { HazeFamilyName, SceneFamilyName } from '../library/plan.js';

/**
 * The topic catalogue as data (#674, D-419). A catalogue is a system, its topics (planets) and their facets. Each node has
 * a stable id that is never reused, and a chain of immutable revisions. A release is one numbered, append-only step: the
 * catalogue of release N is every node and revision introduced up to N, so a Geography run that pinned release N reads
 * the same catalogue for ever.
 */

/** The version of the concept catalogue's digest. A coverage mapping records it beside the digest of the release it was decided against. */
export const CONCEPT_CATALOGUE_VERSION = 'content-concepts.v1' as const;

export const NODE_KINDS = ['system', 'topic', 'facet'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** The thresholds a catalogue node carries for formation (D-025): defaults 2, 3 and 2, the numbers `geography-passive.v1` used. */
export interface FormationPolicy {
  /** Distinct explanations that form a system and its star. Set on a system. */
  readonly systemUnits: number;
  /** Distinct explanations that form a planet. Set on a topic. */
  readonly planetUnits: number;
  /** Distinct facets those explanations must cover. Set on a topic. */
  readonly planetFacets: number;
}
export const FORMATION_DEFAULTS: FormationPolicy = Object.freeze({ systemUnits: 2, planetUnits: 3, planetFacets: 2 });

/** One node of the catalogue as the table holds it (`content.concept_nodes`). */
export interface NodeRow {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly parentId: string | null;
  /** Creation order over the whole catalogue: the catalogue's order, and a facet's site on its planet. */
  readonly seq: number;
  readonly introducedIn: number;
  /** The release that made a topic servable; `null` until it has released supply. Always `null` for a system and a facet. */
  readonly visibleIn: number | null;
  readonly retiredIn: number | null;
  readonly mergedInto: string | null;
}

/** One immutable revision of a node (`content.concept_node_revisions`). */
export interface RevisionRow {
  readonly nodeId: string;
  readonly revision: number;
  readonly introducedIn: number;
  readonly label: string;
  readonly meaning: string;
  /** The canonical SHA-256 of the meaning's text: the identity of this wording. */
  readonly meaningSha256: string;
  /** Earlier wordings of the same meaning (their `meaningSha256`), so a wording-only edit keeps certificates valid. */
  readonly compatibleWith: readonly string[];
  readonly systemUnits: number | null;
  readonly planetUnits: number | null;
  readonly planetFacets: number | null;
  /** The silhouette family a system or topic is drawn with; `null` on a topic means its system's. */
  readonly sceneFamily: SceneFamilyName | null;
  /** The haze around a system's sun; set on a system only. */
  readonly haze: HazeFamilyName | null;
}

/** Everything a snapshot is built from: the nodes and revisions up to one release. */
export interface ReleaseRows {
  readonly releaseId: number;
  readonly digest: string;
  readonly nodes: readonly NodeRow[];
  /** Every revision up to the release of every node. Only the newest of each node and the wordings it is compatible with are read. */
  readonly revisions: readonly RevisionRow[];
}

/**
 * The canonical SHA-256 of a value (`canonicalSha256`), given to the pure code because domain code may not hash. It makes the
 * identity of a wording (the hash of its text), the identity of a pinned meaning and the digest of a release.
 */
export type JsonHash = (value: unknown) => string;

/** The limits admission holds every node to. */
export const CATALOGUE_LIMITS = Object.freeze({
  idMax: 160,
  labelMin: 2,
  labelMax: 80,
  meaningMin: 16,
  meaningMax: 300,
  facetsMin: 2,
  facetsMax: 16,
  nodesPerRelease: 20_000,
});
