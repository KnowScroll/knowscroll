import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { createConversationsSession, type AccountScope } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

type Session = ReturnType<typeof createConversationsSession>;
type Owner = { session: Session; views: Set<object>; foreground: boolean; offsets: Map<string, number> };
const owners = new WeakMap<AccountScope, Owner>();
/** The scope owns drafts. Tab/detail/StrictMode cleanup releases visibility, never the owner. */
export function conversationsFor(scope: AccountScope): Session {
  let owner = owners.get(scope);
  if (!owner) {
    owner = {
      session: createConversationsSession({ scope, newCommandId }),
      views: new Set(),
      offsets: new Map(),
      foreground: AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
    };
    owners.set(scope, owner);
    const retained = owner;
    scope.onEnd?.(() => {
      retained.views.clear();
      retained.offsets.clear();
      retained.foreground = false;
      retained.session.focus(false);
      // Core owns synchronous disposal of all body/command/selector/cursor copies.
      retained.session.dispose();
      // Keep the ended, body-free owner until the scope object is collected. A final old-subtree
      // render must not recreate an inactive scope owner before the provider remounts.
    });
  }
  return owner.session;
}
export function useConversationsSession(scope: AccountScope) {
  const session = conversationsFor(scope);
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const snapshot = useCallback(() => session.getState(), [session]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useFocusEffect(
    useCallback(() => {
      const owner = owners.get(scope);
      if (!owner || !scope.active) return;
      const view = {};
      owner.views.add(view);
      owner.session.focus(owner.foreground);
      return () => {
        owner.views.delete(view);
        owner.session.focus(owner.foreground && owner.views.size > 0);
      };
    }, [scope]),
  );
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => {
      const owner = owners.get(scope);
      if (!owner || !scope.active) return;
      owner.foreground = next === 'active';
      owner.session.focus(owner.foreground && owner.views.size > 0);
    });
    return () => listener.remove();
  }, [scope]);
  return { session, state };
}

/** Bounded body-free viewport copies belong to the same scope owner and purge with it. */
export function conversationOffset(scope: AccountScope, key: string): number {
  return scope.active ? (owners.get(scope)?.offsets.get(key) ?? 0) : 0;
}
export function retainConversationOffset(scope: AccountScope, key: string, offset: number): void {
  const owner = owners.get(scope);
  if (!owner || !scope.active || !Number.isFinite(offset) || offset < 0) return;
  if (!owner.offsets.has(key) && owner.offsets.size >= 8) owner.offsets.delete(owner.offsets.keys().next().value!);
  owner.offsets.set(key, offset);
}
