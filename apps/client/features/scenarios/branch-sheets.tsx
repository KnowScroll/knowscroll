import { useRouter } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioSuggestion } from '@knowscroll/contracts';
import { afterPendingBack, notePendingBack } from '../../platform/after-pending-back';
import { branchHref } from '../threads/thread-links';
import { MapSheet } from './map-sheet';
import { ScenarioSheet } from './scenario-sheet';
import type { useThreadMap } from './use-thread-map';
import type { useThreadScenarios } from './use-thread-scenarios';

/**
 * Closes the map, then does what the member asked once the browser's Back that removes its history entry has
 * landed: opening a branch or another sheet any sooner is popped again with it (no wait on native).
 */
function afterMapClosed(close: () => void, then: () => void): void {
  notePendingBack();
  close();
  afterPendingBack(then);
}

/** The two overlays of a thread's branches: the sheet that asks for one (X01) and the map of them all (X04). */
export function BranchSheets({
  scope,
  thread,
  scenarios,
  map,
  suggestions,
  navigate,
  onChosen,
  onOpenEpisode,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly scenarios: ReturnType<typeof useThreadScenarios>;
  readonly map: ReturnType<typeof useThreadMap>;
  readonly suggestions: readonly ScenarioSuggestion[];
  /** Opening a branch from the map: on top of the thread, or in place of the branch already open. */
  readonly navigate: 'push' | 'replace';
  /** A branch was started from the sheet: where to go next. */
  readonly onChosen: () => void;
  /** Selects an episode of the original sequence: the member's own place there. */
  readonly onOpenEpisode: (assetId: string) => void;
}) {
  const router = useRouter();
  return (
    <>
      <ScenarioSheet
        start={scenarios.start}
        scope={scope}
        thread={thread}
        threadFull={scenarios.madeAllToday}
        onClose={scenarios.close}
        onChosen={onChosen}
      />
      <MapSheet
        visible={map.open}
        view={map.view}
        large={map.large}
        filter={map.filter}
        query={map.query}
        onFilter={map.setFilter}
        onQuery={map.setQuery}
        onClose={map.close}
        onOpenEpisode={(assetId) => afterMapClosed(map.close, () => onOpenEpisode(assetId))}
        onOpenBranch={(nodeId) => {
          afterMapClosed(map.close, () => router[navigate](branchHref(thread, nodeId)));
        }}
        onOpenOffer={(draftId, optionId) => {
          const offer = suggestions.find((entry) => entry.draftId === draftId && entry.optionId === optionId);
          afterMapClosed(map.close, () => {
            if (offer !== undefined) scenarios.openOffer(offer);
          });
        }}
        onShowMore={map.showMore}
      />
    </>
  );
}
