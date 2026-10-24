import { useState } from 'react';
import type { AccountScope } from '@knowscroll/client-core';

export const selectedKey = (threadId: string) => `thread.selected.${threadId}`;
const foldedKey = (threadId: string) => `thread.folded.${threadId}`;

/**
 * This person's own place in the thread: the episode selected and whether the player is folded. It
 * lives in the account scope's storage on this device. It is never sent, so no one else can learn it.
 */
export function useOwnPlace(scope: AccountScope, threadId: string) {
  const [selected, setSelected] = useState(() => scope.storage.get(selectedKey(threadId)));
  const [folded, setFolded] = useState(() => scope.storage.get(foldedKey(threadId)) === '1');
  return {
    selected,
    select: (assetId: string) => {
      setSelected(assetId);
      scope.storage.set(selectedKey(threadId), assetId);
    },
    folded,
    setFolded: (next: boolean) => {
      setFolded(next);
      scope.storage.set(foldedKey(threadId), next ? '1' : '0');
    },
  };
}
