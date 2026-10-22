import {
  createKeepPlaceSession,
  type AccountScope,
  type KeepPlaceHandle,
  type KeepPlaceState,
} from '@knowscroll/client-core';
import type { KeepAssetRef, KeepEntrySnapshot, KeepPosition } from '@knowscroll/contracts';
import type { EncounterEntry, PrivatePosition } from '../encounter/encounter-history';
import { newCommandId } from '../../platform/command-id';

export type AvailableKeep = Extract<KeepEntrySnapshot, { status: 'available' }>;
const loading: KeepPlaceState = Object.freeze({ status: 'loading', write: 'idle' });
const ended: KeepPlaceState = Object.freeze({ status: 'ended', write: 'idle' });
const unavailable: KeepPlaceState = Object.freeze({
  status: 'unavailable',
  write: 'idle',
  reason: 'entry_unavailable',
});
const bridges = new WeakMap<AccountScope, ReturnType<typeof makeBridge>>();

/** App budget: twenty cards, forty retiring route/encounter writes and selected/current work. */
function makeBridge(scope: AccountScope) {
  const session = createKeepPlaceSession({ scope, newCommandId });
  const leases = new Set<KeepPlaceHandle>();
  let live = true;
  scope.onEnd?.(() => {
    live = false;
    for (const lease of leases) lease.release();
    leases.clear();
  });
  return {
    retain(target: KeepAssetRef): KeepPlaceHandle | undefined {
      if (!live || !scope.active || leases.size >= 64) return undefined;
      const handle = session.retain(target);
      if (!handle) return undefined;
      const pending = retiringSurfaces.get(scope);
      if (pending)
        for (const [held, off] of pending) {
          const ref = held.getState().snapshot?.target;
          if (ref?.assetId !== target.assetId || ref.assetRevision !== target.assetRevision) continue;
          off();
          pending.delete(held);
          held.release();
        }
      const lease: KeepPlaceHandle = {
        ...handle,
        release() {
          if (!leases.delete(lease)) return;
          handle.release();
        },
      };
      leases.add(lease);
      return lease;
    },
  };
}
export function keepBridgeFor(scope: AccountScope) {
  let bridge = bridges.get(scope);
  if (!bridge) {
    bridge = makeBridge(scope);
    bridges.set(scope, bridge);
  }
  return bridge;
}

/** Mount ownership is acquired in an effect, so StrictMode can release/reacquire the same view. */
export function createKeepView(scope: AccountScope, target: KeepAssetRef, savedEntryId?: string) {
  let handle: KeepPlaceHandle | undefined;
  let off: (() => void) | undefined;
  let endOff: (() => void) | undefined;
  let refused = false;
  const listeners = new Set<() => void>();
  const boundState = () => {
    if (!scope.active) return ended;
    const state = handle?.getState() ?? (refused ? unavailable : loading);
    const snapshot = state.snapshot;
    // A new membership for the same asset is not the membership displayed by this card/detail.
    if (
      savedEntryId &&
      snapshot &&
      (snapshot.status === 'not_saved' ||
        snapshot.entry.savedEntryId !== savedEntryId ||
        snapshot.entry.assetId !== target.assetId ||
        snapshot.entry.assetRevision !== target.assetRevision)
    )
      return unavailable;
    return state;
  };
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: boundState,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (handle || !scope.active) return;
      handle = keepBridgeFor(scope).retain(target);
      refused = !handle;
      off = handle?.subscribe(emit);
      endOff = scope.onEnd?.(() => {
        off?.();
        handle?.release();
        handle = undefined;
        emit();
        listeners.clear();
      });
      emit();
    },
    stop() {
      endOff?.();
      endOff = undefined;
      off?.();
      off = undefined;
      handle?.release();
      handle = undefined;
      emit();
    },
    refresh: () => handle?.refresh(),
    retry: () => boundState() !== unavailable && (handle?.retry() ?? false),
    resolveConflict: (choice: 'server' | 'candidate') =>
      boundState() !== unavailable && (handle?.resolveConflict(choice) ?? false),
  };
}

