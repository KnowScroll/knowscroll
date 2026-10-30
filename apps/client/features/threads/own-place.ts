import { useCallback, useState } from 'react';
import type { AccountScope } from '@knowscroll/client-core';

export const selectedKey = (threadId: string) => `thread.selected.${threadId}`;
const foldedKey = (threadId: string) => `thread.folded.${threadId}`;

/**
 * This person's own place in the thread: the episode selected and whether the player is folded. It
 * lives in the account scope's storage on this device. It is never sent, so no one else can learn it.
 *
 * Until the person folds or unfolds the player themselves, `defaultFolded` decides: a phone starts
 * with the player docked so the conversation keeps the screen. Their own choice, once made, wins.
 */
export function useOwnPlace(scope: AccountScope, threadId: string, defaultFolded = false) {
  const [selected, setSelected] = useState(() => scope.storage.get(selectedKey(threadId)));
  const [chosenFold, setChosenFold] = useState<boolean | undefined>(() => {
    const stored = scope.storage.get(foldedKey(threadId));
    return stored === undefined ? undefined : stored === '1';
  });
  // Stable, so a screen can hand them on without every render looking like a change.
  const select = useCallback(
    (assetId: string) => {
      setSelected(assetId);
      scope.storage.set(selectedKey(threadId), assetId);
    },
    [scope, threadId],
  );
  const setFolded = useCallback(
    (next: boolean) => {
      setChosenFold(next);
      scope.storage.set(foldedKey(threadId), next ? '1' : '0');
    },
    [scope, threadId],
  );
  return { selected, select, folded: chosenFold ?? defaultFolded, setFolded };
}
