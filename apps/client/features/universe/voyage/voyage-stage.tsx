/**
 * The trial's stage: what the Universe screen draws, instead of the map's own stage, when this device tries the new look.
 * It lays the universe out as the map does, works out where the person is (`targetOf`) and which planet is drawn as one
 * world (`usePlanetSurface`), hands both to the controller, and puts the named buttons over the canvas. The camera, the
 * globe and the ship are the driver's (`voyage-driver.ts`); the gestures are the controller's.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Platform, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { chartWorld } from '@knowscroll/scene-core';
import { target } from '@knowscroll/design-tokens';
import { useFrameTimeRecorder } from '../frame-rate/frame-rate-readout';
import { paletteOf } from '../planet/planet-palette';
import { planPlanet } from '../planet/planet-plan';
import { useGlobeWorld } from '../planet/use-planet-world';
import { BodyTarget, LABEL_HEIGHT, labelWidth, MapLabel, type SceneProps } from '../scene-parts';
import { layOutUniverse, looksById, looksOfState } from '../space/space-model';
import type { SpaceAnchor, SpaceFailure } from '../space/space-surface';
import { CROWDED_TARGET, separateTargets } from '../space/separate-targets';
import { Unavailable } from '../space/space-stage';
import { SpaceView, type SpaceOverlayInfo } from '../space/space-view';
import { INITIAL_FRAME } from '../universe-camera';
import { placeLabels, type LabelRequest, type UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { climbOneStop, stopOf, type Stop } from './ladder';
import { createVoyageController, type VoyageInputs } from './voyage-controller';
import type { VoyagePlanet, VoyageTarget } from './voyage-driver';
import { labelPoints } from './world-texture';

/** What each stop names: the systems from afar, a star's planets, a planet's regions. Stations and dust where they are. */
const NAMED_AT: Readonly<Record<Stop, readonly SpaceAnchor['kind'][]>> = {
  universe: ['system', 'station', 'dust'],
  star: ['planet', 'station', 'dust'],
  planet: ['region'],
  ground: ['region'],
};

/** How far below a region's point its name sits, in points. */
const REGION_NAME_GAP = 14;
/** A body's name sits this far below its edge, in points ... */
const BODY_NAME_GAP = 6;
/** ... counted from at least this radius, so a tiny body's name still clears its button. */
const MIN_BODY_RADIUS = 6;

/** Where a view of the map is on the ladder: the stop, and the star, planet and region that make it. */
const targetOf = (view: UniverseView): VoyageTarget => {
  if (view.kind === 'universe') return { stop: 'universe', systemId: null, planetId: null, regionId: null };
  if (view.kind === 'system') return { stop: 'star', systemId: view.system.objectId, planetId: null, regionId: null };
  return {
    stop: stopOf(view),
    systemId: view.planet.parentId,
    planetId: view.planet.objectId,
    regionId: view.selectedRegion?.objectId ?? null,
  };
};

/**
 * On the web a browser handles some touches itself unless told not to: two fingers zoom the page, a drag down pulls
 * to refresh. Every touch on the stage is the Universe's (turn, pinch one stop, fly the ship), so it takes them all.
 * `touchAction` is a web style React Native's types do not list; React Native Web passes it through.
 */
const WEB_TOUCH = Platform.OS === 'web' ? ({ touchAction: 'none' } as unknown as ViewStyle) : null;

/**
 * The Universe's new look, tried behind a device switch: one camera that flies along the ladder (ground, planet, star,
 * the whole universe), a planet drawn as one world from orbit to the ground, and a ship the person can drag and let go
 * over a place to go there. It draws the map's own three.js scene through `SpaceView`, with a camera driver of its own
 * (`voyage-driver.ts`), and keeps the map's contract: every place is a named 48 px button over the canvas, and browsing
 * writes nothing.
 */