/** A later authoritative read, never ACK state. Scope end/release/deadline cancels the wait. */
export function refreshKeep(scope: AccountScope, handle: KeepPlaceHandle): Promise<AvailableKeep> {
  const prior = handle.getState().snapshot;
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanups: (() => void)[] = [];
    const timer = setTimeout(() => finish(), 8000);
    const finish = (snapshot?: AvailableKeep) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      if (snapshot) resolve(snapshot);
      else reject(new Error('keep_unavailable'));
    };
    const check = () => {
      const state = handle.getState();
      if (!scope.active || state.status === 'ended' || state.status === 'unavailable') {
        finish();
        return;
      }
      if (state.status === 'ready' && state.snapshot !== prior) {
        if (state.snapshot?.status === 'available') finish(state.snapshot);
        else finish();
      }
    };
    cleanups.push(handle.subscribe(check));
    const end = scope.onEnd?.(() => finish());
    if (end) cleanups.push(end);
    handle.refresh();
    check();
  });
}
export function sameKeep(a: AvailableKeep, b: AvailableKeep): boolean {
  return (
    JSON.stringify(a.scope) === JSON.stringify(b.scope) &&
    JSON.stringify(a.target) === JSON.stringify(b.target) &&
    JSON.stringify(a.entry) === JSON.stringify(b.entry) &&
    JSON.stringify(a.place) === JSON.stringify(b.place)
  );
}
export function keepPositionFor(entry: EncounterEntry, snapshot?: AvailableKeep): PrivatePosition | undefined {
  if (!snapshot) {
    if (entry.kind === 'reel') return { kind: 'reel', positionMs: 0, playing: false, muted: false };
    const block = entry.scroll.document.sections[0]?.blocks[0];
    return block
      ? {
          kind: 'scroll',
          value: {
            assetId: entry.offer.assetId,
            revision: entry.offer.assetRevision,
            blockId: block.id,
            offsetWithinBlock: 0,
          },
        }
      : undefined;
  }
  if (
    snapshot.entry.assetId !== entry.offer.assetId ||
    snapshot.entry.assetRevision !== entry.offer.assetRevision ||
    snapshot.place.status !== 'set'
  )
    return undefined;
  const p = snapshot.place.position;
  if (entry.kind === 'reel' && p.kind === 'reel')
    return {
      kind: 'reel',
      positionMs: Math.min(p.positionMs, entry.document.durationMs),
      playing: false,
      muted: false,
    };
  if (
    entry.kind === 'scroll' &&
    p.kind === 'scroll' &&
    entry.scroll.document.sections.some((s) => s.blocks.some((b) => b.id === p.blockId))
  )
    return {
      kind: 'scroll',
      value: {
        assetId: entry.offer.assetId,
        revision: entry.offer.assetRevision,
        blockId: p.blockId,
        offsetWithinBlock: p.offsetWithinBlock,
      },
    };
  return undefined;
}
/** Only an actual measured surface capture is eligible; never a local/incoming resume record. */
export function checkpointPosition(entry: EncounterEntry, capture: PrivatePosition): KeepPosition | undefined {
  if (
    entry.kind === 'reel' &&
    capture.kind === 'reel' &&
    Number.isFinite(capture.positionMs) &&
    capture.positionMs >= 0
  )
    return { kind: 'reel', positionMs: Math.min(capture.positionMs, entry.document.durationMs) };
  if (
    entry.kind === 'scroll' &&
    capture.kind === 'scroll' &&
    capture.value.assetId === entry.offer.assetId &&
    capture.value.revision === entry.offer.assetRevision &&
    Number.isFinite(capture.value.offsetWithinBlock) &&
    capture.value.offsetWithinBlock >= 0 &&
    entry.scroll.document.sections.some((s) => s.blocks.some((b) => b.id === capture.value.blockId))
  )
    return { kind: 'scroll', blockId: capture.value.blockId, offsetWithinBlock: capture.value.offsetWithinBlock };
  return undefined;
}

const retiringSurfaces = new WeakMap<AccountScope, Map<KeepPlaceHandle, () => void>>();
/** Let a submitted direct-surface write settle; retain unknown/conflict choices for a later visit. */
export function retireKeep(scope: AccountScope, handle: KeepPlaceHandle) {
  let pending = retiringSurfaces.get(scope);
  if (!pending) {
    pending = new Map();
    retiringSurfaces.set(scope, pending);
    const heldMap = pending;
    scope.onEnd?.(() => {
      for (const [held, off] of heldMap) {
        off();
        held.release();
      }
      heldMap.clear();
    });
  }
  const current = handle.getState();
  if (current.write === 'idle' || current.status === 'ended' || pending.size >= 20) {
    handle.release();
    return;
  }
  const complete = () => {
    const value = handle.getState();
    if (value.write !== 'idle' && value.status !== 'ended') return;
    pending.get(handle)?.();
    pending.delete(handle);
    handle.release();
  };
  pending.set(handle, handle.subscribe(complete));
  complete();
}
