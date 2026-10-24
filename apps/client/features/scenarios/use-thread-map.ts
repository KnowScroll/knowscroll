import { useState } from 'react';
import {
  DEFAULT_MAP_PREFERENCES,
  buildMap,
  loadHere,
  loadMapPreferences,
  saveMapPreferences,
  type AccountScope,
  type MapFilter,
  type MapPreferences,
  type MapView,
} from '@knowscroll/client-core';
import type { ScenarioCard, ScenarioSuggestion, ThreadEpisode } from '@knowscroll/contracts';
import { LARGE_MAP } from './map-sheet';

/**
 * The thread's map (X04): whether it is open, what the member filtered and opened on this device, and the
 * outline those make from the branches as last read. Nothing here is sent: the filter, the opened groups
 * and "You" are the member's own and stay in the account scope's storage.
 */
export function useThreadMap(options: {
  readonly scope: AccountScope;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly episodes: readonly ThreadEpisode[];
  readonly rootAssetId: string | undefined;
  readonly cards: readonly ScenarioCard[];
  readonly suggestions: readonly ScenarioSuggestion[];
  readonly ownPersonId: string | undefined;
  /** The episode the member has selected in the original sequence. */
  readonly selectedAssetId: string | undefined;
}) {
  const { scope, threadId } = options;
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<MapPreferences>(() => loadMapPreferences(scope.storage, threadId));
  const [query, setQuery] = useState('');
  const large = options.cards.length + options.suggestions.length >= LARGE_MAP;
  // A small map is only its outline: the filter and the search belong to a large one, and are ignored below that.
  const preferences = large ? stored : { ...DEFAULT_MAP_PREFERENCES, expanded: stored.expanded };
  const view: MapView = buildMap({
    threadTitle: options.threadTitle,
    episodes: options.episodes,
    rootAssetId: options.rootAssetId ?? '',
    cards: options.cards,
    suggestions: options.suggestions,
    ownPersonId: options.ownPersonId,
    here: open ? loadHere(scope.storage, threadId) : { kind: 'original' },
    selectedAssetId: options.selectedAssetId,
    preferences,
    query: large ? query : '',
  });
  const keep = (next: MapPreferences) => {
    setStored(next);
    saveMapPreferences(scope.storage, threadId, next);
  };
  return {
    open,
    view,
    large,
    filter: preferences.filter,
    query,
    show: () => setOpen(true),
    close: () => setOpen(false),
    setFilter: (filter: MapFilter) => keep({ ...stored, filter }),
    setQuery,
    showMore: (groupKey: string) => keep({ ...stored, expanded: [...new Set([...stored.expanded, groupKey])] }),
  };
}