export function VoyageStage({
  session,
  state,
  index,
  size,
  view,
  onDust,
  stations,
  onStation,
  onUnavailable,
}: SceneProps & {
  readonly view: UniverseView;
  readonly onUnavailable: (reason: SpaceFailure) => void;
}) {
  const looks = looksOfState(state);
  const space = useMemo(
    () =>
      layOutUniverse({
        index,
        looks: looksById(looks),
        stations: stations ?? [],
        dustCueIds: state.dust.cues.map((cue) => cue.id),
        lately: state.lately,
        lastPlaceId: state.lastPlace?.id,
      }),
    [index, looks, stations, state.dust.cues, state.lately, state.lastPlace?.id],
  );
  const planet = usePlanetSurface(session, state, index, view);
  const inputs: VoyageInputs = {
    session,
    view,
    target: targetOf(view),
    size,
    turn: { x: state.frame.x, y: state.frame.y },
    planet,
    siblings:
      (view.kind === 'planet' ? index.planets.get(view.planet.parentId) : undefined)?.map(
        (sibling) => sibling.objectId,
      ) ?? [],
    reducedMotion: state.reducedMotion,
    universeFocus: space.universeFocus,
    systemFocus: space.systemFocus,
  };
  const [controller] = useState(() => createVoyageController(inputs));
  // Before `SpaceView`'s own effects: under reduced motion it redraws its one still frame there, and that frame must
  // already see where you are now.
  useLayoutEffect(() => controller.sync(inputs));
  useEffect(() => () => controller.dispose(), [controller]);
  const recordFrame = useFrameTimeRecorder();

  const systemId = inputs.target.systemId;
  const stop = inputs.target.stop;
  /** The place the camera is at: its name wins a crowded spot. */
  const focusId = inputs.target.regionId ?? inputs.target.planetId ?? inputs.target.systemId;
  // A new camera object makes `SpaceView` draw again: under reduced motion there is no loop, so every change of where
  // you are, of what you turned or of the planet's world must be one. `redraw` only changes the camera's identity when
  // any of those does; the driver does not read it.
  const redraw = `${inputs.target.stop}|${inputs.target.planetId ?? ''}|${inputs.target.regionId ?? ''}|${planet?.key ?? ''}|${String(inputs.turn.x)},${String(inputs.turn.y)}`;
  const camera = useMemo(
    () => ({
      focus: (systemId === null ? undefined : space.systemFocus(systemId)) ?? space.universeFocus,
      frame: INITIAL_FRAME,
      redraw,
    }),
    [systemId, space, redraw],
  );
  const overlay = useCallback(
    (info: SpaceOverlayInfo) => {
      const named = NAMED_AT[stop];
      const shown = info.anchors.filter((anchor) => named.includes(anchor.kind));
      controller.setAnchors(shown);
      return (
        <VoyageOverlay
          anchors={shown}
          size={size}
          focusId={focusId}
          onPlace={(id) => void session.focus(id)}
          onStation={(id) => onStation?.(id)}
          onDust={() => onDust?.()}
        />
      );
    },
    [controller, session, onStation, onDust, stop, size, focusId],
  );

  const stage = useRef<ComponentRef<typeof View>>(null);
  // The web's wheel: one notch is one stop.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = stage.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      controller.wheel(event.deltaY);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [controller]);
  // Escape on the ground climbs one stop, to the planet's globe, as the Back pill does. The Universe's own Escape (close
  // what is open, else go up a level) listens after this one and handles every other case; its "up" would skip the
  // globe and go straight to the star.
  const onGround = view.kind === 'planet' && view.landed && view.selectedRegion === undefined;
  useEffect(() => {
    if (Platform.OS !== 'web' || !onGround) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey) return;
      const { overlay, selectedId } = session.getState();
      if (overlay !== null || selectedId !== null || document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      climbOneStop(session, view);
    };
    window.addEventListener('keydown', escape, { capture: true });
    return () => window.removeEventListener('keydown', escape, { capture: true });
  }, [onGround, session, view]);
  const onKeyDown: NonNullable<ViewProps['onKeyDown']> = (event) => {
    if (event.target !== event.currentTarget || !('key' in event.nativeEvent)) return;
    // Alt+Arrow is the browser's Back and Forward; Ctrl and Cmd are the person's own shortcuts.
    const modified = event.nativeEvent as { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
    if (modified.altKey === true || modified.ctrlKey === true || modified.metaKey === true) return;
    if (controller.key(event.nativeEvent.key)) event.preventDefault();
  };
  const measure = () => {
    const node = stage.current as unknown as {
      measureInWindow?: (callback: (x: number, y: number) => void) => void;
    } | null;
    node?.measureInWindow?.((x, y) => controller.setOrigin(x, y));
  };
  return (
    <View
      ref={stage}
      style={[StyleSheet.absoluteFill, WEB_TOUCH]}
      focusable
      onLayout={measure}
      {...(Platform.OS === 'web' ? { onKeyDown } : {})}
      {...controller.responder.panHandlers}
      testID="voyage-stage"
    >
      <SpaceView
        definition={space.definition}
        camera={camera}
        load={controller.load}
        overlay={overlay}
        fallback={(reason) => <Unavailable reason={reason} onUnavailable={onUnavailable} />}
        {...(recordFrame ? { onFrameTime: recordFrame } : {})}
      />
    </View>
  );
}

