import type { NodeDraft } from './plan-import.js';
import { digestOfRows } from './snapshot.js';
import {
  CATALOGUE_LIMITS,
  FORMATION_DEFAULTS,
  type JsonHash,
  type NodeRow,
  type ReleaseRows,
  type RevisionRow,
} from './types.js';

/**
 * Making a release of the catalogue (D-419). Everything here is pure: given the rows of the current release and a list of
 * changes, it decides which are admitted by code and what rows the next release holds. Storing them, under one lock, is the
 * adapter's job.
 */

/** One step towards the next release. */
export type ReleaseChange =
  /** A node the catalogue does not hold. A new topic is not servable until the library has released supply for it. */
  | { readonly kind: 'add'; readonly draft: NodeDraft }
  /** A new revision of a node it holds: a new meaning or a new label. Its place, kind, silhouette and haze never change. */
  | { readonly kind: 'revise'; readonly draft: NodeDraft }
  /** A topic that now has released supply becomes servable. */
  | { readonly kind: 'show'; readonly nodeId: string }
  /**
   * A node (and what is under it) leaves the listings and new formation. Its id is never reused and what points at it still resolves.
   * A merge into another node (`mergedInto`) is refused (`merge_unsupported`): sending a retired topic's readers, places, rooms and
   * certificates to another topic is not built, so a topic is retired, never merged, until it is.
   */
  | { readonly kind: 'retire'; readonly nodeId: string; readonly mergedInto?: string };

/** Why code refused a change. Codes only: a refusal never carries the text it refused. */
export const REFUSAL_CODES = [
  'id_shape',
  'id_taken',
  'id_not_under_parent',
  'parent_missing',
  'parent_kind',
  'parent_retired',
  'label_shape',
  'label_duplicate',
  'id_duplicate',
  'meaning_length',
  'meaning_text',
  'topic_facet_count',
  'identity_changed',
  'look_changed',
  'same_meaning_unknown',
  'node_missing',
  'node_retired',
  'not_a_topic',
  'facet_retire',
  'already_servable',
  'merge_unsupported',
  'too_many_changes',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  readonly code: RefusalCode;
  readonly nodeId: string;
}

/** A change to a node that already exists in a way a new row records: its visibility or its retirement. */
export interface NodeUpdate {
  readonly nodeId: string;
  readonly visibleIn?: number;
  readonly retiredIn?: number;
}

/** What a release changed, in counts. */
export interface ReleaseSummary {
  readonly addedSystems: number;
  readonly addedTopics: number;
  readonly addedFacets: number;
  readonly revised: number;
  /** Revisions that declared the earlier wording the same meaning, so certificates stay valid. */
  readonly rewordedOnly: number;
  readonly shown: number;
  readonly retired: number;
}

