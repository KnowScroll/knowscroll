import { createUniverseSceneSession, type AccountScope, type UniverseSceneState } from '@knowscroll/client-core';
import type { SceneClientCapabilities } from '@knowscroll/contracts';
import {
  buildSceneGeometry,
  type SceneDescriptor,
  type SceneGeometry,
  type SceneReturnLocator,
} from '@knowscroll/scene-core';
import {
  boundedFrame,
  DRAW_LIMITS,
  fitFrame,
  INITIAL_FRAME,
  returnLocator,
  type UniverseFrame,
} from './universe-camera';
export interface UniversePlace {
  readonly id: string;
  readonly parentId: string;
  readonly kind: SceneDescriptor['kind'];
  readonly label: string;
  readonly truthStatus: SceneDescriptor['truthStatus'];
}
interface CameraEntry {
  readonly frame: UniverseFrame;
  readonly focusId: string | null;
  readonly locator?: SceneReturnLocator;
}
export interface UniverseViewState extends CameraEntry {
  readonly read: UniverseSceneState;
  readonly overlay: 'outline' | 'place' | null;
  readonly detail: 'full' | 'low';
  readonly historyDepth: number;
}
export function sceneCapabilities(detail: 'full' | 'low', reducedMotion: boolean): SceneClientCapabilities {
  return {
    version: 'scene-client.v1',
    descriptors: ['scene-descriptor.v1'],
    chunks: ['scene-chunk.v1'],
    manifests: ['scene-manifest.v1'],
    generators: ['silhouette.v1'],
    families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
    detail,
    reducedMotion,
  };
}
/** Map actions perform no writes, recording, socket creation or semantic target resolution. */
export function createUniverseViewSession(scope: AccountScope) {
  let detail: 'full' | 'low' = 'full',
    reducedMotion = true,
    foreground = false,
    ended = false;
  let core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
  let history: CameraEntry[] = [];
  const listeners = new Set<() => void>(),
    cache = new Map<string, { key: string; geometry: SceneGeometry }>();
  let state: UniverseViewState = {
    read: core.getState(),
    frame: { ...INITIAL_FRAME },
    focusId: null,
    overlay: null,
    detail,
    historyDepth: 0,
  };
  const live = () => !ended && scope.active;
  const publish = (patch: Partial<UniverseViewState>) => {
    state = { ...state, ...patch, historyDepth: history.length };
    for (const listener of [...listeners]) listener();
  };
  const descriptors = () => (live() ? (state.read.snapshot?.chunks.flatMap((c) => c.objects) ?? []) : []);
  const places = (): readonly UniversePlace[] => {
    if (!live()) return [];
    // Stale Scene labels stay with that Scene, never newer Geography labels.
    if (state.read.snapshot)
      return descriptors().map((o) => ({
        id: o.objectId,
        parentId: o.parentId,
        kind: o.kind,
        label: o.label,
        truthStatus: o.truthStatus,
      }));
    return (
      state.read.geography?.objects.map((o) => ({
        id: o.id,
        parentId: o.parent.id,
        kind: o.kind,
        label: o.label,
        truthStatus: o.truthStatus,
      })) ?? []
    );
  };
  const readChanged = () => {
    const read = core.getState(),
      hadSnapshot = Boolean(state.read.snapshot);
    if (read.status === 'ended' || read.reason === 'authority') {
      history = [];
      cache.clear();
      publish({ read, frame: { ...INITIAL_FRAME }, focusId: null, locator: undefined, overlay: null });
      return;
    }
    publish({
      read,
      ...(!hadSnapshot && read.snapshot && !state.focusId
        ? { frame: fitFrame(read.snapshot.chunks.flatMap((c) => c.objects).filter((o) => o.kind === 'system')) }
        : {}),
    });
    if (state.focusId && (read.snapshot || read.geography) && !places().some((p) => p.id === state.focusId)) {
      history = [];
      publish({ focusId: null, locator: undefined, overlay: null });
    }
  };
  let unsubscribe = core.subscribe(readChanged);
  const end = () => {
    if (ended) return;
    ended = true;
    foreground = false;
    history = [];
    cache.clear();
    unsubscribe();
    core.dispose();
    publish({
      read: { status: 'ended', active: false },
      frame: { ...INITIAL_FRAME },
      focusId: null,
      locator: undefined,
      overlay: null,
    });
    listeners.clear();
  };
  scope.onEnd?.(end);
  const focus = (id: string) => {
    if (!live() || !foreground || !places().some((p) => p.id === id)) return false;
    history.push({ frame: { ...state.frame }, focusId: state.focusId, locator: state.locator });
    if (history.length > DRAW_LIMITS.history) history.shift();
    const all = descriptors(),
      object = all.find((o) => o.objectId === id),
      chunk = state.read.snapshot?.chunks.find((c) => c.objects.some((o) => o.objectId === id));
    const frame = object ? fitFrame(all.filter((o) => o.objectId === id || o.parentId === id)) : state.frame;
    publish({
      focusId: id,
      frame,
      overlay: null,
      locator: chunk ? returnLocator(chunk.chunkId, id, frame) : undefined,
    });
    return true;
  };
  const back = () => {
    if (!live() || !foreground) return false;
    if (state.overlay) {
      publish({ overlay: null });
      return true;
    }
    const entry = history.pop();
    if (!entry) return false;
    if (entry.focusId && !places().some((p) => p.id === entry.focusId)) {
      history = [];
      publish({ focusId: null, frame: { ...INITIAL_FRAME }, locator: undefined, overlay: null });
    } else publish({ ...entry, overlay: null });
    return true;
  };
  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      if (!live()) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    places,
    descriptors,
    focus,
    back,
    canBack: () => live() && (history.length > 0 || state.overlay !== null),
    setForeground(value: boolean) {
      if (!live()) return;
      foreground = value;
      if (value) core.resume();
      else core.pause();
    },
    configure(next: { detail: 'full' | 'low'; reducedMotion: boolean }) {
      if (!live() || (next.detail === detail && next.reducedMotion === reducedMotion)) return;
      detail = next.detail;
      reducedMotion = next.reducedMotion;
      unsubscribe();
      core.dispose();
      cache.clear();
      core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
      unsubscribe = core.subscribe(readChanged);
      publish({ detail, read: core.getState(), overlay: null });
      if (foreground) core.start();
    },
    showOverlay(overlay: UniverseViewState['overlay']) {
      if (live() && foreground && (overlay !== 'place' || state.focusId)) publish({ overlay });
    },
    camera(frame: UniverseFrame) {
      if (live() && foreground) {
        const next = boundedFrame(frame);
        publish({
          frame: next,
          locator: state.locator ? returnLocator(state.locator.chunkId, state.locator.objectId!, next) : undefined,
        });
      }
    },
    fit() {
      if (live() && foreground)
        publish({
          frame: fitFrame(
            descriptors().filter((o) =>
              !state.focusId ? o.kind === 'system' : o.objectId === state.focusId || o.parentId === state.focusId,
            ),
          ),
        });
    },
    async refresh() {
      if (live() && foreground) await core.refresh();
    },
    travel(routeId: string) {
      if (!live() || !foreground || !state.read.snapshot || state.read.status !== 'ready') return false;
      const route = state.read.snapshot.chunks.flatMap((c) => c.routes).find((r) => r.id === routeId);
      if (!route || (route.fromObjectId !== state.focusId && route.toObjectId !== state.focusId)) return false;
      return focus(route.fromObjectId === state.focusId ? route.toObjectId : route.fromObjectId);
    },
    geometry(object: SceneDescriptor, low = false) {
      if (!live()) return undefined;
      const options = { detail: low ? ('low' as const) : detail, reducedMotion },
        key = JSON.stringify([object, options]),
        previous = cache.get(object.objectId);
      if (previous?.key === key) return previous.geometry;
      const geometry = buildSceneGeometry(object, options);
      cache.delete(object.objectId);
      cache.set(object.objectId, { key, geometry });
      while (cache.size > DRAW_LIMITS.cache) cache.delete(cache.keys().next().value!);
      return geometry;
    },
    cacheSize: () => cache.size,
  };
}
export type UniverseViewSession = ReturnType<typeof createUniverseViewSession>;
