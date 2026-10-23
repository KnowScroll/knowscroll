import {
  createRegionPreviewSession,
  createFormationPresentationSession,
  createUniverseSceneSession,
  readDustCues,
  type AvailableRegionPreview,
  type DustCue,
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
import { boundedFrame, DRAW_LIMITS, INITIAL_FRAME, returnLocator, type UniverseFrame } from './universe-camera';
import { isAbsent, loadUniverseMemory, saveUniverseMemory, type LastPlace } from './universe-memory';
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
/** Dust cues of recent reading; a cue is not a place and is never a navigation target. */
export interface DustState {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly cues: readonly DustCue[];
}
export interface UniverseViewState extends CameraEntry {
  readonly read: UniverseSceneState;
  readonly overlay: 'outline' | 'place' | 'search' | null;
  readonly detail: 'full' | 'low';
  readonly reducedMotion: boolean;
  readonly notice?: 'place_unavailable';
  readonly historyDepth: number;
  readonly regionPreview: RegionPreviewState;
  /** The Lately lens: quiet places draw calm, and the list puts recent ones first. Per device. */
  readonly lately: boolean;
  readonly dust: DustState;
  /** Where the ship is parked: the last place flown to on this device. */
  readonly lastPlace: LastPlace | undefined;
  /** Away long enough that the camera starts framed on everything, with the ship at its last place. */
  readonly absent: boolean;
  /** A system picked on the map but not entered yet (second tap or Open enters it). */
  readonly selectedId: string | null;
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
export function createUniverseViewSession(scope: AccountScope, newId = newCommandId, now = Date.now) {
  let detail: 'full' | 'low' = 'full',
    reducedMotion = true,
    foreground = false,
    ended = false;
  let core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
  let history: CameraEntry[] = [];
  const preview = createRegionPreviewSession({ scope, capabilities: ENCOUNTER_CAPABILITIES, newReadId: newId });
  const formation = createFormationPresentationSession({
    scope,
    newId,
    projection: () => core.getState(),
    capabilities: () => sceneCapabilities(detail, reducedMotion),
  });
  let returnPoint: { camera: CameraEntry; history: CameraEntry[] } | undefined;
  const listeners = new Set<() => void>(),
    cache = new Map<string, { key: string; geometry: SceneGeometry }>();
  const remembered = loadUniverseMemory(scope);
  let state: UniverseViewState = {
    read: core.getState(),
    frame: { ...INITIAL_FRAME },
    focusId: null,
    overlay: null,
    detail,
    reducedMotion,
    historyDepth: 0,
    regionPreview: preview.getState(),
    lately: remembered?.lately ?? false,
    dust: { status: 'idle', cues: [] },
    lastPlace: remembered?.lastPlace,
    absent: false,
    selectedId: null,
  };
  let restored = false,
    dustGeography = -1,
    dustRead: AbortController | undefined,
    saveTimer: ReturnType<typeof setTimeout> | undefined;
  const live = () => !ended && scope.active;
  let notificationDepth = 0;
  const publish = (patch: Partial<UniverseViewState>) => {
    state = { ...state, ...patch, historyDepth: history.length };
    if (notificationDepth) return;
    for (const listener of [...listeners]) listener();
  };
  const formationOff = formation.subscribe(() => publish({}));
  const previewOff = preview.subscribe(() => publish({ regionPreview: preview.getState() }));
  const cancelPreview = () => preview.cancel();
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!live()) return;
    saveUniverseMemory(scope, {
      focusId: state.focusId,
      frame: state.frame,
      lately: state.lately,
      lastPlace: state.lastPlace,
      seenAt: now(),
    });
  };
  // Camera drags change the frame many times a second; one trailing write keeps the last one.
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  };
  const loadDust = async () => {
    if (!live()) return;
    dustRead?.abort();
    const controller = (dustRead = new AbortController());
    publish({ dust: { status: 'loading', cues: state.dust.cues } });
    const result = await readDustCues(scope, controller.signal);
    if (controller.signal.aborted || !live()) return;
    publish({
      dust:
        result.status === 'ready'
          ? { status: 'ready', cues: result.cues }
          : { status: 'unavailable', cues: state.dust.cues },
    });
  };
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
  /**
   * The first time a Scene is on hand, the camera returns to where this device left it. After a
   * long absence it starts framed on everything instead, with the ship parked at the last place.
   */
  const restoreMemory = () => {
    if (restored || !remembered) return;
    restored = true;
    const absent = isAbsent(remembered, now());
    const lastPlace = remembered.lastPlace && places().some((p) => p.id === remembered.lastPlace!.id) ? remembered.lastPlace : undefined;
    const camera: CameraEntry = {
      focusId: remembered.focusId,
      frame: remembered.frame,
      locator: undefined,
    };
    if (absent || !remembered.focusId || !validCamera(camera)) {
      publish({ lastPlace, absent: absent && lastPlace !== undefined });
      return;
    }
    publish({ ...camera, lastPlace });
  };
  const readChanged = () => {
    const read = core.getState(),
      hadSnapshot = Boolean(state.read.snapshot);
    if (read.status === 'ended' || read.reason === 'authority') {
      formation.dispose();
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
        selectedId: null,
      });
      return;
    }
    cancelPreview();
    publish({ read });
    formation.update();
    if (state.focusId && (read.snapshot || read.geography) && !validCamera(state)) {
      history = [];
      publish({ focusId: null, locator: undefined, overlay: null, notice: 'place_unavailable' });
    }
    if (!hadSnapshot && read.snapshot) restoreMemory();
    const revision = read.geography?.geography.revision ?? 0;
    if (read.geography && revision !== dustGeography) {
      dustGeography = revision;
      void loadDust();
    }
  };
  let unsubscribe = core.subscribe(readChanged);
  const end = () => {
    if (ended) return;
    ended = true;
    foreground = false;
    history = [];
    clearTimeout(saveTimer);
    dustRead?.abort();
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
      selectedId: null,
      dust: { status: 'idle', cues: [] },
    });
    previewOff();
    preview.dispose();
    formationOff();
    formation.dispose();
    returnPoint = undefined;
    state = { ...state, regionPreview: { status: 'ended' } };
    listeners.clear();
  };
  scope.onEnd?.(end);
  const showOverlay = (overlay: UniverseViewState['overlay']) => {
    if (!live() || !foreground) return;
    const focused = places().find((p) => p.id === state.focusId);
    if (overlay === 'place' && focused?.kind !== 'region') return;
    cancelPreview();
    publish({ overlay, selectedId: null });
    formation.setForeground(overlay === null);
    if (overlay === 'place') readPreview();
  };
  const focus = (id: string) => {
    if (!live() || !foreground || !places().some((p) => p.id === id)) return false;
    cancelPreview();
    formation.skip();
    const all = descriptors(),
      object = all.find((o) => o.objectId === id),
      current = all.find((o) => o.objectId === state.focusId);
    // Moving between regions of one planet replaces the view instead of stacking Back steps.
    const sibling = object?.kind === 'region' && current?.kind === 'region' && current.parentId === object.parentId;
    if (!sibling) {
      history.push({ frame: { ...state.frame }, focusId: state.focusId, locator: state.locator });
      if (history.length > DRAW_LIMITS.history) history.shift();
    }
    const chunk = state.read.snapshot?.chunks.find((c) => c.objects.some((o) => o.objectId === id));
    const place = places().find((p) => p.id === id)!;
    const frame = { ...INITIAL_FRAME };
    publish({
      focusId: id,
      notice: undefined,
      frame,
      overlay: null,
      selectedId: null,
      absent: false,
      lastPlace: { id, label: place.label, kind: place.kind },
      locator: chunk ? returnLocator(chunk.chunkId, id, frame) : undefined,
    });
    saveNow();
    // A region opens its card at once: choosing a pin is how a person lands on it (U04).
    if (place.kind === 'region') showOverlay('place');
    return true;
  };
  const back = () => {
    if (!live() || !foreground) return false;
    if (formation.getState().fact) {
      formation.skip();
      return true;
    }
    if (state.overlay) {
      cancelPreview();
      publish({ overlay: null });
      return true;
    }
    if (state.selectedId) {
      publish({ selectedId: null });
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
    saveNow();
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
    formation,
    dismissFormation(expected?: Parameters<typeof formation.dismiss>[0]) {
      if (!live() || !foreground) return;
      // Browser Back observes this view, not intermediate controller/preview callbacks.
      // Hiding the story and focusing its real target must not briefly remove its marker
      // (which would queue history.back before the new camera history was committed).
      notificationDepth++;
      try {
        const fact = formation.dismiss(expected);
        if (fact) focus(fact.sequence.kind === 'planet' ? fact.sequence.planetId : fact.targets[0]!.objectId);
      } finally {
        notificationDepth--;
        if (!notificationDepth) publish({});
      }
    },
    focus,
    back,
    canBack: () =>
      live() &&
      (Boolean(formation.getState().fact) || history.length > 0 || state.overlay !== null || state.selectedId !== null),
    setForeground(value: boolean) {
      if (!live()) return;
      foreground = value;
      formation.setForeground(value && state.overlay === null);
      if (value) {
        core.resume();
        if (dustGeography >= 0) void loadDust();
      } else {
        cancelPreview();
        core.pause();
        saveNow();
      }
    },
    configure(next: { detail: 'full' | 'low'; reducedMotion: boolean }) {
      if (!live() || (next.detail === detail && next.reducedMotion === reducedMotion)) return;
      cancelPreview();
      formation.setForeground(false);
      detail = next.detail;
      reducedMotion = next.reducedMotion;
      unsubscribe();
      core.dispose();
      cache.clear();
      core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
      unsubscribe = core.subscribe(readChanged);
      publish({ detail, reducedMotion, read: core.getState(), overlay: null });
      if (foreground) core.start();
      formation.setForeground(foreground);
    },
    showOverlay,
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
        saveSoon();
      }
    },
    /** Frames the current view as the screen first draws it. */
    fit() {
      if (live() && foreground) {
        const frame = { ...INITIAL_FRAME };
        publish({
          frame,
          locator: state.locator ? returnLocator(state.locator.chunkId, state.locator.objectId!, frame) : undefined,
        });
        saveSoon();
      }
    },
    setLately(lately: boolean) {
      if (!live() || lately === state.lately) return;
      publish({ lately });
      saveNow();
    },
    /** Picks a system on the map without entering it; a second tap or Open enters. */
    select(id: string | null) {
      if (!live() || !foreground) return;
      if (id !== null && !places().some((p) => p.id === id)) return;
      publish({ selectedId: id });
    },
    /**
     * The Back pill of a system, planet or region: one step up the hierarchy (system to the whole
     * map, planet to its system, region to its planet). Browser and hardware Back keep following
     * the camera history instead, so both lead somewhere the person has been.
     */
    up() {
      if (!live() || !foreground) return false;
      const all = places();
      const parentId = all.find((place) => place.id === state.focusId)?.parentId;
      const parent = all.find((place) => place.id === parentId && place.kind !== 'star');
      cancelPreview();
      formation.skip();
      history.push({ frame: { ...state.frame }, focusId: state.focusId, locator: state.locator });
      if (history.length > DRAW_LIMITS.history) history.shift();
      publish({
        focusId: parent?.id ?? null,
        frame: { ...INITIAL_FRAME },
        locator: undefined,
        overlay: null,
        selectedId: null,
        notice: undefined,
      });
      saveNow();
      return true;
    },
    /** Flies to the place the ship is parked at (`?focus=last`, "Return to …"). */
    focusLast() {
      const last = state.lastPlace;
      return last !== undefined && last.id !== state.focusId && focus(last.id);
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
