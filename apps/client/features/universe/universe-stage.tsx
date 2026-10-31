import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import type { CollectionLandmark } from '@knowscroll/client-core';
import {
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ViewProps,
} from 'react-native';
import { TapRing, usePlayerValue, useFeedValue } from './animation/animated';
import { chromeAt as systemChrome } from './animation/enter-system';
import { chromeAt as planetChrome, skyAt } from './animation/enter-planet';
import { enterWorldFrame } from './animation/enter-world';
import { crossFadeAt } from './animation/step-up';
import { GlobeLayer, WorldLayers } from './animation/planet-layers';
import type { StepAnimation, UniverseAnimation } from './animation/use-universe-animation';
import { globePlacement } from './planet/planet-globe';
import { PlanetStage } from './planet/planet-stage';
import { SpaceStage } from './space/space-stage';
import type { SpaceFailure } from './space/space-surface';
import { viewFor, type Size, type UniverseIndex } from './universe-layout';
import type { UniverseFrame } from './universe-camera';
import type { SceneProps } from './scene-parts';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

const KEY_PAN = 60;
const KEY_ZOOM = 1.25;

/** What a key does on the focused map. The single source of the keys the map listens to: the keyboard map lists each (D-053). */
interface MapActions {
  readonly pan: (dx: number, dy: number) => void;
  readonly zoom: (factor: number) => void;
  readonly fit: () => void;
  readonly search: () => void;
}
const MAP_KEYS: Readonly<Record<string, (actions: MapActions) => void>> = {
  ArrowLeft: (map) => map.pan(-KEY_PAN, 0),
  ArrowRight: (map) => map.pan(KEY_PAN, 0),
  ArrowUp: (map) => map.pan(0, -KEY_PAN),
  ArrowDown: (map) => map.pan(0, KEY_PAN),
  '+': (map) => map.zoom(KEY_ZOOM),
  '=': (map) => map.zoom(KEY_ZOOM),
  '-': (map) => map.zoom(1 / KEY_ZOOM),
  Home: (map) => map.fit(),
  '/': (map) => map.search(),
};
/** The keys the focused map listens to. */
export const UNIVERSE_MAP_KEY_NAMES: readonly string[] = Object.keys(MAP_KEYS);

/**
 * Drag pans and pinch zooms the current view. Taps still reach the places beneath, because the
 * responder only takes over once a finger has moved: a drag that starts on a place pans, a tap on
 * it selects it.
 */
function cameraResponder(session: UniverseMapSession) {
  let origin: UniverseFrame = { x: 0, y: 0, scale: 1 };
  let startDistance = 0;
  const spread = (touches: readonly { pageX: number; pageY: number }[]) => {
    const [first, second] = touches;
    return first && second ? Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY) : 0;
  };
  return PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 8,
    onPanResponderGrant: (event) => {
      origin = session.getState().frame;
      startDistance = spread(event.nativeEvent.touches);
    },
    onPanResponderMove: (event, gesture) => {
      const distance = spread(event.nativeEvent.touches);
      if (distance > 0) {
        if (startDistance === 0) startDistance = distance;
        session.camera({ ...origin, scale: (origin.scale * distance) / startDistance });
      } else session.camera({ ...origin, x: origin.x - gesture.dx, y: origin.y - gesture.dy });
    },
    onPanResponderTerminationRequest: () => true,
  });
}

/**
 * The map surface: measures itself, picks the overview, a system or a planet from the focused
 * place, and owns pan, zoom and keyboard. One transform for every place; nothing here depends on
 * sibling order or activity.
 */