/** The planet the camera is at or going to, as the driver draws it: its world, what is charted and its palette. */
function usePlanetSurface(
  session: UniverseMapSession,
  state: SceneProps['state'],
  index: SceneProps['index'],
  view: UniverseView,
): VoyagePlanet | null {
  const looks = looksOfState(state);
  const planet = view.kind === 'planet' ? view.planet : undefined;
  const plan = useMemo(
    () => (planet ? planPlanet(planet, index.regions.get(planet.objectId) ?? [], looksById(looks)) : undefined),
    [planet, index, looks],
  );
  const globe = useGlobeWorld(session, plan?.spec);
  return useMemo(() => {
    if (!planet || !plan || globe.status !== 'ready') return null;
    const chart = chartWorld(globe.world, plan.sites);
    const names = new Map((index.regions.get(planet.objectId) ?? []).map((region) => [region.objectId, region.label]));
    const hueShift = plan.look?.hueShift ?? 0;
    // Everything the painted texture depends on: a new look (its type or hue) repaints the globe as a new chart does.
    const sites = plan.sites.map((site) => `${site.objectId}:${String(site.site)}`).join(',');
    return {
      key: `${planet.objectId}|${plan.spec.type}|${String(hueShift)}|${sites}`,
      planetId: planet.objectId,
      world: globe.world,
      chart,
      palette: paletteOf(plan.spec.type, hueShift),
      labels: labelPoints(chart),
      names,
    };
  }, [planet, plan, globe, index]);
}

/** Every place on screen is a named 48 px button over the canvas, with its name beside it. */
/**
 * Where names may not sit, as the prototype keeps them (its label pass, `top` and `bot`): clear of the header and of the
 * chips and caption at the bottom. On a desktop (the prototype's `W >= 900`) the bands are narrower.
 */
const LABEL_BANDS = {
  phone: { top: 150, bottom: 196 },
  desktop: { top: 64, bottom: 46 },
} as const;
const DESKTOP_WIDTH = 900;

/**
 * The names of the places on screen, placed so that none covers another or the header and chips: each tries below,
 * above, right and left of its place, and a name with no free spot is left out until the camera comes closer (its
 * button keeps the name for a screen reader). The place the camera is at is placed first, then planets, systems and
 * regions, then rooms.
 */
function placeNames(
  anchors: readonly SpaceAnchor[],
  size: { readonly width: number; readonly height: number },
  focusId: string | null,
) {
  const bands = size.width >= DESKTOP_WIDTH ? LABEL_BANDS.desktop : LABEL_BANDS.phone;
  const requests: LabelRequest[] = anchors
    .filter((anchor) => anchor.kind !== 'dust')
    .map((anchor) => ({
      id: anchor.id,
      anchor: { x: anchor.x, y: anchor.y },
      clearance:
        anchor.kind === 'region' ? REGION_NAME_GAP : Math.max(anchor.radiusPx, MIN_BODY_RADIUS) + BODY_NAME_GAP,
      width: labelWidth(anchor.name),
      height: LABEL_HEIGHT,
      priority: (anchor.id === focusId ? 6 : 0) + (anchor.kind === 'station' ? 0 : 1),
    }));
  return new Map(
    placeLabels(requests, size, [
      { x: 0, y: 0, width: size.width, height: bands.top },
      { x: 0, y: size.height - bands.bottom, width: size.width, height: bands.bottom },
    ]).map((label) => [label.id, label]),
  );
}

function VoyageOverlay({
  anchors,
  size,
  focusId,
  onPlace,
  onStation,
  onDust,
}: {
  readonly anchors: readonly SpaceAnchor[];
  readonly size: { readonly width: number; readonly height: number };
  readonly focusId: string | null;
  readonly onPlace: (id: string) => void;
  readonly onStation: (id: string) => void;
  readonly onDust: () => void;
}) {
  const shown = anchors.filter((anchor) => anchor.visible);
  const names = placeNames(shown, size, focusId);
  // Bodies orbit and pass close: crowded targets shrink and step apart so each stays a target of its own.
  const targets = new Map(
    separateTargets(shown.map((anchor) => ({ id: anchor.id, x: anchor.x, y: anchor.y, size: target.comfortable }))).map(
      (box) => [box.id, box],
    ),
  );
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {shown.map((anchor) => {
        const box = targets.get(anchor.id)!;
        if (anchor.kind === 'dust')
          return (
            <BodyTarget
              key={anchor.id}
              x={box.x}
              y={box.y}
              size={box.size}
              floor={CROWDED_TARGET}
              label="Dust: something is forming"
              onPress={onDust}
              testID={`voyage-dust-${anchor.id}`}
            />
          );
        const kind = anchor.kind === 'station' ? undefined : anchor.kind;
        const name = names.get(anchor.id);
        return (
          <View key={anchor.id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {name === undefined ? null : (
              <MapLabel label={name} text={anchor.name} variant={anchor.kind === 'region' ? 'pill' : 'plain'} />
            )}
            <BodyTarget
              x={box.x}
              y={box.y}
              size={box.size}
              floor={CROWDED_TARGET}
              label={anchor.kind === 'station' ? `${anchor.name}, a room` : anchor.name}
              {...(kind ? { kind } : {})}
              onPress={() => (anchor.kind === 'station' ? onStation(anchor.id) : onPlace(anchor.id))}
              testID={`voyage-${anchor.kind}-${anchor.id}`}
            />
          </View>
        );
      })}
    </View>
  );
}
