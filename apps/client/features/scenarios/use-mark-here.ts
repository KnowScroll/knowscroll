import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { saveHere, type AccountScope } from '@knowscroll/client-core';

/**
 * Remembers, on this device only, where the member is while this screen is the one in front: in a branch
 * (give its `nodeId`) or in the thread's original sequence. The map reads it to put "You" on the member's own
 * place and nowhere else; nothing here is sent, so no one else can learn it.
 */
export function useMarkHere(scope: AccountScope, threadId: string, nodeId?: string): void {
  useFocusEffect(
    useCallback(() => {
      saveHere(scope.storage, threadId, nodeId === undefined ? { kind: 'original' } : { kind: 'branch', nodeId });
    }, [scope, threadId, nodeId]),
  );
}
