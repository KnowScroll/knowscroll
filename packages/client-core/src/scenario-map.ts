import type { ScenarioCard, ScenarioSuggestion, ThreadEpisode } from '@knowscroll/contracts';
import type { ScopedStorage } from './account-scope';

/** Which branches the map lists. Suggestions are the member's own offers, never branches. */
export type MapFilter = 'mine' | 'everyone' | 'suggestions';

/** What a member keeps of the map on this device: the filter and the groups they opened. Never sent anywhere. */
export interface MapPreferences {
  readonly filter: MapFilter;
  /** Groups opened with "Show", by the key of the node whose branches they are. */
  readonly expanded: readonly string[];
}

export const DEFAULT_MAP_PREFERENCES: MapPreferences = { filter: 'everyone', expanded: [] };

const keyOf = (threadId: string) => `thread.map.${threadId}`;

/** The map's filter and open groups for one thread, from this device; anything unreadable is the default. */
export function loadMapPreferences(storage: ScopedStorage, threadId: string): MapPreferences {
  try {
    const raw = storage.get(keyOf(threadId));
    if (raw === undefined) return DEFAULT_MAP_PREFERENCES;
    const value = JSON.parse(raw) as { filter?: unknown; expanded?: unknown };
    const filter = value.filter === 'mine' || value.filter === 'suggestions' ? value.filter : 'everyone';
    const expanded = Array.isArray(value.expanded)
      ? value.expanded.filter((entry): entry is string => typeof entry === 'string').slice(0, 100)
      : [];
    return { filter, expanded };
  } catch {
    return DEFAULT_MAP_PREFERENCES;
  }
}

export function saveMapPreferences(storage: ScopedStorage, threadId: string, preferences: MapPreferences): void {
  storage.set(keyOf(threadId), JSON.stringify(preferences));
}

/**
 * Whether the thread has grown enough to be worth a map (X04): several branches or perspectives that
 * still stand. A first exploration is its card in the chat; a removed branch does not count.
 */
export const mapOffered = (cards: readonly ScenarioCard[]): boolean =>
  cards.filter((card) => card.status !== 'removed').length >= 2;

/** Where the member is, as they left it: in the original sequence (at the episode they selected), or inside a branch. */
export type MapHere = { readonly kind: 'original' } | { readonly kind: 'branch'; readonly nodeId: string };

const hereKey = (threadId: string) => `thread.here.${threadId}`;

/** The branch the member last opened and has not come back from, kept on this device; otherwise they are in the original. */
export function loadHere(storage: ScopedStorage, threadId: string): MapHere {
  const nodeId = storage.get(hereKey(threadId));
  return nodeId === undefined || nodeId === '' ? { kind: 'original' } : { kind: 'branch', nodeId };
}

export function saveHere(storage: ScopedStorage, threadId: string, here: MapHere): void {
  if (here.kind === 'original') storage.remove(hereKey(threadId));
  else storage.set(hereKey(threadId), here.nodeId);
}

/**
 * Where the way back from a branch leads, in words (X03): the original sequence at the member's own place. It
 * names the part they had selected when the thread is a series, and the thread itself otherwise. The chip always
 * says where it goes; `spoken` is what a screen reader reads.
 */
export function returnTarget(
  threadTitle: string,
  episodes: readonly ThreadEpisode[],
  selectedAssetId: string | undefined,
): { readonly label: string; readonly spoken: string } {
  const place =
    episodes.length > 1 ? (episodes.find((episode) => episode.assetId === selectedAssetId) ?? episodes[0]) : undefined;
  if (place?.part === undefined) return { label: threadTitle, spoken: `Back to ${threadTitle}` };
  const part = `Part ${String(place.part)}`;
  return { label: part, spoken: `Back to ${threadTitle}, ${part}` };
}

/** Branches shown under one parent before the rest fold into "More from … Show". */
export const GROUP_LIMIT = 3;

