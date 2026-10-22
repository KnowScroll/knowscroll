import { QueryObserver } from '@tanstack/react-query';
import { apiProblem, type AccountScope } from '@knowscroll/client-core';
import {
  KeepEntrySnapshotSchema,
  KeepRemovalAcceptanceSchema,
  type KeepEntryRef,
  SavedPageResponseSchema,
  type SavedPageResponse,
  type RemoveKeepEntry,
} from '@knowscroll/contracts';

export type SavedItem = SavedPageResponse['items'][number];
type Filter = SavedPageResponse['filter'];
const SAVED_PAGE_SIZE = 20;
const SAVED_BACK_HISTORY = 20;
export function savedQueryOptions(scope: AccountScope, filter: Filter = 'all', cursor?: string) {
  return {
    queryKey: scope.queryKey('saved', 'page', filter, cursor ?? 'first'),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const value = SavedPageResponseSchema.parse(
        await scope.api.experience.listSaved(
          {
            pagination: 'saved-page.v1',
            filter,
            limit: '20',
            ...(cursor ? { cursor } : {}),
          },
          { signal },
        ),
      );
      if (
        !scope.active ||
        value.scope.accountId !== scope.account.accountId ||
        value.scope.privacyEpoch !== scope.account.privacyEpoch ||
        value.filter !== filter ||
        value.limit !== SAVED_PAGE_SIZE ||
        value.requestCursor !== cursor
      )
        throw new Error('saved_page_binding');
      return value;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false as const,
  };
}
type SavedPagesState = {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'ended';
  readonly filter: Filter;
  readonly page?: SavedPageResponse;
  readonly selected?: SavedItem;
  readonly canPrevious: boolean;
  readonly olderDiscarded: boolean;
};
/** One payload-bearing query, twenty opaque previous cursors, no growing item accumulator.
 * Selection and page payloads live in the actual scope and are synchronously purged on end. */
export function createSavedPages(scope: AccountScope) {
  let state: SavedPagesState = { status: 'idle', filter: 'all', canPrevious: false, olderDiscarded: false };
  let cursor: string | undefined;
  const history: (string | undefined)[] = [];
  let watermark = -1;
  let serial = 0;
  let observer:
    | QueryObserver<
        SavedPageResponse,
        Error,
        SavedPageResponse,
        SavedPageResponse,
        ReturnType<AccountScope['queryKey']>
      >
    | undefined;
  let off: (() => void) | undefined;
  let active = false;
  const listeners = new Set<() => void>();
  const publish = (next: SavedPagesState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const clearQuery = () => {
    serial++;
    off?.();
    off = undefined;
    const key = observer?.options.queryKey;
    observer?.destroy();
    observer = undefined;
    if (key) {
      void scope.queryClient.cancelQueries({ queryKey: key, exact: true });
      scope.queryClient.removeQueries({ queryKey: key, exact: true });
    }
  };
  const load = () => {
    clearQuery();
    if (!active || !scope.active) return;
    const token = serial;
    const options = savedQueryOptions(scope, state.filter, cursor);
    const current = new QueryObserver<
      SavedPageResponse,
      Error,
      SavedPageResponse,
      SavedPageResponse,
      ReturnType<AccountScope['queryKey']>
    >(scope.queryClient, {
      ...options,
      queryFn: async (context) => {
        const value = await options.queryFn(context);
        if (context.signal.aborted || token !== serial || !scope.active || value.revision < watermark)
          throw new Error('saved_page_stale');
        return value;
      },
    });
    observer = current;
    publish({
      status: 'loading',
      filter: state.filter,
      canPrevious: history.length > 0,
      olderDiscarded: state.olderDiscarded,
    });
    off = current.subscribe((result) => {
      if (!scope.active || token !== serial) return;
      if (result.isError || (result.data && result.data.revision < watermark)) {
        publish({ ...state, status: 'unavailable', page: undefined, selected: undefined });
      } else if (result.data) {
        watermark = result.data.revision;
        const selected =
          state.selected &&
          result.data.items.find(
            (item) =>
              item.savedEntryId === state.selected?.savedEntryId &&
              item.assetId === state.selected.assetId &&
              item.assetRevision === state.selected.assetRevision,
          );
        publish({ ...state, status: 'ready', page: result.data, selected });
      }
    });
  };
  scope.onEnd?.(() => {
    active = false;
    clearQuery();
    history.length = 0;
    cursor = undefined;
    watermark = -1;
    publish({ status: 'ended', filter: 'all', canPrevious: false, olderDiscarded: false });
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
    start() {
      if (active || !scope.active) return;
      active = true;
      load();
    },
    stop() {
      active = false;
      clearQuery();
      publish({ ...state, status: scope.active ? 'idle' : 'ended', page: undefined, selected: undefined });
    },
    refresh(filter: Filter = state.filter) {
      if (!scope.active) return;
      history.length = 0;
      cursor = undefined;
      watermark = -1;
      publish({ status: 'idle', filter, canPrevious: false, olderDiscarded: false });
      load();
    },
    next() {
      if (state.status !== 'ready' || state.page?.continuation.status !== 'more') return false;
      history.push(cursor);
      const discarded = history.length > SAVED_BACK_HISTORY;
      if (discarded) history.shift();
      cursor = state.page.continuation.cursor;
      publish({ ...state, selected: undefined, olderDiscarded: state.olderDiscarded || discarded });
      load();
      return true;
    },
    previous() {
      if (state.status !== 'ready' || history.length === 0) return false;
      cursor = history.pop();
      load();
      return true;
    },
    select(item?: SavedItem) {
      if (!scope.active || state.status !== 'ready') return;
      const selected =
        item &&
        state.page?.items.find(
          (value) =>
            value.savedEntryId === item.savedEntryId &&
            value.assetId === item.assetId &&
            value.assetRevision === item.assetRevision,
        );
      publish({ ...state, selected });
    },
  };
}
const pageSessions = new WeakMap<AccountScope, ReturnType<typeof createSavedPages>>();
/** Repeated route mounts share the same bounded scope resource, never another history allocation. */
export function savedPagesFor(scope: AccountScope) {
  let pages = pageSessions.get(scope);
  if (!pages) {
    pages = createSavedPages(scope);
    pageSessions.set(scope, pages);
  }
  return pages;
}
type Item = Pick<SavedItem, 'assetId' | 'assetRevision'> & Partial<Pick<SavedItem, 'metadata' | 'savedEntryId'>>;
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
  let ambiguous = false;
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
    if (value.target.assetId !== item.assetId || value.target.assetRevision !== item.assetRevision)
      throw new Error('keep_target');
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
      if (problem && problem.status < 500 && !ambiguous) {
        command = undefined;
        publish({ status: 'unavailable', item: selected.item });
        await invalidate();
      } else {
        // A refused retry cannot establish what an earlier lost response committed.
        // Keep the original A body until its own receipt reconciles it, even if B now exists.
        ambiguous = true;
        publish({ status: 'unknown', item: selected.item });
      }
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
        if (!item.savedEntryId || !entry || entry.savedEntryId !== item.savedEntryId) {
          publish({ status: 'unavailable', item });
          return false;
        }
        ambiguous = false;
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
