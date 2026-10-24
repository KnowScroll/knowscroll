import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  TALK_QUERY_KEY,
  createScenarioBoard,
  createScenarioComposer,
  type AccountScope,
  type ScenarioBoardController,
  type ScenarioBoardState,
  type ScenarioComposerController,
  type ScenarioComposerState,
} from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { newCommandId } from '../../platform/command-id';

/** How often the branches are read again while one is preparing, and while none is (a lost hint is repaired by this). */
const PREPARING_POLL_MS = 5_000;
const IDLE_POLL_MS = 20_000;
/** How often an open composer looks at its draft while the directions are being thought of. */
const THINKING_POLL_MS = 1_500;

/**
 * The branches of one open thread. A live inbox hint, a focus, a reconnect or the poll all read them
 * afresh, and a preparing branch is read more often, so its card turns Ready soon after it is.
 */
export function useScenarioBoard(
  scope: AccountScope,
  thread: ContentThreadRef,
): { readonly controller: ScenarioBoardController; readonly state: ScenarioBoardState } {
  const [controller] = useState(() => createScenarioBoard({ scope, thread, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const preparing = state.cards.some((card) => card.status === 'preparing');
  useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'scenario-board', thread.threadId),
    queryFn: async () => {
      await controller.load();
      return Date.now();
    },
    staleTime: 0,
    refetchInterval: preparing ? PREPARING_POLL_MS : IDLE_POLL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  return { controller, state };
}

/** One composer for one opening of the What if sheet; it looks at its draft while the directions are being thought of. */
export function useScenarioComposer(
  scope: AccountScope,
  thread: ContentThreadRef,
): { readonly controller: ScenarioComposerController; readonly state: ScenarioComposerState } {
  const [controller] = useState(() => createScenarioComposer({ scope, thread, newId: newCommandId }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    if (state.phase !== 'thinking') return undefined;
    const timer = setInterval(() => void controller.refresh(), THINKING_POLL_MS);
    return () => clearInterval(timer);
  }, [controller, state.phase]);
  return { controller, state };
}