export function UniverseStage({
  session,
  state,
  index,
  onSearch,
  onDust,
  stations,
  onStation,
  visitor,
  onRefused,
  onUnavailable,
  pickPlanets,
  animation,
  onSize,
  landmarksByPlanet,
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly onSearch: () => void;
  readonly onDust: () => void;
  readonly stations?: SceneProps['stations'];
  readonly onStation?: SceneProps['onStation'];
  /** A friend's universe: a planet's globe turns but does not land. */
  readonly visitor?: boolean;
  /** A planet whose world could not be drawn: the screen swaps in the plain list. */
  readonly onRefused: (planetId: string) => void;
  /** 3D cannot be drawn: the screen swaps in the Simple lists. */
  readonly onUnavailable: (reason: SpaceFailure) => void;
  /** A tap on a planet picks it (D02) instead of flying to it. */
  readonly pickPlanets: boolean;
  /** The animation playing, if one is (D-114). The drawing for the step down is made here. */
  readonly animation: UniverseAnimation;
  /** The stage's size, whenever it is measured: the planet view's globe is placed from it. */
  readonly onSize: (size: Size) => void;
  /** The landmarks standing on each planet (D-089). Empty on a friend's universe. */
  readonly landmarksByPlanet?: ReadonlyMap<string, readonly CollectionLandmark[]>;
}) {
  const [size, setSize] = useState<Size>({ width: 390, height: 640 });
  const view = viewFor(index, state.focusId, state.landed);
  const responder = useMemo(() => cameraResponder(session), [session]);
  const surface = useRef<ComponentRef<typeof View>>(null);
  const zoom = (factor: number) => {
    const frame = session.getState().frame;
    session.camera({ ...frame, scale: frame.scale * factor });
  };
  const pan = (dx: number, dy: number) => {
    const frame = session.getState().frame;
    session.camera({ ...frame, x: frame.x + dx, y: frame.y + dy });
  };
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = surface.current as unknown as HTMLElement | null;
    if (!element?.addEventListener) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `zoom` only reads the session's current frame, so one listener per session is enough.
  }, [session]);
  const onKeyDown: NonNullable<ViewProps['onKeyDown']> = (event) => {
    if (event.target !== event.currentTarget || !('key' in event.nativeEvent)) return;
    // Alt+Arrow is the browser's Back and Forward; Ctrl and Cmd are the person's own shortcuts.
    const modified = event.nativeEvent as { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
    if (modified.altKey === true || modified.ctrlKey === true || modified.metaKey === true) return;
    const key = event.nativeEvent.key;
    const move = Object.hasOwn(MAP_KEYS, key) ? MAP_KEYS[key] : undefined;
    if (move) {
      event.preventDefault();
      move({ pan, zoom, fit: () => session.fit(), search: onSearch });
    }
  };
  const sceneProps = { session, state, index, size, onDust, stations, onStation };
  const step = animation.active;
  const worldScene = useMemo(() => worldSceneOf(size), [size]);
  const description =
    view.kind === 'universe'
      ? 'Universe map. Arrow keys pan, plus and minus zoom, slash searches.'
      : view.kind === 'system'
        ? `${view.system.label} system map. Arrow keys pan, plus and minus zoom.`
        : view.landed
          ? `${view.planet.label} planet map. Arrow keys pan, plus and minus zoom.`
          : `${view.planet.label} globe. Arrow keys turn it.`;
  return (
    <View
      ref={surface}
      testID="universe-map"
      role="group"
      accessibilityLabel={description}
      focusable
      {...(Platform.OS === 'web' ? { onKeyDown } : {})}
      onLayout={(event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) {
          setSize({ width, height });
          onSize({ width, height });
        }
      }}
      style={styles.stage}
      {...responder.panHandlers}
    >
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {view.kind !== 'planet' ? (
          <SpaceStage
            {...sceneProps}
            view={view}
            onUnavailable={onUnavailable}
            pickPlanets={pickPlanets}
            animation={animation}
          />
        ) : null}
        {view.kind === 'planet' && step?.kind !== 'enter-world' && !isPlanetEntry(step) ? (
          <PlanetStage
            {...sceneProps}
            planet={view.planet}
            landed={view.landed}
            selectedRegion={view.selectedRegion}
            visitor={visitor === true}
            onRefused={onRefused}
            {...(landmarksByPlanet?.get(view.planet.objectId)
              ? { landmarks: landmarksByPlanet.get(view.planet.objectId)! }
              : {})}
          />
        ) : null}
        {view.kind === 'planet' && isPlanetEntry(step) && step.from.kind === 'system' ? (
          <>
            <SceneFade animation={animation}>
              <SpaceStage
                {...sceneProps}
                view={step.from}
                onUnavailable={onUnavailable}
                pickPlanets={false}
                animation={animation}
              />
            </SceneFade>
            <GlobeLayer feed={animation.feed} globe={globeOf(size)}>
              <PlanetStage
                {...sceneProps}
                planet={view.planet}
                landed={false}
                selectedRegion={undefined}
                visitor={visitor === true}
                onRefused={onRefused}
              />
            </GlobeLayer>
          </>
        ) : null}
        {view.kind === 'planet' && step?.kind === 'enter-world' ? (
          <WorldLayers
            player={animation.player}
            scene={worldScene}
            globe={
              <PlanetStage
                {...sceneProps}
                planet={view.planet}
                landed={false}
                selectedRegion={undefined}
                visitor={visitor === true}
                onRefused={onRefused}
              />
            }
            map={(arrival) => (
              <PlanetStage
                {...sceneProps}
                planet={view.planet}
                landed
                selectedRegion={undefined}
                visitor={visitor === true}
                onRefused={onRefused}
                arrival={arrival}
              />
            )}
          />
        ) : null}
        {step?.kind === 'step-up' && step.from.kind === 'planet' ? (
          <LeavingFade animation={animation}>
            <PlanetStage
              {...sceneProps}
              planet={step.from.planet}
              landed={step.from.landed}
              selectedRegion={step.from.selectedRegion}
              visitor={visitor === true}
              onRefused={onRefused}
            />
          </LeavingFade>
        ) : null}
        {step !== undefined && step.kind !== 'step-up' ? <TapRingLayer animation={animation} size={size} /> : null}
      </View>
    </View>
  );
}

