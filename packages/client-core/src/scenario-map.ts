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

/** Where the member is, as they left it: in the original sequence at an episode, or inside a branch. */
export type MapHere =
  | { readonly kind: 'original'; readonly assetId: string | undefined }
  | { readonly kind: 'branch'; readonly nodeId: string };

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

interface Node {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly row: Extract<MapRow, { kind: 'branch' | 'suggestion' }>;
  readonly text: string;
  children: Node[];
}

const ROOT = 'root';

/**
 * The map of one thread as an outline (X04): the original sequence, with the branches that grew from it nested
 * under it as they were made, and the member's own unmade suggestions where they would continue. It shows
 * what exists: a suggestion has no number, a removed branch says "Removed" and nothing else, "You" marks only
 * the member's own position, and a long group folds until it is opened. Pure: the same inputs, the same rows.
 */
export function buildMap(input: {
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
}): MapView {
  const { filter, expanded } = input.preferences;
  const query = input.query.trim().toLowerCase();
  const mineOf = (card: ScenarioCard) => card.startedBy !== undefined && card.startedBy.personId === input.ownPersonId;

  const nodes = new Map<string, Node>();
  for (const card of input.cards) {
    const removed = card.status === 'removed';
    nodes.set(card.nodeId, {
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
        mine: mineOf(card),
        here: input.here.kind === 'branch' && input.here.nodeId === card.nodeId,
        openable: card.status === 'ready',
      },
    });
  }
  for (const suggestion of input.suggestions) {
    const id = `${suggestion.draftId}:${suggestion.optionId}`;
    nodes.set(id, {
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
    });
  }
  const top: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === undefined ? undefined : nodes.get(node.parentId);
    (parent === undefined ? top : parent.children).push(node);
  }

  // What the filter and the search keep: the nodes that match, and the path to each so it reads in place.
  const matches = (node: Node): boolean => {
    if (filter === 'suggestions' && node.row.kind !== 'suggestion') return false;
    if (filter === 'mine' && (node.row.kind !== 'branch' || !node.row.mine)) return false;
    return query === '' || node.text.includes(query);
  };
  const keep = (node: Node): boolean => {
    const kept = node.children.filter(keep);
    node.children = kept;
    return matches(node) || kept.length > 0;
  };
  const visible = top.filter(keep);

  /** Lays a group out under its parent; past `GROUP_LIMIT` the rest fold until the member opens them. */
  const place = (into: MapRow[], list: readonly Node[], depth: number, groupKey: string, parentTitle: string) => {
    const folded = query === '' && !expanded.includes(groupKey) && list.length > GROUP_LIMIT;
    for (const node of folded ? list.slice(0, GROUP_LIMIT) : list) {
      into.push({ ...node.row, depth });
      place(into, node.children, depth + 1, node.id, node.row.title);
    }
    if (folded)
      into.push({
        kind: 'more',
        key: `more:${groupKey}`,
        depth,
        groupKey,
        parentTitle,
        hidden: list.length - GROUP_LIMIT,
      });
  };

  const selected = input.selectedAssetId ?? input.episodes[0]?.assetId;
  const out: MapRow[] = [];
  const branchRows: MapRow[] = [];
  for (const episode of input.episodes) {
    out.push({
      kind: 'episode',
      key: `episode:${episode.assetId}`,
      depth: 0,
      assetId: episode.assetId,
      part: episode.part,
      title: episode.title,
      here: input.here.kind === 'original' && selected === episode.assetId,
      unavailable: episode.state === 'unavailable',
    });
    if (episode.assetId === input.rootAssetId) {
      place(branchRows, visible, 1, ROOT, episode.title);
      out.push(...branchRows);
    }
  }
  const hasBranches = branchRows.length > 0;
  const anythingMade = input.cards.length + input.suggestions.length > 0;
  return {
    title: input.threadTitle,
    rows: out,
    empty: hasBranches ? undefined : !anythingMade ? 'none' : query !== '' ? 'search' : 'filter',
  };
}
