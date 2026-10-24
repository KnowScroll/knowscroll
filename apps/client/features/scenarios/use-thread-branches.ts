import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { mapOffered, saveHere, type AccountScope, type ContentThreadState } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioCard } from '@knowscroll/contracts';
import { branchHref } from '../threads/thread-links';
import type { useScenarioBoard } from './use-scenarios';
import { useThreadMap } from './use-thread-map';
import { useThreadScenarios } from './use-thread-scenarios';

/**
 * Everything one open thread does with its branches, in one place: asking for them (X01), the map (X04),
 * and opening one (X03). The thread screen draws the cards and the buttons; this decides what they do.
 */
export function useThreadBranches(options: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly title: string;
  readonly state: Pick<ContentThreadState, 'episodes' | 'root' | 'participants'>;
  /** The branches as last read (`useScenarioBoard`), owned by the screen because the message list follows them. */
  readonly board: ReturnType<typeof useScenarioBoard>;
  /** The episode the member has selected in the original sequence. */
  readonly selectedAssetId: string | undefined;
  readonly onBranchStarted: () => void;
}) {
  const { scope, thread, state, board } = options;
  const router = useRouter();
  const scenarios = useThreadScenarios({
    board: board.controller,
    cards: board.state.cards,
    rootRevision: state.root?.target.assetRevision,
    onBranchStarted: options.onBranchStarted,
  });
  const map = useThreadMap({
    scope,
    threadId: thread.threadId,
    threadTitle: options.title,
    episodes: state.episodes,
    rootAssetId: state.root?.target.assetId,
    cards: board.state.cards,
    suggestions: board.state.suggestions,
    ownPersonId: state.participants.find((participant) => participant.you)?.person.personId,
    selectedAssetId: options.selectedAssetId,
  });
  // Back on the thread's own page, the member is in the original sequence again.
  useFocusEffect(
    useCallback(() => {
      saveHere(scope.storage, thread.threadId, { kind: 'original' });
    }, [scope, thread.threadId]),
  );
  return {
    scenarios,
    map,
    mapOffered: mapOffered(board.state.cards),
    openBranch: (card: ScenarioCard) => {
      if (card.content !== undefined) router.push(branchHref(thread, card.nodeId));
    },
  };
}
