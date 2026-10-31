import type { SceneDescriptor, SceneGeometry } from '@knowscroll/scene-core';
import { boundedFrame, DRAW_LIMITS, INITIAL_FRAME, type UniverseFrame } from '../universe/universe-camera';
import { createCameraHistory, type CameraEntry } from '../universe/universe-camera-history';
import { NO_DUST } from '../universe/universe-dust';
import { createGeometryCache } from '../universe/universe-geometry-cache';
import type { UniverseMapSession, UniversePlace, UniverseViewState } from '../universe/universe-session';

/**
 * The camera and selection of a friend's universe: the same `UniverseMapSession` the map is drawn
 * from, over a list of places the owner shared. There is nothing here that belongs to your own
 * universe: no formation story, no region cards (regions are never shared), no Lately lens (a visitor
 * sees no activity), no ship parked at a place you went to, and no memory on this device. Where the
 * camera has been is kept only while the screen is open and is never stored or sent.
 */
export interface VisitMapSession extends UniverseMapSession {
  /** Replaces the places (a new list from the server). A camera on a place that is gone returns to the whole map. */
  readonly setDescriptors: (descriptors: readonly SceneDescriptor[]) => void;
  /** Ends the session: the places and the geometry go. */
  readonly end: () => void;
}

export interface VisitMapOptions {
  /** Rereads the visit (the screen's Refresh). */
  readonly refresh: () => Promise<void>;
}

export function createVisitMapSession(options: VisitMapOptions): VisitMapSession {
  let places: readonly SceneDescriptor[] = [];
  let foreground = false;
  let ended = false;
  let detail: 'full' | 'low' = 'full';
  let reducedMotion = true;
  const history = createCameraHistory(DRAW_LIMITS.history);
  const geometryCache = createGeometryCache(DRAW_LIMITS.cache);
  const listeners = new Set<() => void>();
  let state: UniverseViewState = {
    read: { status: 'ready', active: true },
    frame: { ...INITIAL_FRAME },
    focusId: null,
    landed: false,
    overlay: null,
    detail,
    reducedMotion,
    historyDepth: 0,
    regionPreview: { status: 'idle' },
    lately: false,
    dust: NO_DUST,
    lastPlace: undefined,
    absent: false,
    selectedId: null,
    youWereHere: null,
  };
  const publish = (patch: Partial<UniverseViewState>) => {
    state = { ...state, ...patch, historyDepth: history.size() };
    for (const listener of [...listeners]) listener();
  };
  const live = () => !ended && foreground;
  const placeList = (): readonly UniversePlace[] =>
    ended
      ? []
      : places.map((place) => ({
          id: place.objectId,
          parentId: place.parentId,
          kind: place.kind,
          label: place.label,
          truthStatus: place.truthStatus,
        }));
  const exists = (id: string) => places.some((place) => place.objectId === id);
  const here = (): CameraEntry => ({ frame: { ...state.frame }, focusId: state.focusId });
  const withFrame = (frame: UniverseFrame) => publish({ frame });

  function focus(id: string): boolean {
    if (!live() || !exists(id)) return false;
    const current = places.find((place) => place.objectId === state.focusId);
    const next = places.find((place) => place.objectId === id)!;
    // Moving between planets of one system replaces the view instead of stacking Back steps.
    const sibling = next.kind === 'planet' && current?.kind === 'planet' && current.parentId === next.parentId;
    if (!sibling) history.push(here());
    publish({ focusId: id, frame: { ...INITIAL_FRAME }, overlay: null, selectedId: null, notice: undefined });
    return true;
  }

  function back(): boolean {
    if (!live()) return false;
    if (state.overlay) {
      publish({ overlay: null });
      return true;
    }
    if (state.selectedId) {
      publish({ selectedId: null });
      return true;
    }
    const entry = history.pop();
    if (!entry) return false;
    const stillThere = entry.focusId === null || exists(entry.focusId);
    publish(
      stillThere
        ? { frame: entry.frame, focusId: entry.focusId, overlay: null, notice: undefined }
        : { frame: { ...INITIAL_FRAME }, focusId: null, overlay: null, notice: 'place_unavailable' },
    );
    return true;
  }

  function up(): boolean {
    if (!live()) return false;
    const parentId = places.find((place) => place.objectId === state.focusId)?.parentId;
    const parent = places.find((place) => place.objectId === parentId && place.kind !== 'star');
    history.push(here());
    publish({ focusId: parent?.objectId ?? null, frame: { ...INITIAL_FRAME }, overlay: null, selectedId: null });
    return true;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (ended) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    places: placeList,
    descriptors: () => (ended ? [] : places),
    focus,
    back,
    canBack: () => live() && (history.size() > 0 || state.overlay !== null || state.selectedId !== null),
    setForeground(value) {
      foreground = value;
    },
    configure(next) {
      if (!live() || (next.detail === detail && next.reducedMotion === reducedMotion)) return;
      detail = next.detail;
      reducedMotion = next.reducedMotion;
      geometryCache.clear();
      publish({ detail, reducedMotion });
    },
    // Simple drawing is this screen's own choice while it is open; a visit remembers nothing on the device.
    setSimple(simple) {
      if (!live()) return;
      detail = simple ? 'low' : 'full';
      geometryCache.clear();
      publish({ detail });
    },
    showOverlay(overlay) {
      // The place card belongs to regions, which a visitor is never shown.
      if (!live() || overlay === 'place') return;
      publish({ overlay, selectedId: null });
    },
    refreshRegionPreview() {},
    openRegion: () => false,
    camera(frame) {
      if (live()) withFrame(boundedFrame(frame));
    },
    fit() {
      if (live()) withFrame({ ...INITIAL_FRAME });
    },
    setLately() {},
    select(id) {
      if (!live() || (id !== null && !exists(id))) return;
      publish({ selectedId: id });
    },
    up,
    escape() {
      if (!live()) return false;
      if (state.overlay || state.selectedId) return back();
      return state.focusId !== null && up();
    },
    focusLast: () => false,
    // A friend's planets turn but never land: a visit shows only what the friend shares, and regions are never shared.
    land: () => false,
    refresh: () => (live() ? options.refresh() : Promise.resolve()),
    travel: () => false,
    geometry(object, low = false): SceneGeometry | undefined {
      // Only a place of the current list, drawn while the screen is open: a held reference to a place
      // that was withdrawn since cannot be drawn again.
      if (!live() || !places.includes(object)) return undefined;
      return geometryCache.get(object, { detail: low ? 'low' : detail, reducedMotion });
    },
    cacheSize: () => geometryCache.size(),
    setDescriptors(next) {
      if (ended) return;
      places = next;
      geometryCache.clear();
      const stale = state.focusId !== null && !exists(state.focusId);
      if (stale) history.clear();
      publish({
        ...(stale
          ? { focusId: null, frame: { ...INITIAL_FRAME }, overlay: null, notice: 'place_unavailable' as const }
          : {}),
        ...(state.selectedId !== null && !exists(state.selectedId) ? { selectedId: null } : {}),
      });
    },
    end() {
      if (ended) return;
      ended = true;
      places = [];
      history.clear();
      geometryCache.clear();
      listeners.clear();
      state = { ...state, read: { status: 'ended', active: false }, focusId: null, selectedId: null, overlay: null };
    },
  };
}
