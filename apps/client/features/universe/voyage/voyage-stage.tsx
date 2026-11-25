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
import { SpaceView, type SpaceOverlayInfo } from '../space/space-view';
import { INITIAL_FRAME } from '../universe-camera';
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { stopOf, type Stop } from './ladder';
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
 * The Universe's Round 7.3 look, on trial behind a device switch (#811): one camera that flies along the ladder
 * (ground, planet, star, the whole universe), a planet drawn as one world from orbit to the ground, and a ship the
 * person can drag and let go over a place to go there. It draws the map's own three.js scene through `SpaceView`, with
 * a camera driver of its own (`voyage-driver.ts`), and keeps the map's contract: every place is a named 48 px button
 * over the canvas, and browsing writes nothing.
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
  const recordFrame = useFrameTimeRecorder();

  const systemId = inputs.target.systemId;
  const stop = inputs.target.stop;
  // A new camera object makes `SpaceView` draw again: under reduced motion there is no loop, so every change of where
  // you are, of what you turned or of the planet's world must be one.
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
          onPlace={(id) => void session.focus(id)}
          onStation={(id) => onStation?.(id)}
          onDust={() => onDust?.()}
        />
      );
    },
    [controller, session, onStation, onDust, stop],
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
    return {
      key: `${planet.objectId}|${plan.sites.map((site) => `${site.objectId}:${String(site.site)}`).join(',')}`,
      planetId: planet.objectId,
      world: globe.world,
      chart,
      palette: paletteOf(plan.spec.type, plan.look?.hueShift ?? 0),
      labels: labelPoints(chart),
      names,
    };
  }, [planet, plan, globe, index]);
}

/** Every place on screen is a named 48 px button over the canvas, with its name beside it. */
function VoyageOverlay({
  anchors,
  onPlace,
  onStation,
  onDust,
}: {
  readonly anchors: readonly SpaceAnchor[];
  readonly onPlace: (id: string) => void;
  readonly onStation: (id: string) => void;
  readonly onDust: () => void;
}) {
  const shown = anchors.filter((anchor) => anchor.visible);
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
        const width = labelWidth(anchor.name);
        const below = anchor.kind === 'region' ? 14 : Math.max(anchor.radiusPx, 6) + 6;
        return (
          <View key={anchor.id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <MapLabel
              label={{ id: anchor.id, x: anchor.x - width / 2, y: anchor.y + below, width, height: LABEL_HEIGHT }}
              text={anchor.name}
              variant={anchor.kind === 'region' ? 'pill' : 'plain'}
            />
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

/** 3D cannot be drawn: the screen swaps in the Simple lists. */
function Unavailable({
  reason,
  onUnavailable,
}: {
  readonly reason: SpaceFailure;
  readonly onUnavailable: (reason: SpaceFailure) => void;
}) {
  useEffect(() => onUnavailable(reason), [reason, onUnavailable]);
  return null;
}
