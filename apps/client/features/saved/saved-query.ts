import { apiProblem, type AccountScope } from '@knowscroll/client-core';
import {
  KeepEntrySnapshotSchema,
  KeepRemovalAcceptanceSchema,
  type KeepEntryRef,
  type ListSavedResponse,
  type RemoveKeepEntry,
} from '@knowscroll/contracts';

export function savedQueryOptions(scope: AccountScope) {
  return {
    queryKey: scope.queryKey('saved'),
    queryFn: () => scope.api.experience.listSaved({ limit: '100' }),
    staleTime: 0,
  };
}
type Item = Pick<ListSavedResponse['items'][number], 'assetId' | 'assetRevision' | 'metadata'>;
export type SavedRemovalState =
  | { readonly status: 'idle' | 'ended' }
  | {
      readonly status: 'preparing' | 'grace' | 'sending' | 'unknown' | 'confirmed' | 'unavailable';
      readonly item: Item;
    };
export const REMOVE_GRACE_MS = 5000;
const sameEntry = (a: KeepEntryRef, b: KeepEntryRef) =>
  a.assetId === b.assetId && a.assetRevision === b.assetRevision && a.savedEntryId === b.savedEntryId;

/** One bounded command per scope. Undo cancels only the unsent grace period; it never issues Save. */
export function createSavedRemoval(scope: AccountScope, newId: () => string) {
  let state: SavedRemovalState = { status: 'idle' };
  let command: RemoveKeepEntry | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serial = 0;
  let live = scope.active;
  const listeners = new Set<() => void>();
  const publish = (next: SavedRemovalState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const valid = (token: number) => live && scope.active && token === serial;
  const read = async (item: Item): Promise<KeepEntryRef | undefined> => {
    const value = KeepEntrySnapshotSchema.parse(
      await scope.api.keep.read({
        version: 'keep-place.v1',
        target: { assetId: item.assetId, assetRevision: item.assetRevision },
      }),
    );
    if (value.scope.accountId !== scope.account.accountId || value.scope.privacyEpoch !== scope.account.privacyEpoch)
      throw new Error('keep_scope');
    return value.status === 'not_saved' ? undefined : value.entry;
  };
  const invalidate = async () => {
    await scope.queryClient.invalidateQueries({ queryKey: scope.queryKey('saved') }).catch(() => undefined);
    if (live && scope.active)
      await scope.queryClient
        .invalidateQueries({ queryKey: scope.queryKey('encounter', 'context') })
        .catch(() => undefined);
  };
  const send = async (token: number, revalidate: boolean) => {
    const body = command;
    const selected = state;
    if (!body || !valid(token) || !('item' in selected)) return;
    // Closing Undo is synchronous and precedes every await or transport.
    publish({ status: 'sending', item: selected.item });
    try {
      if (revalidate) {
        const current = await read(selected.item);
        if (!valid(token)) return;
        if (!current || !sameEntry(current, body.entry)) {
          command = undefined;
          publish({ status: 'unavailable', item: selected.item });
          await invalidate();
          return;
        }
      }
      if (!valid(token)) return;
      const ack = KeepRemovalAcceptanceSchema.parse(await scope.api.keep.remove(body));
      if (!valid(token)) return;
      if (
        ack.commandId !== body.commandId ||
        !sameEntry(ack.entry, body.entry) ||
        ack.scope.accountId !== scope.account.accountId ||
        ack.scope.privacyEpoch !== scope.account.privacyEpoch
      )
        throw new Error('keep_ack');
      command = undefined;
      // An acknowledgement is historical. Never remove a potentially newer list item from the cache.
      publish({ status: 'confirmed', item: selected.item });
      await invalidate();
    } catch (error) {
      if (!valid(token)) return;
      const problem = apiProblem(error);
      if (problem && problem.status < 500) {
        command = undefined;
        publish({ status: 'unavailable', item: selected.item });
        await invalidate();
      } else publish({ status: 'unknown', item: selected.item });
    }
  };
  scope.onEnd?.(() => {
    live = false;
    serial++;
    clearTimeout(timer);
    command = undefined;
    publish({ status: 'ended' });
    listeners.clear();
  });
  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prepare(item: Item) {
      if (!live || !scope.active || ['preparing', 'grace', 'sending', 'unknown'].includes(state.status)) return false;
      const token = ++serial;
      publish({ status: 'preparing', item });
      try {
        const entry = await read(item);
        if (!valid(token)) return false;
        if (!entry) {
          publish({ status: 'unavailable', item });
          return false;
        }
        command = { version: 'keep-remove.v1', commandId: newId(), entry };
        publish({ status: 'grace', item });
        timer = setTimeout(() => {
          timer = undefined;
          void send(token, true);
        }, REMOVE_GRACE_MS);
        return true;
      } catch {
        if (valid(token)) publish({ status: 'unavailable', item });
        return false;
      }
    },
    undo(this: void) {
      if (!live || !scope.active || state.status !== 'grace') return false;
      clearTimeout(timer);
      timer = undefined;
      serial++;
      command = undefined;
      publish({ status: 'idle' });
      return true;
    },
    retry(this: void) {
      if (!live || !scope.active || state.status !== 'unknown' || !command) return false;
      void send(serial, false); // Exact UUID/ref and identical command even if another membership now exists.
      return true;
    },
  };
}

const removals = new WeakMap<AccountScope, ReturnType<typeof createSavedRemoval>>();
export function savedRemovalFor(scope: AccountScope, newId: () => string) {
  let removal = removals.get(scope);
  if (!removal) {
    removal = createSavedRemoval(scope, newId);
    removals.set(scope, removal);
  }
  return removal;
}
