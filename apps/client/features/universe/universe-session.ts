import {
  createRegionPreviewSession,
  createFormationPresentationSession,
  createUniverseSceneSession,
  type AvailableRegionPreview,
  type AccountScope,
  type UniverseSceneState,
} from '@knowscroll/client-core';
import {
  SCENE_LOOK_VERSION,
  SCENE_SKY_VERSION,
  WORLD_GENERATOR_VERSION,
  type SceneClientCapabilities,
} from '@knowscroll/contracts';
import type { SceneDescriptor, SceneGeometry } from '@knowscroll/scene-core';
import { boundedFrame, DRAW_LIMITS, INITIAL_FRAME, returnLocator, type UniverseFrame } from './universe-camera';
import { PLANET_ZOOM } from './planet/map-camera';
import { ZOOM_LIMITS } from './space/camera-rig';
import { withTransitionGate } from './animation/transition-gate';
import { createCameraHistory, type CameraEntry } from './universe-camera-history';
import { createDeviceMemory } from './universe-device-memory';
import { clearHereMarker, readHereMarker, writeHereMarker } from './universe-here-marker';
import { readSeenLandmark, writeSeenLandmark } from './collection/landmark-seen';
import { createCollectionReader, NO_COLLECTION_STATE } from './universe-collection-reader';
import { createDustReader, NO_DUST } from './universe-dust';
import { createGeometryCache } from './universe-geometry-cache';
import type { UniverseViewSession, UniverseViewState } from './universe-map-session';
import {
  cameraStillValid,
  chunkOfObject,
  descriptorsOf,
  placesOf,
  regionTargetOf,
  routesOf,
  systemOf,
  type UniversePlace,
} from './universe-places';
import { newCommandId } from '../../platform/command-id';
import { ENCOUNTER_CAPABILITIES } from '../encounter/capabilities';
import { encounterSessionFor } from '../encounter/use-encounter-session';

export type { UniversePlace } from './universe-places';
export type { UniverseMapSession, UniverseViewSession, UniverseViewState } from './universe-map-session';

