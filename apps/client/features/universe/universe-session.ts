import {
  createRegionPreviewSession,
  createUniverseSceneSession,
  type AvailableRegionPreview,
  type RegionPreviewState,
  type AccountScope,
  type UniverseSceneState,
} from '@knowscroll/client-core';
import type { RegionEncounterTarget, SceneClientCapabilities } from '@knowscroll/contracts';
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
import { newCommandId } from '../../platform/command-id';
import { ENCOUNTER_CAPABILITIES } from '../encounter/capabilities';
import { encounterSessionFor } from '../encounter/use-encounter-session';
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
  readonly reducedMotion: boolean;
  readonly notice?: 'place_unavailable';
  readonly historyDepth: number;
  readonly regionPreview: RegionPreviewState;
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
/** Focus/camera/preview stay read-only; deliberate Open delegates to the real encounter engine. */
export function createUniverseViewSession(scope: AccountScope, newId = newCommandId) {
  let detail: 'full' | 'low' = 'full',
    reducedMotion = true,
    foreground = false,
    ended = false;
  let core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
  let history: CameraEntry[] = [];
  const preview = createRegionPreviewSession({ scope, capabilities: ENCOUNTER_CAPABILITIES, newReadId: newId });
  let returnPoint: { camera: CameraEntry; history: CameraEntry[] } | undefined;
  const listeners = new Set<() => void>(),
    cache = new Map<string, { key: string; geometry: SceneGeometry }>();
  let state: UniverseViewState = {
    read: core.getState(),
    frame: { ...INITIAL_FRAME },
    focusId: null,
    overlay: null,
    detail,
    reducedMotion,
    historyDepth: 0,
    regionPreview: preview.getState(),
  };
  const live = () => !ended && scope.active;
  const publish = (patch: Partial<UniverseViewState>) => {
    state = { ...state, ...patch, historyDepth: history.length };
    for (const listener of [...listeners]) listener();
  };
  const previewOff = preview.subscribe(() => publish({ regionPreview: preview.getState() }));
  const cancelPreview = () => preview.cancel();
  const target = (): RegionEncounterTarget | undefined => {
    const read = core.getState(),
      geography = read.geography;
    const object = geography?.objects.find((o) => o.id === state.focusId && o.kind === 'region');
    if (
      !object ||
      !geography ||
      read.status !== 'ready' ||
      !read.snapshot ||
      read.snapshot.read.manifest.revisions.geographyRevision !== geography.geography.revision
    )
      return;
    return {
      kind: 'region',
      regionId: object.id,
      expectedObjectRevision: object.objectRevision,
      expectedGeographyRevision: geography.geography.revision,
    };
  };
  const readPreview = () => {
    cancelPreview();
    const selected = target();
    if (live() && foreground && state.overlay === 'place' && selected)
      void preview.read(selected, {
        personalWatermark: state.read.geography!.personalWatermark,
        geographyRevision: selected.expectedGeographyRevision,
      });
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
  const validCamera = (entry: CameraEntry) => {
    if (!entry.focusId) return true;
    if (!places().some((p) => p.id === entry.focusId)) return false;
    return (
      !entry.locator ||
      Boolean(
        state.read.snapshot?.chunks.some(
          (c) => c.chunkId === entry.locator!.chunkId && c.objects.some((o) => o.objectId === entry.focusId),
        ),
      )
    );
  };
  const readChanged = () => {
    const read = core.getState(),
      hadSnapshot = Boolean(state.read.snapshot);
    if (read.status === 'ended' || read.reason === 'authority') {
      history = [];
      returnPoint = undefined;
      cancelPreview();
      cache.clear();
      publish({
        read,
        frame: { ...INITIAL_FRAME },
        focusId: null,
        locator: undefined,
        overlay: null,
        notice: undefined,
      });
      return;
    }
    cancelPreview();
    publish({
      read,
      ...(!hadSnapshot && read.snapshot && !state.focusId
        ? { frame: fitFrame(read.snapshot.chunks.flatMap((c) => c.objects).filter((o) => o.kind === 'system')) }
        : {}),
    });
    if (state.focusId && (read.snapshot || read.geography) && !validCamera(state)) {
      history = [];
      publish({ focusId: null, locator: undefined, overlay: null, notice: 'place_unavailable' });
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
      notice: undefined,
      frame: { ...INITIAL_FRAME },
      focusId: null,
      locator: undefined,
      overlay: null,
    });
    previewOff();
    preview.dispose();
    returnPoint = undefined;
    state = { ...state, regionPreview: { status: 'ended' } };
    listeners.clear();
  };
  scope.onEnd?.(end);
  const focus = (id: string) => {
    if (!live() || !foreground || !places().some((p) => p.id === id)) return false;
    cancelPreview();
    history.push({ frame: { ...state.frame }, focusId: state.focusId, locator: state.locator });
    if (history.length > DRAW_LIMITS.history) history.shift();
    const all = descriptors(),
      object = all.find((o) => o.objectId === id),
      chunk = state.read.snapshot?.chunks.find((c) => c.objects.some((o) => o.objectId === id));
    const frame = object ? fitFrame(all.filter((o) => o.objectId === id || o.parentId === id)) : state.frame;
    publish({
      focusId: id,
      notice: undefined,
      frame,
      overlay: null,
      locator: chunk ? returnLocator(chunk.chunkId, id, frame) : undefined,
    });
    return true;
  };
  const back = () => {
    if (!live() || !foreground) return false;
    if (state.overlay) {
      cancelPreview();
      publish({ overlay: null });
      return true;
    }
    cancelPreview();
    const entry = history.pop();
    if (!entry) return false;
    if (!validCamera(entry)) {
      history = [];
      publish({
        focusId: null,
        frame: { ...INITIAL_FRAME },
        locator: undefined,
        overlay: null,
        notice: 'place_unavailable',
      });
    } else publish({ ...entry, overlay: null, notice: undefined });
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
      else {
        cancelPreview();
        core.pause();
      }
    },
    configure(next: { detail: 'full' | 'low'; reducedMotion: boolean }) {
      if (!live() || (next.detail === detail && next.reducedMotion === reducedMotion)) return;
      cancelPreview();
      detail = next.detail;
      reducedMotion = next.reducedMotion;
      unsubscribe();
      core.dispose();
      cache.clear();
      core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
      unsubscribe = core.subscribe(readChanged);
      publish({ detail, reducedMotion, read: core.getState(), overlay: null });
      if (foreground) core.start();
    },
    showOverlay(overlay: UniverseViewState['overlay']) {
      if (live() && foreground && (overlay !== 'place' || state.focusId)) {
        cancelPreview();
        publish({ overlay });
        if (overlay === 'place') readPreview();
      }
    },
    refreshRegionPreview: readPreview,
    openRegion(displayed: AvailableRegionPreview, onReturn: () => void) {
      const selected = target();
      if (
        !live() ||
        !foreground ||
        state.overlay !== 'place' ||
        preview.getState().preview !== displayed ||
        !selected ||
        JSON.stringify(selected) !== JSON.stringify(displayed.target)
      )
        return false;
      const saved = {
        camera: { frame: { ...state.frame }, focusId: state.focusId, locator: state.locator },
        history: history.map((e) => ({ ...e, frame: { ...e.frame } })),
      };
      const accepted = encounterSessionFor(scope).openRegion(displayed, () => {
        if (!live() || returnPoint !== saved) return;
        history = saved.history;
        if (validCamera(saved.camera)) publish({ ...saved.camera, overlay: null, notice: undefined });
        else {
          history = [];
          publish({ focusId: null, locator: undefined, overlay: null, notice: 'place_unavailable' });
        }
        onReturn();
      });
      if (!accepted) return false;
      returnPoint = saved;
      cancelPreview();
      publish({ overlay: null });
      return true;
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
      if (live() && foreground) {
        const frame = fitFrame(
          descriptors().filter((o) =>
            !state.focusId ? o.kind === 'system' : o.objectId === state.focusId || o.parentId === state.focusId,
          ),
        );
        publish({
          frame,
          locator: state.locator ? returnLocator(state.locator.chunkId, state.locator.objectId!, frame) : undefined,
        });
      }
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
      // A retained render callback is not authority: accept only the current generation's
      // parsed descriptor reference while this screen is foregrounded. This also fences
      // descriptors held across authority refusal and capability-session replacement.
      if (!live() || !foreground || !descriptors().includes(object)) return undefined;
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
