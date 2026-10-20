import type { AccountScope } from '@knowscroll/client-core';
import type { ApplyActionRequest, ListSavedResponse } from '@knowscroll/contracts';

export function savedQueryOptions(scope: AccountScope) {
  return {
    queryKey: scope.queryKey('saved'),
    queryFn: () => scope.api.experience.listSaved({ limit: '100' }),
    staleTime: 0,
  };
}

/** Stable unknown-outcome retries and rollback, independent of a component's mount. */
export function createSavedRemoval(scope: AccountScope, newId: () => string) {
  const pending = new Map<string, ApplyActionRequest>();
  const running = new Set<string>();
  let live = true;
  scope.onEnd?.(() => {
    live = false;
    pending.clear();
    running.clear();
  });
  return async (item: ListSavedResponse['items'][number]) => {
    if (!live || !scope.active || running.has(item.assetId)) return false;
    running.add(item.assetId);
    let command = pending.get(item.assetId);
    if (!command) {
      command = {
        commandId: newId(),
        kind: 'unsave',
        target: { assetId: item.assetId, assetRevision: item.assetRevision },
      };
      pending.set(item.assetId, command);
    }
    const key = scope.queryKey('saved');
    await scope.queryClient.cancelQueries({ queryKey: key });
    if (!live || !scope.active) return false;
    const before = scope.queryClient.getQueryData<ListSavedResponse>(key);
    if (before)
      scope.queryClient.setQueryData(key, {
        ...before,
        items: before.items.filter((value) => value.assetId !== item.assetId),
      });
    try {
      await scope.api.experience.applyAction(command);
      if (!live || !scope.active) return false;
      pending.delete(item.assetId);
      await scope.queryClient.invalidateQueries({ queryKey: key });
      await scope.queryClient.invalidateQueries({ queryKey: scope.queryKey('encounter', 'context') });
      return true;
    } catch {
      if (live && scope.active && before)
        scope.queryClient.setQueryData<ListSavedResponse>(key, (current) => {
          if (!current) return before;
          if (current.items.some((value) => value.assetId === item.assetId)) return current;
          return { ...current, items: [...current.items, item].sort((a, b) => b.savedAt.localeCompare(a.savedAt)) };
        });
      return false;
    } finally {
      running.delete(item.assetId);
    }
  };
}
