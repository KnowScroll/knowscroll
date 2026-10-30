import {
  createRegionPreviewSession,
  createFormationPresentationSession,
  createUniverseSceneSession,
  type AvailableRegionPreview,
  type RegionPreviewState,
  type AccountScope,
  type UniverseSceneState,
} from '@knowscroll/client-core';
import { SCENE_LOOK_VERSION, WORLD_GENERATOR_VERSION, type SceneClientCapabilities } from '@knowscroll/contracts';
import type { SceneDescriptor, SceneGeometry } from '@knowscroll/scene-core';
import { boundedFrame, DRAW_LIMITS, INITIAL_FRAME, returnLocator, type UniverseFrame } from './universe-camera';
import { ZOOM_LIMITS } from './space/camera-rig';
import { createCameraHistory, type CameraEntry } from './universe-camera-history';
import { createDeviceMemory } from './universe-device-memory';
import { clearHereMarker, readHereMarker, writeHereMarker } from './universe-here-marker';
import { createDustReader, NO_DUST, type DustState } from './universe-dust';
import { createGeometryCache } from './universe-geometry-cache';
import type { LastPlace } from './universe-memory';
import { cameraStillValid, descriptorsOf, placesOf, regionTargetOf, type UniversePlace } from './universe-places';
import { newCommandId } from '../../platform/command-id';
import { ENCOUNTER_CAPABILITIES } from '../encounter/capabilities';
import { encounterSessionFor } from '../encounter/use-encounter-session';

