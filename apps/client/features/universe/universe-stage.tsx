import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { PanResponder, Platform, StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
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
        if (width > 0 && height > 0) setSize({ width, height });
      }}
      style={styles.stage}
      {...responder.panHandlers}
    >
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {view.kind !== 'planet' ? (
          <SpaceStage {...sceneProps} view={view} onUnavailable={onUnavailable} pickPlanets={pickPlanets} />
        ) : null}
        {view.kind === 'planet' ? (
          <PlanetStage
            {...sceneProps}
            planet={view.planet}
            landed={view.landed}
            selectedRegion={view.selectedRegion}
            visitor={visitor === true}
            onRefused={onRefused}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ stage: { flex: 1, overflow: 'hidden' } });