export type ReleasePlan =
  | { readonly kind: 'refused'; readonly refusals: readonly Refusal[] }
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'release';
      readonly releaseId: number;
      readonly digest: string;
      readonly newNodes: readonly NodeRow[];
      readonly newRevisions: readonly RevisionRow[];
      readonly updates: readonly NodeUpdate[];
      readonly summary: ReleaseSummary;
      /** The rows of the whole new release, for building its snapshot. */
      readonly rows: ReleaseRows;
    };

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/** Text a node may not carry: control characters, markup, backticks and web addresses. */
const FORBIDDEN_TEXT = /[\p{C}<>`]|:\/\//u;

/** The text two ids or labels are compared by: case, accents, spaces and punctuation are ignored. */
export const normalised = (text: string): string =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const slugOf = (id: string, parentId: string | null): string | undefined =>
  parentId === null ? id : id.startsWith(`${parentId}.`) ? id.slice(parentId.length + 1) : undefined;

function revisionOf(
  draft: NodeDraft,
  revision: number,
  releaseId: number,
  compatibleWith: readonly string[],
  hash: JsonHash,
): RevisionRow {
  return {
    nodeId: draft.id,
    revision,
    introducedIn: releaseId,
    label: draft.label,
    meaning: draft.meaning,
    meaningSha256: hash(draft.meaning),
    compatibleWith,
    systemUnits: draft.kind === 'system' ? FORMATION_DEFAULTS.systemUnits : null,
    planetUnits: draft.kind === 'topic' ? FORMATION_DEFAULTS.planetUnits : null,
    planetFacets: draft.kind === 'topic' ? FORMATION_DEFAULTS.planetFacets : null,
    sceneFamily: draft.sceneFamily,
    haze: draft.haze,
  };
}

/**
 * The names a new node must differ from, normalised: for a system, every system; for a topic, every topic of the catalogue whatever
 * its system; for a facet, the facets of its own topic (facets such as "Limits" are meant to repeat across topics). A retired node's
 * names are free again, though its id stays taken.
 */
interface Siblings {
  readonly ids: Set<string>;
  readonly labels: Set<string>;
}

/** Everything admission reads of the catalogue: the rows by node, with the newest revision of each. */
interface Book {
  readonly nodes: Map<string, NodeRow>;
  readonly newest: Map<string, RevisionRow>;
}

function bookOf(rows: ReleaseRows): Book {
  const newest = new Map<string, RevisionRow>();
  for (const revision of rows.revisions) {
    const known = newest.get(revision.nodeId);
    if (known === undefined || revision.revision > known.revision) newest.set(revision.nodeId, revision);
  }
  return { nodes: new Map(rows.nodes.map((node) => [node.nodeId, node])), newest };
}

const retired = (node: NodeRow | undefined, releaseId: number): boolean =>
  node?.retiredIn !== null && node?.retiredIn !== undefined && node.retiredIn <= releaseId;

function textRefusal(draft: NodeDraft): RefusalCode | undefined {
  const { label, meaning } = draft;
  if (
    label.length < CATALOGUE_LIMITS.labelMin ||
    label.length > CATALOGUE_LIMITS.labelMax ||
    label !== label.trim() ||
    FORBIDDEN_TEXT.test(label)
  )
    return 'label_shape';
  if (
    meaning.length < CATALOGUE_LIMITS.meaningMin ||
    meaning.length > CATALOGUE_LIMITS.meaningMax ||
    meaning !== meaning.trim()
  )
    return 'meaning_length';
  if (FORBIDDEN_TEXT.test(meaning)) return 'meaning_text';
  return undefined;
}

/**
 * Plans the next release from the rows of the current one and a list of changes. Admission is by code: ids have the plan's
 * shape and sit under their parent, a parent exists and is of the right kind, a normalised id and a normalised label are unique
 * across the whole catalogue for systems and for topics, and among the facets of one topic for facets, a meaning is inside its bounds, a topic has two to sixteen facets, a node keeps its identity, place,
 * silhouette and haze for ever, and a wording is declared the same meaning only of the wording it replaces. Any refusal
 * refuses the whole release: nothing is half admitted.
 *
 * `visibleOnAdd` makes every topic added by this release servable at once. Only the first release (the seed, which is the
 * catalogue as it was before it was data) uses it; every later topic waits for released supply.
 */
export function planRelease(
  base: ReleaseRows,
  changes: readonly ReleaseChange[],
  hash: JsonHash,
  options: { readonly visibleOnAdd?: boolean } = {},
): ReleasePlan {
  if (changes.length > CATALOGUE_LIMITS.nodesPerRelease)
    return { kind: 'refused', refusals: [{ code: 'too_many_changes', nodeId: '' }] };
  const releaseId = base.releaseId + 1;
  const book = bookOf(base);
  const refusals: Refusal[] = [];
  const refuse = (code: RefusalCode, nodeId: string): void => {
    refusals.push({ code, nodeId });
  };

  const nodes = new Map(book.nodes);
  const newest = new Map(book.newest);
  const newNodes: NodeRow[] = [];
  const newRevisions: RevisionRow[] = [];
  const updates = new Map<string, NodeUpdate>();
  let nextSeq = base.nodes.reduce((top, node) => Math.max(top, node.seq), 0) + 1;
  const counts = { addedSystems: 0, addedTopics: 0, addedFacets: 0, revised: 0, rewordedOnly: 0, shown: 0, retired: 0 };
  /** Topics this release adds, or adds facets to or takes facets from: each must end with two to sixteen facets. */
  const touchedTopics = new Set<string>();

  /** Every node's children, by parent (a system's parent is the empty key): so no step reads the whole catalogue to find a few. */
  const childrenOf = new Map<string, string[]>();
  const childrenAt = (parentId: string | null): string[] => {
    const key = parentId ?? '';
    let list = childrenOf.get(key);
    if (list === undefined) {
      list = [];
      childrenOf.set(key, list);
    }
    return list;
  };
  for (const node of base.nodes) childrenAt(node.parentId).push(node.nodeId);
  /** Every node of a kind, so the names of all topics are read once, not by walking the catalogue for each new one. */
  const ofKind = new Map<NodeRow['kind'], string[]>();
  const ofKindAt = (kind: NodeRow['kind']): string[] => {
    let list = ofKind.get(kind);
    if (list === undefined) {
      list = [];
      ofKind.set(kind, list);
    }
    return list;
  };
  for (const node of base.nodes) ofKindAt(node.kind).push(node.nodeId);
  const isRetired = (nodeId: string): boolean =>
    retired(nodes.get(nodeId), base.releaseId) || updates.get(nodeId)?.retiredIn !== undefined;

  /** What a new node of a kind must differ from, built once for its scope and kept current as the release goes on. */
  const siblingCache = new Map<string, Siblings>();
  const siblingsOf = (kind: NodeRow['kind'], parentId: string | null): Siblings => {
    const key = kind === 'facet' ? `facet:${parentId ?? ''}` : kind;
    const known = siblingCache.get(key);
    if (known !== undefined) return known;
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const nodeId of kind === 'facet' ? childrenAt(parentId) : ofKindAt(kind)) {
      if (isRetired(nodeId)) continue;
      const node = nodes.get(nodeId);
      if (node === undefined || node.kind !== kind) continue;
      const slug = slugOf(nodeId, node.parentId);
      if (slug !== undefined) ids.add(normalised(slug));
      const revision = newest.get(nodeId);
      if (revision !== undefined) labels.add(normalised(revision.label));
    }
    const built = { ids, labels };
    siblingCache.set(key, built);
    return built;
  };

  const add = (draft: NodeDraft): void => {
    const { id, kind, parentId } = draft;
    if (id.length === 0 || id.length > CATALOGUE_LIMITS.idMax) return refuse('id_shape', id);
    if (nodes.has(id)) return refuse('id_taken', id);
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (kind === 'system' ? parentId !== null : parentId === null) return refuse('parent_kind', id);
    if (parentId !== null) {
      if (parent === undefined) return refuse('parent_missing', id);
      if (parent.kind !== (kind === 'topic' ? 'system' : 'topic')) return refuse('parent_kind', id);
      if (isRetired(parent.nodeId)) return refuse('parent_retired', id);
    }
    const slug = slugOf(id, parentId);
    if (slug === undefined) return refuse('id_not_under_parent', id);
    if (!SLUG.test(slug)) return refuse('id_shape', id);
    const text = textRefusal(draft);
    if (text !== undefined) return refuse(text, id);
    const siblings = siblingsOf(kind, parentId);
    if (siblings.ids.has(normalised(slug))) return refuse('id_duplicate', id);
    if (siblings.labels.has(normalised(draft.label))) return refuse('label_duplicate', id);
    const node: NodeRow = {
      nodeId: id,
      kind,
      parentId,
      seq: nextSeq,
      introducedIn: releaseId,
      visibleIn: kind === 'topic' && options.visibleOnAdd === true ? releaseId : null,
      retiredIn: null,
      mergedInto: null,
    };
    nextSeq += 1;
    nodes.set(id, node);
    newNodes.push(node);
    childrenAt(parentId).push(id);
    ofKindAt(kind).push(id);
    siblings.ids.add(normalised(slug));
    siblings.labels.add(normalised(draft.label));
    const revision = revisionOf(draft, 1, releaseId, [], hash);
    newest.set(id, revision);
    newRevisions.push(revision);
    if (kind === 'topic') touchedTopics.add(id);
    if (kind === 'facet' && parentId !== null) touchedTopics.add(parentId);
    if (kind === 'system') counts.addedSystems += 1;
    else if (kind === 'topic') counts.addedTopics += 1;
    else counts.addedFacets += 1;
  };

  const revise = (draft: NodeDraft): void => {
    const node = nodes.get(draft.id);
    const current = newest.get(draft.id);
    if (node === undefined || current === undefined) return refuse('node_missing', draft.id);
    if (node.kind !== draft.kind || node.parentId !== draft.parentId) return refuse('identity_changed', draft.id);
    if (draft.sceneFamily !== current.sceneFamily || draft.haze !== current.haze)
      return refuse('look_changed', draft.id);
    const text = textRefusal(draft);
    if (text !== undefined) return refuse(text, draft.id);
    const reworded = draft.meaning !== current.meaning;
    if (!reworded && draft.label === current.label) return;
    if (draft.label !== current.label) {
      const siblings = siblingsOf(node.kind, node.parentId);
      if (siblings.labels.has(normalised(draft.label))) return refuse('label_duplicate', draft.id);
      siblings.labels.delete(normalised(current.label));
      siblings.labels.add(normalised(draft.label));
    }
    let compatibleWith: readonly string[] = current.compatibleWith;
    if (reworded) {
      if (draft.sameMeaningAs.length > 0 && !draft.sameMeaningAs.includes(current.meaning))
        return refuse('same_meaning_unknown', draft.id);
      compatibleWith =
        draft.sameMeaningAs.length > 0 ? [...new Set([current.meaningSha256, ...current.compatibleWith])] : [];
    }
    const revision = revisionOf(draft, current.revision + 1, releaseId, compatibleWith, hash);
    newest.set(draft.id, revision);
    newRevisions.push(revision);
    counts.revised += 1;
    if (reworded && compatibleWith.length > 0) counts.rewordedOnly += 1;
  };

  const show = (nodeId: string): void => {
    const node = nodes.get(nodeId);
    if (node === undefined) return refuse('node_missing', nodeId);
    if (node.kind !== 'topic') return refuse('not_a_topic', nodeId);
    if (isRetired(nodeId)) return refuse('node_retired', nodeId);
    if ((node.visibleIn !== null && node.visibleIn <= base.releaseId) || updates.get(nodeId)?.visibleIn !== undefined)
      return refuse('already_servable', nodeId);
    updates.set(nodeId, { ...updates.get(nodeId), nodeId, visibleIn: releaseId });
    counts.shown += 1;
  };

  const retire = (nodeId: string, mergedInto: string | undefined): void => {
    const node = nodes.get(nodeId);
    if (node === undefined) return refuse('node_missing', nodeId);
    // A facet leaves only with its topic: a stored place or certificate may name it, and a topic keeps the facets it was formed from.
    if (node.kind === 'facet') return refuse('facet_retire', nodeId);
    if (isRetired(nodeId)) return refuse('node_retired', nodeId);
    if (mergedInto !== undefined) return refuse('merge_unsupported', nodeId);
    const doomed = [nodeId];
    for (let at = 0; at < doomed.length; at += 1) for (const child of childrenAt(doomed[at]!)) doomed.push(child);
    for (const id of doomed) {
      const known = nodes.get(id)!;
      if (isRetired(id)) continue;
      // A retired node leaves its siblings' names free, though its id stays taken.
      const slug = slugOf(id, known.parentId);
      const siblings = siblingsOf(known.kind, known.parentId);
      if (slug !== undefined) siblings.ids.delete(normalised(slug));
      const revision = newest.get(id);
      if (revision !== undefined) siblings.labels.delete(normalised(revision.label));
      updates.set(id, {
        ...updates.get(id),
        nodeId: id,
        retiredIn: releaseId,
      });
      counts.retired += 1;
    }
  };

  for (const change of changes) {
    if (change.kind === 'add') add(change.draft);
    else if (change.kind === 'revise') revise(change.draft);
    else if (change.kind === 'show') show(change.nodeId);
    else retire(change.nodeId, change.mergedInto);
  }

  for (const topicId of touchedTopics) {
    if (!nodes.has(topicId) || isRetired(topicId)) continue;
    const facets = childrenAt(topicId).filter((id) => nodes.get(id)?.kind === 'facet' && !isRetired(id)).length;
    if (facets < CATALOGUE_LIMITS.facetsMin || facets > CATALOGUE_LIMITS.facetsMax)
      refuse('topic_facet_count', topicId);
  }

  if (refusals.length > 0) return { kind: 'refused', refusals };
  if (newNodes.length === 0 && newRevisions.length === 0 && updates.size === 0) return { kind: 'unchanged' };

  const updated = [...nodes.values()].map((node): NodeRow => {
    const update = updates.get(node.nodeId);
    if (update === undefined) return node;
    return {
      ...node,
      visibleIn: update.visibleIn ?? node.visibleIn,
      retiredIn: update.retiredIn ?? node.retiredIn,
    };
  });
  const revisions = [...base.revisions, ...newRevisions];
  const resulting = { releaseId, nodes: updated, revisions };
  const digest = digestOfRows(resulting, hash);
  return {
    kind: 'release',
    releaseId,
    digest,
    newNodes,
    newRevisions,
    updates: [...updates.values()],
    summary: counts,
    rows: { ...resulting, digest },
  };
}