/** One line of the outline, in reading order. `depth` is how far in it sits; the outline is a tree, not a canvas. */
export type MapRow =
  | {
      readonly kind: 'episode';
      readonly key: string;
      readonly depth: 0;
      readonly assetId: string;
      readonly part: number | undefined;
      readonly title: string;
      /** The member's own position, never anyone else's. */
      readonly here: boolean;
      readonly unavailable: boolean;
    }
  | {
      readonly kind: 'branch';
      readonly key: string;
      readonly depth: number;
      readonly nodeId: string;
      readonly branchKind: ScenarioCard['kind'];
      /** "Removed" for a removed branch: its title is no longer shown. */
      readonly title: string;
      readonly status: ScenarioCard['status'];
      readonly speculative: boolean;
      readonly hypothetical: boolean;
      readonly mine: boolean;
      readonly here: boolean;
      /** Opening it is possible: it is ready. */
      readonly openable: boolean;
    }
  | {
      readonly kind: 'suggestion';
      readonly key: string;
      readonly depth: number;
      readonly draftId: string;
      readonly optionId: string;
      readonly title: string;
      readonly speculative: boolean;
    }
  | {
      readonly kind: 'more';
      readonly key: string;
      readonly depth: number;
      /** The node whose branches are folded, or `undefined` for the root's own. */
      readonly groupKey: string;
      readonly parentTitle: string;
      readonly hidden: number;
    };

export interface MapView {
  readonly title: string;
  readonly rows: readonly MapRow[];
  /** Why there are no branch rows, when there are none to show. */
  readonly empty: 'none' | 'search' | 'filter' | undefined;
}

/** One branch or suggestion on its way into the outline, with the text a search looks in. */
interface Node {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly row: Extract<MapRow, { kind: 'branch' | 'suggestion' }>;
  readonly text: string;
  children: Node[];
}

/** Everything `buildMap` reads. */
export interface MapInput {
  readonly threadTitle: string;
  readonly episodes: readonly ThreadEpisode[];
  /** The thread's root Scroll: the original branches grew from it. */
  readonly rootAssetId: string;
  readonly cards: readonly ScenarioCard[];
  readonly suggestions: readonly ScenarioSuggestion[];
  readonly ownPersonId: string | undefined;
  readonly here: MapHere;
  /** The episode the member last had selected in the original sequence. */
  readonly selectedAssetId: string | undefined;
  readonly preferences: MapPreferences;
  readonly query: string;
}

const ROOT = 'root';

/** A branch as a node. A removed one is a placeholder: its words are not here, so no search can find it. */
function branchNode(card: ScenarioCard, input: MapInput): Node {
  const removed = card.status === 'removed';
  return {
    id: card.nodeId,
    parentId: card.parentNodeId,
    text: removed ? '' : `${card.title} ${card.lens ?? ''}`.toLowerCase(),
    children: [],
    row: {
      kind: 'branch',
      key: card.nodeId,
      depth: 1,
      nodeId: card.nodeId,
      branchKind: card.kind,
      title: removed ? 'Removed' : card.title,
      status: card.status,
      speculative: card.speculative,
      hypothetical: card.hypothetical,
      mine: card.startedBy !== undefined && card.startedBy.personId === input.ownPersonId,
      here: input.here.kind === 'branch' && input.here.nodeId === card.nodeId,
      openable: card.status === 'ready',
    },
  };
}

/** An offer the member has not made, as a node under the branch it would continue. */
function suggestionNode(suggestion: ScenarioSuggestion): Node {
  const id = `${suggestion.draftId}:${suggestion.optionId}`;
  return {
    id,
    parentId: suggestion.parentNodeId,
    text: suggestion.title.toLowerCase(),
    children: [],
    row: {
      kind: 'suggestion',
      key: id,
      depth: 1,
      draftId: suggestion.draftId,
      optionId: suggestion.optionId,
      title: suggestion.title,
      speculative: suggestion.speculative,
    },
  };
}

