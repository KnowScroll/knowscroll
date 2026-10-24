import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AccountScope } from '@knowscroll/client-core';

interface Mounted<T> {
  readonly scope: AccountScope;
  readonly key: string;
  readonly value: T;
}

/** What `make` returns: the resource, and how to drop it. */
export interface Made<T> {
  readonly value: T;
  readonly dispose: () => void;
}

/** React observes this slot; only an effect's setup makes the resource and only its cleanup drops it. */
function slot<T>() {
  let current: Mounted<T> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: Mounted<T> | undefined) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount(scope: AccountScope, key: string, make: (scope: AccountScope) => Made<T>) {
      if (!scope.active) return undefined;
      const made = make(scope);
      const mounted = { scope, key, value: made.value };
      publish(mounted);
      return () => {
        made.dispose();
        if (current === mounted) publish(undefined);
      };
    },
  };
}

/**
 * A resource with a lifetime (a session with timers or sockets) owned by a mounted view for one scope
 * object and key. It is made when the effect sets up and dropped when it cleans up, so React's
 * development remount makes a fresh one instead of reviving a dropped one. `undefined` until it exists.
 */
export function useMountedResource<T>(
  scope: AccountScope,
  key: string,
  make: (scope: AccountScope) => Made<T>,
): T | undefined {
  const [owner] = useState(() => slot<T>());
  const current = useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  // `make` is the caller's constructor for this key; it is not a dependency of when to remake.
  useEffect(() => owner.mount(scope, key, make), [owner, scope, key]); // eslint-disable-line react-hooks/exhaustive-deps -- remade only for a new scope or key
  return current?.scope === scope && current.key === key && scope.active ? current.value : undefined;
}