/** Whether an animation is a glide down to a planet (with or without rings and a moon). */
const isPlanetEntry = (
  step: UniverseAnimation['active'],
): step is Extract<NonNullable<UniverseAnimation['active']>, { kind: 'enter-planet' | 'enter-planet-rings' }> =>
  step?.kind === 'enter-planet' || step?.kind === 'enter-planet-rings';

/**
 * The 3D scene of a glide down to a planet. Over the last 0.45 s it fades out, so that the last frame of the glide is the
 * planet view's own sky with only the globe on it, not the system's neighbours, haze and limb until a hard cut.
 */
function SceneFade({ animation, children }: { animation: UniverseAnimation; children: ReactNode }) {
  const opacity = usePlayerValue(animation.player, sceneOpacityAt, 1);
  return (
    <Animated.View testID="universe-3d-layer" pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity }]}>
      {children}
    </Animated.View>
  );
}
const sceneOpacityAt = (t: number): number => 1 - skyAt(t);

/** The planet screen being left, laid over the screen being entered and fading out in 0.3 s (D-116). */
function LeavingFade({ animation, children }: { animation: UniverseAnimation; children: ReactNode }) {
  const opacity = usePlayerValue(animation.player, leavingOpacityAt, 1);
  return (
    <Animated.View
      testID="universe-leaving-layer"
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { opacity }]}
    >
      {children}
    </Animated.View>
  );
}
const leavingOpacityAt = (t: number): number => 1 - crossFadeAt(t);

/** The planet view's globe, as a circle: where the glide ends and the world opens from. */
function globeOf(size: Size): { x: number; y: number; radius: number } {
  const { x, y, diameter } = globePlacement(size);
  return { x, y, radius: diameter / 2 };
}
const worldSceneOf = (size: Size) => ({ screen: size, globe: globeOf(size) });

type FeedRead = NonNullable<Parameters<typeof useFeedValue>[1]>;

/**
 * The one ring that opens and fades where the tap that started an animation touched (design: "Tap ring"). It
 * follows the tapped body: the system or planet the renderer projects each frame, or the globe.
 */
function TapRingLayer({ animation, size }: { animation: UniverseAnimation; size: Size }) {
  const kind = animation.active?.kind;
  const { width, height } = size;
  const opacity = usePlayerValue(
    animation.player,
    useMemo(() => (t: number) => tapRingAt(kind, { width, height }, t).opacity, [kind, width, height]),
    0,
  );
  const scale = usePlayerValue(
    animation.player,
    useMemo(() => (t: number) => tapRingAt(kind, { width, height }, t).scale, [kind, width, height]),
    1,
  );
  const globe = globeOf({ width, height });
  const readX = useMemo<FeedRead>(() => (frame) => (frame.planet ?? frame.system)?.x, []);
  const readY = useMemo<FeedRead>(() => (frame) => (frame.planet ?? frame.system)?.y, []);
  const x = useFeedValue(animation.feed, readX, kind === 'enter-world' ? globe.x : width / 2);
  const y = useFeedValue(animation.feed, readY, kind === 'enter-world' ? globe.y : height / 2);
  return <TapRing x={x} y={y} opacity={opacity} scale={scale} />;
}

/** The tap ring of an animation at `t`: opacity and scale. */
function tapRingAt(kind: StepAnimation['kind'] | undefined, size: Size, t: number): { opacity: number; scale: number } {
  if (kind === 'enter-system') return systemChrome(t).tapRing;
  if (kind === 'enter-planet' || kind === 'enter-planet-rings') return planetChrome(t).tapRing;
  return enterWorldFrame(t, worldSceneOf(size)).tapRing;
}

const styles = StyleSheet.create({ stage: { flex: 1, overflow: 'hidden' } });