/** The branches and suggestions as a forest: each under its parent, those continuing the root (or a parent not here) on top. */
function forestOf(input: MapInput): Node[] {
  const nodes = new Map<string, Node>();
  for (const card of input.cards) nodes.set(card.nodeId, branchNode(card, input));
  for (const suggestion of input.suggestions) {
    const node = suggestionNode(suggestion);
    nodes.set(node.id, node);
  }
  const top: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === undefined ? undefined : nodes.get(node.parentId);
    (parent === undefined ? top : parent.children).push(node);
  }
  return top;
}

/**
 * What the filter and the search keep: the nodes that match, and the path to each so it reads in place.
 * Narrows `children` as it goes.
 */
function narrow(top: readonly Node[], filter: MapFilter, query: string): Node[] {
  const matches = (node: Node): boolean => {
    if (filter === 'suggestions' && node.row.kind !== 'suggestion') return false;
    if (filter === 'mine' && (node.row.kind !== 'branch' || !node.row.mine)) return false;
    return query === '' || node.text.includes(query);
  };
  const keep = (node: Node): boolean => {
    node.children = node.children.filter(keep);
    return matches(node) || node.children.length > 0;
  };
  return top.filter(keep);
}

/**
 * Lays a group out under its parent, depth first. Past `GROUP_LIMIT` the rest fold until the member opens them
 * (never while searching). A fold that would hide a single line is not worth its own line, so it only starts at two.
 */
function layOut(
  into: MapRow[],
  list: readonly Node[],
  place: { readonly depth: number; readonly groupKey: string; readonly parentTitle: string },
  show: { readonly expanded: readonly string[]; readonly searching: boolean },
): void {
  const folded = !show.searching && !show.expanded.includes(place.groupKey) && list.length > GROUP_LIMIT + 1;
  for (const node of folded ? list.slice(0, GROUP_LIMIT) : list) {
    into.push({ ...node.row, depth: place.depth });
    layOut(into, node.children, { depth: place.depth + 1, groupKey: node.id, parentTitle: node.row.title }, show);
  }
  if (folded)
    into.push({
      kind: 'more',
      key: `more:${place.groupKey}`,
      depth: place.depth,
      groupKey: place.groupKey,
      parentTitle: place.parentTitle,
      hidden: list.length - GROUP_LIMIT,
    });
}

/** An episode of the original sequence as a line, with "You" when it is the member's own place. */
function episodeRow(episode: ThreadEpisode, input: MapInput): MapRow {
  const selected = input.selectedAssetId ?? input.episodes[0]?.assetId;
  return {
    kind: 'episode',
    key: `episode:${episode.assetId}`,
    depth: 0,
    assetId: episode.assetId,
    part: episode.part,
    title: episode.title,
    here: input.here.kind === 'original' && selected === episode.assetId,
    unavailable: episode.state === 'unavailable',
  };
}

/**
 * The map of one thread as an outline (X04): the original sequence, with the branches that grew from it nested
 * under it as they were made, and the member's own unmade suggestions where they would continue. It shows
 * what exists: a suggestion has no number, a removed branch says "Removed" and nothing else, "You" marks only
 * the member's own position, and a long group folds until it is opened. Pure: the same inputs, the same rows.
 */
export function buildMap(input: MapInput): MapView {
  const query = input.query.trim().toLowerCase();
  const visible = narrow(forestOf(input), input.preferences.filter, query);
  const show = { expanded: input.preferences.expanded, searching: query !== '' };
  const rows: MapRow[] = [];
  let branchRows = 0;
  for (const episode of input.episodes) {
    rows.push(episodeRow(episode, input));
    if (episode.assetId !== input.rootAssetId) continue;
    const branches: MapRow[] = [];
    layOut(branches, visible, { depth: 1, groupKey: ROOT, parentTitle: episode.title }, show);
    branchRows = branches.length;
    rows.push(...branches);
  }
  const anythingMade = input.cards.length + input.suggestions.length > 0;
  return {
    title: input.threadTitle,
    rows,
    empty: branchRows > 0 ? undefined : !anythingMade ? 'none' : query !== '' ? 'search' : 'filter',
  };
}
