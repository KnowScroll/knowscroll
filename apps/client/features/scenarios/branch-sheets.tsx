import { useRouter } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioSuggestion } from '@knowscroll/contracts';
import { branchHref } from '../threads/thread-links';
import { MapSheet } from './map-sheet';
import { ScenarioSheet } from './scenario-sheet';
import type { useThreadMap } from './use-thread-map';
import type { useThreadScenarios } from './use-thread-scenarios';

/** The two overlays of a thread's branches: the sheet that asks for one (X01) and the map of them all (X04). */
export function BranchSheets({
  scope,
  thread,
  scenarios,
  map,
  suggestions,
  onOpenEpisode,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly scenarios: ReturnType<typeof useThreadScenarios>;
  readonly map: ReturnType<typeof useThreadMap>;
  readonly suggestions: readonly ScenarioSuggestion[];
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
        onClose={scenarios.close}
        onChosen={scenarios.branchStarted}
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
        onOpenEpisode={(assetId) => {
          map.close();
          onOpenEpisode(assetId);
        }}
        onOpenBranch={(nodeId) => {
          map.close();
          router.push(branchHref(thread, nodeId));
        }}
        onOpenOffer={(draftId, optionId) => {
          const offer = suggestions.find((entry) => entry.draftId === draftId && entry.optionId === optionId);
          map.close();
          if (offer !== undefined) scenarios.openOffer(offer);
        }}
        onShowMore={map.showMore}
      />
    </>
  );
}
