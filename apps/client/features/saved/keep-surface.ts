import type { AccountScope, KeepPlaceHandle, KeepPlaceState } from '@knowscroll/client-core';
import type { ApplyActionRequest, KeepAssetRef, KeepPosition } from '@knowscroll/contracts';
import { keepBridgeFor, refreshKeep, retireKeep } from './keep-place-bridge';

export interface KeepSurfaceState {
  readonly place: KeepPlaceState;
  readonly save: 'idle' | 'sending' | 'unknown' | 'confirmed' | 'unavailable';
}
const loading: KeepPlaceState = { status: 'loading', write: 'idle' };
const pendingSaves = new WeakMap<AccountScope, Map<string, ApplyActionRequest>>();
function savesFor(scope: AccountScope) {
  let commands = pendingSaves.get(scope);
  if (!commands) {
    commands = new Map();
    pendingSaves.set(scope, commands);
    const owned = commands;
    scope.onEnd?.(() => owned.clear());
  }
  return commands;
}
const ended: KeepPlaceState = { status: 'ended', write: 'idle' };
/** A direct route owns actual SDK/renderer capture; incoming restoration values never enter here. */
export function createKeepSurface(options: {
  scope: AccountScope;
  target: KeepAssetRef;
  exposureId: string;
  capture: () => KeepPosition | undefined;
  newId: () => string;
}) {
  const { scope, target, capture } = options;
  let handle: KeepPlaceHandle | undefined;
  let off: (() => void) | undefined;
  let active = false;
  let live = scope.active;
  let generation = 0;
  const saves = savesFor(scope);
  const saveKey = `${target.assetId}:${target.assetRevision}`;
  let pendingSave = saves.get(saveKey);
  let state: KeepSurfaceState = { place: loading, save: pendingSave ? 'unknown' : 'idle' };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<KeepSurfaceState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const checkpoint = () => {
    if (!live || !scope.active || !active || !handle) return false;
    const current = handle.getState();
    if (current.status !== 'ready' || current.snapshot?.status !== 'available') return false;
    const position = capture();
    if (!position) return false;
    if (
      current.snapshot.place.status === 'set' &&
      JSON.stringify(current.snapshot.place.position) === JSON.stringify(position)
    )
      return true;
    return handle.setPosition(position);
  };
  async function captureFresh() {
    const current = handle;
    const token = generation;
    if (!live || !scope.active || !active || !current) return false;
    try {
      await refreshKeep(scope, current);
      if (!live || !scope.active || !active || token !== generation || handle !== current) return false;
      return checkpoint();
    } catch {
      if (live && active && token === generation)
        publish({ place: { ...current.getState(), status: 'unavailable', reason: 'entry_unavailable' } });
      return false;
    }
  }
  scope.onEnd?.(() => {
    live = false;
    active = false;
    generation++;
    off?.();
    handle?.release();
    handle = undefined;
    pendingSave = undefined;
    publish({ place: ended, save: 'idle' });
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
      if (!live || !scope.active || active) return;
      active = true;
      generation++;
      handle = keepBridgeFor(scope).retain(target);
      if (!handle) {
        publish({ place: { status: 'unavailable', write: 'idle', reason: 'entry_unavailable' } });
        return;
      }
      const current = handle;
      off = current.subscribe(() => {
        if (live && active && handle === current) publish({ place: current.getState() });
      });
      publish({ place: current.getState() });
    },
    stop() {
      if (!active) return;
      checkpoint(); // Parent layout/focus cleanup precedes renderer disposal.
      active = false;
      generation++;
      off?.();
      off = undefined;
      if (handle) retireKeep(scope, handle);
      handle = undefined;
    },
    checkpoint,
    captureFresh,
    refresh: () => handle?.refresh(),
    retry: () => handle?.retry() ?? false,
    resolveConflict: (choice: 'server' | 'candidate') => handle?.resolveConflict(choice) ?? false,
    async save() {
      if (!live || !scope.active || state.save === 'sending') return false;
      pendingSave ??= saves.get(saveKey);
      if (!pendingSave && saves.size >= 100) {
        publish({ save: 'unavailable' });
        return false;
      }
      pendingSave ??= { commandId: options.newId(), kind: 'save', target, exposureId: options.exposureId };
      const command = pendingSave;
      saves.set(saveKey, command);
      publish({ save: 'sending' });
      try {
        const ack = await scope.api.experience.applyAction(command);
        if (!live || !scope.active || pendingSave !== command) return;
        if (
          ack.commandId !== command.commandId ||
          ack.kind !== 'save' ||
          ack.assetId !== target.assetId ||
          ack.assetRevision !== target.assetRevision ||
          !ack.saved
        )
          throw new Error('save_lineage');
        if (saves.get(saveKey) === command) saves.delete(saveKey);
        pendingSave = undefined;
        publish({ save: 'confirmed' });
        await scope.queryClient.invalidateQueries({ queryKey: scope.queryKey('saved') }).catch(() => undefined);
        await captureFresh();
        return true;
      } catch {
        if (live && scope.active && pendingSave === command) publish({ save: 'unknown' });
        return false;
      }
    },
  };
}