/** The farthest in the whole-universe view may ever zoom, whatever the map's extent. */
const ZOOM_CEILING = 400;
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
    // The map is read as its sky and one system at a time (D-417); a map of up to 24 systems is loaded whole.
    sky: [SCENE_SKY_VERSION],
    detail,
    reducedMotion,
  };
}
/** Focus/camera/preview stay read-only; deliberate Open delegates to the real encounter engine. */
export function createUniverseViewSession(
  scope: AccountScope,
  newId = newCommandId,
  now = Date.now,
): UniverseViewSession {
  let ended = false;
  const live = () => !ended && scope.active;
  const memory = createDeviceMemory(scope, now, live);
  // Simple drawing is remembered on this device (D-111): the tab opens as the plain lists again.
  let detail: 'full' | 'low' = memory.simple ? 'low' : 'full',
    reducedMotion = true,
    foreground = false,
    notificationDepth = 0;
  let core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
  const history = createCameraHistory(DRAW_LIMITS.history);
  const geometryCache = createGeometryCache(DRAW_LIMITS.cache);
  const preview = createRegionPreviewSession({
    scope,
    capabilities: ENCOUNTER_CAPABILITIES,
    newReadId: newId,
    alternate: true,
  });
  const formation = createFormationPresentationSession({
    scope,
    newId,
    projection: () => core.getState(),
    capabilities: () => sceneCapabilities(detail, reducedMotion),
  });
  let returnPoint: { camera: CameraEntry; history: CameraEntry[] } | undefined;
  let universeZoomMax: number = ZOOM_LIMITS.universe.max;
  const listeners = new Set<() => void>();
  let state: UniverseViewState = {
    read: core.getState(),
    frame: { ...INITIAL_FRAME },
    focusId: null,
    landed: false,
    overlay: null,
    detail,
    reducedMotion,
    historyDepth: 0,
    regionPreview: preview.getState(),
    lately: memory.lately,
    dust: NO_DUST,
    collection: NO_COLLECTION_STATE,
    lastPlace: memory.lastPlace,
    absent: false,
    selectedId: null,
    youWereHere: readHereMarker(scope, now()) ?? null,
    seenLandmark: readSeenLandmark(scope) ?? null,
    findsFor: null,
  };
  const publish = (patch: Partial<UniverseViewState>) => {
    state = { ...state, ...patch, historyDepth: history.size() };
    applyInterest();
    if (notificationDepth) return;
    for (const listener of [...listeners]) listener();
  };
  // The systems whose planets must be in hand (D-417): the ones the drawing shows in detail, the one the camera is in
  // or has picked, the ones Back would return to, the ones a formation story is about, and the one a list or the dial
  // is open on. A map of up to 24 systems loads whole, so this only matters beyond that.
  const interest = { detail: [] as readonly string[], keep: [] as readonly string[] };
  /** The system of a place the camera has been at, remembered while it was loaded, so Back can find it again. */
  const placeSystems = new Map<string, string>();
  let wantedKey = '';
  function applyInterest() {
    if (!live()) return;
    const wanted = new Set<string>([...interest.detail, ...interest.keep]);
    const add = (placeId: string | null | undefined) => {
      if (!placeId) return;
      const system = systemOf(state.read, placeId) ?? placeSystems.get(placeId);
      if (system === undefined) return;
      wanted.add(system);
      if (!placeSystems.has(placeId)) {
        placeSystems.set(placeId, system);
        if (placeSystems.size > 64) placeSystems.delete(placeSystems.keys().next().value!);
      }
    };
    add(state.focusId);
    add(state.selectedId);
    add(state.lastPlace?.id);
    for (const entry of history.snapshot()) add(entry.focusId);
    if (returnPoint) add(returnPoint.camera.focusId);
    const fact = formation.getState().fact;
    if (fact)
      for (const target of fact.targets)
        wanted.add(
          target.kind === 'system' ? target.objectId : (systemOf(state.read, target.parentId) ?? target.parentId),
        );
    const key = [...wanted].sort().join(',');
    if (key === wantedKey) return;
    wantedKey = key;
    core.want([...wanted]);
  }
  memory.keep(() => ({ ...state, simple: state.detail === 'low' }));
  const dust = createDustReader({ scope, live, current: () => state.dust, publish: (next) => publish({ dust: next }) });
  const collection = createCollectionReader({
    scope,
    live,
    current: () => state.collection,
    publish: (next) => publish({ collection: next }),
  });
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
        landed: false,
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
      ...(restored.camera
        ? { focusId: restored.camera.focusId, frame: restored.camera.frame, landed: restored.camera.landed }
        : {}),
      lastPlace: restored.lastPlace,
      absent: restored.absent,
    });
  };
  // A drawing preference changes capabilities inside the same authority. Keep the current map
  // while its replacement loads, so Settings and its focus target are never unmounted mid-action.
  type KeptMap = Pick<UniverseSceneState, 'snapshot' | 'sky' | 'loadedSystemIds' | 'geography'>;
  let drawingSnapshot: KeptMap | undefined;
  const keptOf = (read: UniverseSceneState): KeptMap | undefined =>
    read.snapshot
      ? {
          snapshot: read.snapshot,
          ...(read.sky ? { sky: read.sky } : {}),
          ...(read.loadedSystemIds ? { loadedSystemIds: read.loadedSystemIds } : {}),
          ...(read.geography ? { geography: read.geography } : {}),
        }
      : undefined;
  let coveredRegion: string | null = null;
  // The planet's map (the new look's). Only its screen opens it, so with the switch off none of this is ever set.
  // `mapOrigin`: the camera the map was opened from, which Back returns to. `mapPushed`: the region's own map in front
  // of it (`state.mapBehind`) was reached by a step that added a Back step (a sibling region adds none). `coveredMap`:
  // Search or Browse was opened over it, and Back returns to it.
  let mapOrigin: CameraEntry | null = null;
  let mapPushed = false;
  let coveredMap = false;
  const readChanged = () => {
    const current = core.getState();
    const read =
      drawingSnapshot && (current.status === 'idle' || current.status === 'loading')
        ? { ...current, ...drawingSnapshot }
        : current;
    if (current.status !== 'idle' && current.status !== 'loading') drawingSnapshot = undefined;
    const hadSnapshot = Boolean(state.read.snapshot);
    if (read.status === 'ended' || read.reason === 'authority') {
      drawingSnapshot = undefined;
      coveredRegion = null;
      mapOrigin = null;
      mapPushed = false;
      coveredMap = false;
      formation.dispose();
      history.clear();
      returnPoint = undefined;
      cancelPreview();
      geometryCache.clear();
      collection.stop();
      publish({
        read,
        collection: NO_COLLECTION_STATE,
        frame: { ...INITIAL_FRAME },
        focusId: null,
        landed: false,
        locator: undefined,
        overlay: null,
        mapBehind: false,
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
      publish({ focusId: null, landed: false, locator: undefined, overlay: null, notice: 'place_unavailable' });
    }
    // The finds sheet belongs to a system on this map: once that system is gone the sheet closes instead of hiding.
    if (state.overlay === 'finds' && !places().some((p) => p.id === state.findsFor && p.kind === 'system'))
      showOverlay(null);
    if (!hadSnapshot && read.snapshot) restoreMemory();
    if (read.geography) {
      dust.seeGeography(read.geography.geography.revision);
      collection.seeGeography(read.geography.geography.revision);
    }
  };
  let unsubscribe = core.subscribe(readChanged);
  const end = () => {
    if (ended) return;
    ended = true;
    drawingSnapshot = undefined;
    coveredRegion = null;
    mapOrigin = null;
    mapPushed = false;
    coveredMap = false;
    foreground = false;
    history.clear();
    memory.stop();
    dust.stop();
    collection.stop();
    geometryCache.clear();
    unsubscribe();
    core.dispose();
    publish({
      read: { status: 'ended', active: false },
      notice: undefined,
      frame: { ...INITIAL_FRAME },
      focusId: null,
      landed: false,
      locator: undefined,
      overlay: null,
      selectedId: null,
      dust: NO_DUST,
      collection: NO_COLLECTION_STATE,
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
  /** The planet's map opens over a landed planet or a region, and nowhere else. */
  const mapAllowed = (): boolean => {
    const focused = places().find((p) => p.id === state.focusId);
    return (focused?.kind === 'planet' && state.landed) || focused?.kind === 'region';
  };
  /** Runs `change` as one step to the listeners: browser Back must never see the overlay empty between its two publishes. */
  const asOneStep = <T>(change: () => T): T => {
    notificationDepth++;
    try {
      return change();
    } finally {
      notificationDepth--;
      if (!notificationDepth) publish({});
    }
  };
  const showOverlay = (overlay: UniverseViewState['overlay']) => {
    if (!live() || !foreground) return;
    const focused = places().find((p) => p.id === state.focusId);
    if (overlay === 'place' && focused?.kind !== 'region') return;
    if (overlay === 'planet-map' && !mapAllowed()) return;
    if (overlay === 'planet-map' && (state.overlay === null || state.overlay === 'place')) mapOrigin = here();
    if (overlay === 'outline' || overlay === 'search' || overlay === 'settings') {
      if (state.overlay === 'place') coveredRegion = state.focusId;
      else if (state.overlay === null) coveredRegion = null;
    } else coveredRegion = null;
    if (overlay === 'outline' || overlay === 'search' || overlay === 'settings') {
      if (state.overlay === 'planet-map') coveredMap = true;
      else if (state.overlay === null || state.overlay === 'place') coveredMap = false;
    } else coveredMap = false;
    cancelPreview();
    // Navigation and display surfaces must not dismiss the place picked on the map.
    publish({ overlay, ...(overlay === 'place' ? { selectedId: null } : {}) });
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
  const here = (): CameraEntry => ({
    frame: { ...state.frame },
    focusId: state.focusId,
    locator: state.locator,
    landed: state.landed,
  });
  /** Flies to a place. `land` on a planet goes straight to its map (Land on the desktop card, the orbit dial). */
  const focusPlace = (id: string, options?: { readonly land?: boolean }) => {
    if (!live() || !foreground || !places().some((p) => p.id === id)) return false;
    cancelPreview();
    formation.skip();
    const all = descriptors(),
      object = all.find((o) => o.objectId === id),
      current = all.find((o) => o.objectId === state.focusId);
    // Moving between regions of one planet replaces the view instead of stacking Back steps.
    const sibling = object?.kind === 'region' && current?.kind === 'region' && current.parentId === object.parentId;
    if (!sibling) history.push(here());
    // Chosen on the planet's map: Back returns to it, popping the step pushed here (a sibling region pushed none).
    const mapBehind = state.overlay === 'planet-map';
    mapPushed = mapBehind && !sibling;
    const chunk = chunkOfObject(state.read, id);
    const place = places().find((p) => p.id === id)!;
    const frame = { ...INITIAL_FRAME };
    // Choosing the place again is what the marker was waiting for.
    if (state.youWereHere === id) clearHereMarker(scope);
    publish({
      focusId: id,
      // A planet opens as its globe unless asked to land; a region is only ever chosen on the map.
      landed: place.kind === 'region' || (place.kind === 'planet' && options?.land === true),
      notice: undefined,
      frame,
      overlay: null,
      mapBehind,
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
  /** Flies to a place. From the planet's map its two publishes (the camera, then the region's map) reach the listeners as one. */
  const focus = (id: string, options?: { readonly land?: boolean }) =>
    state.overlay === 'planet-map' ? asOneStep(() => focusPlace(id, options)) : focusPlace(id, options);
  /** The camera on a region's planet, landed, at planet level: where the person comes back to from an encounter. */
  const planetMapCamera = (regionId: string): CameraEntry => {
    const planetId = places().find((place) => place.id === regionId)?.parentId ?? null;
    const frame = { ...INITIAL_FRAME };
    const chunk = planetId ? chunkOfObject(state.read, planetId) : undefined;
    return {
      frame,
      focusId: planetId,
      landed: true,
      locator: chunk && planetId ? returnLocator(chunk.chunkId, planetId, frame) : undefined,
    };
  };
  const back = () => {
    if (!live() || !foreground) return false;
    if (formation.getState().fact) {
      formation.skip();
      return true;
    }
    if (state.overlay) {
      // The region's map reached from the planet's map: back to the planet's map, and the camera it was opened from.
      if (state.overlay === 'place' && state.mapBehind && mapOrigin !== null) {
        const origin = mapOrigin;
        asOneStep(() => {
          cancelPreview();
          if (mapPushed) history.pop();
          mapPushed = false;
          publishCamera(origin);
          publish({ mapBehind: false });
          showOverlay('planet-map');
          memory.saveNow();
        });
        return true;
      }
      if (coveredRegion !== null && state.focusId === coveredRegion && state.overlay !== 'place') {
        showOverlay('place');
        return true;
      }
      if (coveredMap && state.overlay !== 'planet-map' && mapAllowed()) {
        showOverlay('planet-map');
        return true;
      }
      cancelPreview();
      coveredMap = false;
      publish({ overlay: null });
      // As Close does: with nothing over the map, a new place may present itself again.
      formation.setForeground(true);
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
    const route = routesOf(state.read).find((r) => r.id === routeId);
    if (!route) return undefined;
    if (route.fromObjectId === state.focusId) return route.toObjectId;
    if (route.toObjectId === state.focusId) return route.fromObjectId;
    const from = descriptors().find((o) => o.objectId === route.fromObjectId);
    return from?.parentId === state.focusId ? route.toObjectId : undefined;
  };

  /**
   * The Back pill of a system, planet or region: one step up the hierarchy (system to the whole
   * map, planet to its system, region to its planet). Browser and hardware Back keep following
   * the camera history instead, so both lead somewhere the person has been.
   */
  const up = () => {
    if (!live() || !foreground) return false;
    const all = places();
    const place = all.find((candidate) => candidate.id === state.focusId);
    const parentId = place?.parentId;
    const parent = all.find((candidate) => candidate.id === parentId && candidate.kind !== 'star');
    cancelPreview();
    formation.skip();
    history.push(here());
    // A region steps up to its planet's map, where the person was; everything else to its parent.
    publish({
      focusId: parent?.id ?? null,
      landed: place?.kind === 'region' && parent !== undefined,
      frame: { ...INITIAL_FRAME },
      locator: undefined,
      overlay: null,
      selectedId: null,
      notice: undefined,
    });
    memory.saveNow();
    return true;
  };

  const configure = (next: { detail: 'full' | 'low'; reducedMotion: boolean }) => {
    if (!live() || (next.detail === detail && next.reducedMotion === reducedMotion)) return;
    cancelPreview();
    formation.setForeground(false);
    detail = next.detail;
    reducedMotion = next.reducedMotion;
    drawingSnapshot = keptOf(state.read);
    unsubscribe();
    core.dispose();
    geometryCache.clear();
    core = createUniverseSceneSession({ scope, capabilities: sceneCapabilities(detail, reducedMotion) });
    unsubscribe = core.subscribe(readChanged);
    // The new session has been asked for nothing yet.
    wantedKey = '';
    publish({
      detail,
      reducedMotion,
      read: { ...core.getState(), ...drawingSnapshot },
      overlay: state.overlay === 'settings' ? 'settings' : null,
    });
    if (foreground) core.start();
    formation.setForeground(foreground && state.overlay === null);
  };

  return withTransitionGate<Omit<UniverseViewSession, 'gate'>>({
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
        collection.refresh();
      } else {
        cancelPreview();
        core.pause();
        memory.saveNow();
      }
    },
    configure,
    /** Simple drawing on or off: the tab as two plain lists, remembered on this device (D-111). */
    setSimple(simple: boolean) {
      configure({ detail: simple ? 'low' : 'full', reducedMotion });
      memory.saveNow();
    },
    showOverlay,
    /**
     * Opens the sheet of a system's Reels and Scrolls (#697), from the map, the dial or the plain list. Only a system on
     * this map; it reads nothing here and records nothing (the sheet reads its list when it opens).
     */
    showFinds(systemId: string) {
      if (!live() || !foreground || !places().some((p) => p.id === systemId && p.kind === 'system')) return;
      cancelPreview();
      coveredRegion = null;
      publish({ overlay: 'finds', findsFor: systemId, selectedId: null });
      formation.setForeground(false);
    },
    /**
     * The person looked at or put away this landmark's large card (#694). Remembered on this device for the account,
     * so the card stays folded to its pill until a newer landmark is earned. Changes only what the card shows.
     */
    seeLandmark(landmarkId: string) {
      if (!live() || state.seenLandmark === landmarkId) return;
      writeSeenLandmark(scope, landmarkId);
      publish({ seenLandmark: landmarkId });
    },
    /**
     * The systems the drawing shows in detail now (D-417): their planets are loaded, and the ones it let go of may be
     * dropped. A map small enough to load whole ignores it.
     */
    setDetail(systemIds: readonly string[]) {
      if (!live()) return;
      interest.detail = systemIds;
      applyInterest();
    },
    /**
     * Systems a list or the dial is open on: their planets are in hand while they are listed, and let go of with `[]`.
     * A map that loads whole ignores it.
     */
    keepSystems(systemIds: readonly string[]) {
      if (!live()) return;
      interest.keep = systemIds;
      applyInterest();
    },
    refreshRegionPreview: readPreview,
    /** Opens the card's encounter, or with `alternate` the same explanation in its other format (#709). */
    openRegion(
      displayed: AvailableRegionPreview,
      onReturn: () => void,
      choice: 'encounter' | 'alternate' = 'encounter',
    ) {
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
      // Back from the encounter lands on the planet's map, at planet level, with the region marked (U04).
      const saved = { camera: planetMapCamera(selected.regionId), history: history.snapshot() };
      const accepted = encounterSessionFor(scope).openRegion(
        displayed,
        regionChipOf(selected.regionId),
        () => {
          if (!live() || returnPoint !== saved) return;
          history.restore(saved.history);
          publishCamera(saved.camera);
          onReturn();
        },
        choice,
      );
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
          ? { min: ZOOM_LIMITS.universe.min, max: universeZoomMax }
          : kind === 'system' || kind === 'star'
            ? ZOOM_LIMITS.system
            : PLANET_ZOOM;
      const bounded = boundedFrame(frame);
      withFrame({ ...bounded, scale: Math.min(limits.max, Math.max(limits.min, bounded.scale)) });
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
    up,
    /**
     * Escape: closes what is open (the story, a sheet, a card, a pick), and with nothing open steps
     * up one level, as the Back pill does. Nothing happens on the whole map.
     */
    escape() {
      if (!live() || !foreground) return false;
      if (formation.getState().fact || state.overlay || state.selectedId) return back();
      return state.focusId !== null && up();
    },
    /**
     * Lands on the planet in focus: its globe gives way to its map at planet level, nothing chosen.
     * A step of the camera only: it reads nothing and writes nothing.
     */
    land() {
      if (!live() || !foreground) return false;
      const focused = places().find((candidate) => candidate.id === state.focusId);
      if (focused?.kind !== 'planet' || state.landed) return false;
      cancelPreview();
      formation.skip();
      history.push(here());
      const frame = { ...INITIAL_FRAME };
      publish({
        landed: true,
        frame,
        overlay: null,
        selectedId: null,
        notice: undefined,
        locator: state.locator ? returnLocator(state.locator.chunkId, state.locator.objectId!, frame) : undefined,
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
    /**
     * How far the whole-universe view may zoom in (D-417): the drawing works it out from the extent of the map, because
     * a person must be able to come close to any system however many there are. Never below the default.
     */
    setZoomMax(max: number) {
      universeZoomMax = Number.isFinite(max)
        ? Math.max(ZOOM_LIMITS.universe.max, Math.min(ZOOM_CEILING, max))
        : ZOOM_LIMITS.universe.max;
    },
  });
}