export type { UniversePlace } from './universe-places';
export type { DustState } from './universe-dust';

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
  /** U04: the region the person left through its card's Open, private to this device, until they choose it again. */
  readonly youWereHere: string | null;
}
export function sceneCapabilities(detail: 'full' | 'low', reducedMotion: boolean): SceneClientCapabilities {
  return {
    version: 'scene-client.v1',
    descriptors: ['scene-descriptor.v1'],
    chunks: ['scene-chunk.v1'],
    manifests: ['scene-manifest.v1'],
    generators: ['silhouette.v1', WORLD_GENERATOR_VERSION],
    families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
    // The space views draw type, rings, moon and haze from the server's looks (D-102); the client never makes its own.
    // Keys stay in the schema's order: the session compares a read's capabilities with what it sent by their JSON.
    looks: [SCENE_LOOK_VERSION],
    detail,
    reducedMotion,
  };
}
/** Focus/camera/preview stay read-only; deliberate Open delegates to the real encounter engine. */
export function createUniverseViewSession(scope: AccountScope, newId = newCommandId, now = Date.now) {
  let detail: 'full' | 'low' = 'full',
    reducedMotion = true,
    foreground = false,
    ended = false,
    notificationDepth = 0;
  const live = () => !ended && scope.active;
  let core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
  const history = createCameraHistory(DRAW_LIMITS.history);
  const geometryCache = createGeometryCache(DRAW_LIMITS.cache);
  const preview = createRegionPreviewSession({ scope, capabilities: ENCOUNTER_CAPABILITIES, newReadId: newId });
  const formation = createFormationPresentationSession({
    scope,
    newId,
    projection: () => core.getState(),
    capabilities: () => sceneCapabilities(detail, reducedMotion),
  });
  const memory = createDeviceMemory(scope, now, live);
  let returnPoint: { camera: CameraEntry; history: CameraEntry[] } | undefined;
  const listeners = new Set<() => void>();
  let state: UniverseViewState = {
    read: core.getState(),
    frame: { ...INITIAL_FRAME },
    focusId: null,
    overlay: null,
    detail,
    reducedMotion,
    historyDepth: 0,
    regionPreview: preview.getState(),
    lately: memory.lately,
    dust: NO_DUST,
    lastPlace: memory.lastPlace,
    absent: false,
    selectedId: null,
    youWereHere: readHereMarker(scope, now()) ?? null,
  };
  const publish = (patch: Partial<UniverseViewState>) => {
    state = { ...state, ...patch, historyDepth: history.size() };
    if (notificationDepth) return;
    for (const listener of [...listeners]) listener();
  };
  memory.keep(() => state);
  const dust = createDustReader({ scope, live, current: () => state.dust, publish: (next) => publish({ dust: next }) });
  const formationOff = formation.subscribe(() => publish({}));
  const previewOff = preview.subscribe(() => publish({ regionPreview: preview.getState() }));
  const cancelPreview = () => preview.cancel();

  const descriptors = () => (live() ? descriptorsOf(state.read) : []);
  const places = (): readonly UniversePlace[] => (live() ? placesOf(state.read) : []);
  const validCamera = (entry: CameraEntry) => cameraStillValid(state.read, entry);
  const readPreview = () => {
    cancelPreview();
    const selected = regionTargetOf(state.read, state.focusId);
    if (live() && foreground && state.overlay === 'place' && selected)
      void preview.read(selected, {
        personalWatermark: state.read.geography!.personalWatermark,
        geographyRevision: selected.expectedGeographyRevision,
      });
  };
  /** A saved camera that no longer exists sends the person to the whole map, and says so. */
  const publishCamera = (entry: CameraEntry) => {
    if (validCamera(entry)) publish({ ...entry, overlay: null, notice: undefined });
    else {
      history.clear();
      publish({
        focusId: null,
        frame: { ...INITIAL_FRAME },
        locator: undefined,
        overlay: null,
        notice: 'place_unavailable',
      });
    }
  };

  /** The first map restores the camera, Lately and the ship (or, after a long absence, frames everything). */
  const restoreMemory = () => {
    const restored = memory.restore((id) => places().some((place) => place.id === id));
    if (!restored) return;
    publish({
      ...(restored.camera ? { focusId: restored.camera.focusId, frame: restored.camera.frame } : {}),
      lastPlace: restored.lastPlace,
      absent: restored.absent,
    });
  };
  const readChanged = () => {
    const read = core.getState(),
      hadSnapshot = Boolean(state.read.snapshot);
    if (read.status === 'ended' || read.reason === 'authority') {
      formation.dispose();
      history.clear();
      returnPoint = undefined;
      cancelPreview();
      geometryCache.clear();
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
      history.clear();
      publish({ focusId: null, locator: undefined, overlay: null, notice: 'place_unavailable' });
    }
    if (!hadSnapshot && read.snapshot) restoreMemory();
    if (read.geography) dust.seeGeography(read.geography.geography.revision);
  };
  let unsubscribe = core.subscribe(readChanged);
  const end = () => {
    if (ended) return;
    ended = true;
    foreground = false;
    history.clear();
    memory.stop();
    dust.stop();
    geometryCache.clear();
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
      dust: NO_DUST,
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
  /** "Deployment · Inference & serving": the words of the chip an encounter opened from a region carries (U04). */
  const regionChipOf = (regionId: string): string => {
    const all = places();
    const region = all.find((place) => place.id === regionId);
    const planet = all.find((place) => place.id === region?.parentId);
    return [region?.label, planet?.label].filter((part) => part !== undefined && part !== '').join(' · ');
  };
  const here = (): CameraEntry => ({ frame: { ...state.frame }, focusId: state.focusId, locator: state.locator });
  const focus = (id: string) => {
    if (!live() || !foreground || !places().some((p) => p.id === id)) return false;
    cancelPreview();
    formation.skip();
    const all = descriptors(),
      object = all.find((o) => o.objectId === id),
      current = all.find((o) => o.objectId === state.focusId);
    // Moving between regions of one planet replaces the view instead of stacking Back steps.
    const sibling = object?.kind === 'region' && current?.kind === 'region' && current.parentId === object.parentId;
    if (!sibling) history.push(here());
    const chunk = state.read.snapshot?.chunks.find((c) => c.objects.some((o) => o.objectId === id));
    const place = places().find((p) => p.id === id)!;
    const frame = { ...INITIAL_FRAME };
    // Choosing the place again is what the marker was waiting for.
    if (state.youWereHere === id) clearHereMarker(scope);
    publish({
      focusId: id,
      notice: undefined,
      frame,
      overlay: null,
      selectedId: null,
      absent: false,
      youWereHere: state.youWereHere === id ? null : state.youWereHere,
      lastPlace: { id, label: place.label, kind: place.kind },
      locator: chunk ? returnLocator(chunk.chunkId, id, frame) : undefined,
    });
    memory.saveNow();
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
    publishCamera(entry);
    memory.saveNow();
    return true;
  };
  const withFrame = (frame: UniverseFrame) => {
    publish({
      frame,
      locator: state.locator ? returnLocator(state.locator.chunkId, state.locator.objectId!, frame) : undefined,
    });
    memory.saveSoon();
  };
  /** The route a Route target stands for: from a planet it ends at, to its other end; from the system, to its `to` end. */
  const routeDestination = (routeId: string): string | undefined => {
    const route = state.read.snapshot?.chunks.flatMap((c) => c.routes).find((r) => r.id === routeId);
    if (!route) return undefined;
    if (route.fromObjectId === state.focusId) return route.toObjectId;
    if (route.toObjectId === state.focusId) return route.fromObjectId;
    const from = descriptors().find((o) => o.objectId === route.fromObjectId);
    return from?.parentId === state.focusId ? route.toObjectId : undefined;
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
      (Boolean(formation.getState().fact) || history.size() > 0 || state.overlay !== null || state.selectedId !== null),
    setForeground(value: boolean) {
      if (!live()) return;
      foreground = value;
      formation.setForeground(value && state.overlay === null);
      if (value) {
        core.resume();
        dust.refreshIfStarted();
      } else {
        cancelPreview();
        core.pause();
        memory.saveNow();
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
      geometryCache.clear();
      core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
      unsubscribe = core.subscribe(readChanged);
      publish({ detail, reducedMotion, read: core.getState(), overlay: null });
      if (foreground) core.start();
      formation.setForeground(foreground);
    },
    showOverlay,
    refreshRegionPreview: readPreview,
    openRegion(displayed: AvailableRegionPreview, onReturn: () => void) {
      const selected = regionTargetOf(state.read, state.focusId);
      if (
        !live() ||
        !foreground ||
        state.overlay !== 'place' ||
        preview.getState().preview !== displayed ||
        !selected ||
        JSON.stringify(selected) !== JSON.stringify(displayed.target)
      )
        return false;
      const saved = { camera: here(), history: history.snapshot() };
      const accepted = encounterSessionFor(scope).openRegion(displayed, regionChipOf(selected.regionId), () => {
        if (!live() || returnPoint !== saved) return;
        history.restore(saved.history);
        publishCamera(saved.camera);
        onReturn();
      });
      if (!accepted) return false;
      returnPoint = saved;
      cancelPreview();
      writeHereMarker(scope, selected.regionId, now());
      publish({ overlay: null, youWereHere: selected.regionId });
      return true;
    },
    camera(frame: UniverseFrame) {
      if (!live() || !foreground) return;
      // The 3D views stop where their camera does, so the next pinch or key press moves it at once.
      const kind = places().find((place) => place.id === state.focusId)?.kind;
      const limits =
        kind === undefined
          ? ZOOM_LIMITS.universe
          : kind === 'system' || kind === 'star'
            ? ZOOM_LIMITS.system
            : undefined;
      const bounded = boundedFrame(frame);
      withFrame(
        limits === undefined
          ? bounded
          : { ...bounded, scale: Math.min(limits.max, Math.max(limits.min, bounded.scale)) },
      );
    },
    /** Frames the current view as the screen first draws it. */
    fit() {
      if (live() && foreground) withFrame({ ...INITIAL_FRAME });
    },
    setLately(lately: boolean) {
      if (!live() || lately === state.lately) return;
      publish({ lately });
      memory.saveNow();
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
      history.push(here());
      publish({
        focusId: parent?.id ?? null,
        frame: { ...INITIAL_FRAME },
        locator: undefined,
        overlay: null,
        selectedId: null,
        notice: undefined,
      });
      memory.saveNow();
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
    /** Follows a Cartographer route between two planets of one system, from either end or from the system. */
    travel(routeId: string) {
      if (!live() || !foreground || state.read.status !== 'ready') return false;
      const destination = routeDestination(routeId);
      return destination !== undefined && focus(destination);
    },
    geometry(object: SceneDescriptor, low = false): SceneGeometry | undefined {
      // A retained render callback is not authority: accept only the current generation's
      // parsed descriptor reference while this screen is foregrounded. This also fences
      // descriptors held across authority refusal and capability-session replacement.
      if (!live() || !foreground || !descriptors().includes(object)) return undefined;
      return geometryCache.get(object, { detail: low ? 'low' : detail, reducedMotion });
    },
    cacheSize: () => geometryCache.size(),
  };
}
export type UniverseViewSession = ReturnType<typeof createUniverseViewSession>;
/**
 * What the map is drawn from. A friend's universe (U06) is drawn and navigated the same way as your
 * own, but has no formation story, so that part is not something the drawing needs.
 */
export type UniverseMapSession = Omit<UniverseViewSession, 'formation' | 'dismissFormation'>;
