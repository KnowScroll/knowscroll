import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { PanResponder, Platform, StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
import { PlanetScene } from './planet-scene';
import { SpaceStage } from './space/space-stage';
import { viewFor, type Size, type UniverseIndex } from './universe-layout';
import type { UniverseFrame } from './universe-camera';
import type { SceneProps } from './scene-parts';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

const KEY_PAN = 60;
const KEY_ZOOM = 1.25;

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
}: {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly onSearch: () => void;
  readonly onDust: () => void;
  readonly stations?: SceneProps['stations'];
  readonly onStation?: SceneProps['onStation'];
}) {
  const [size, setSize] = useState<Size>({ width: 390, height: 640 });
  const view = viewFor(index, state.focusId);
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
    const moves: Record<string, () => void> = {
      ArrowLeft: () => pan(-KEY_PAN, 0),
      ArrowRight: () => pan(KEY_PAN, 0),
      ArrowUp: () => pan(0, -KEY_PAN),
      ArrowDown: () => pan(0, KEY_PAN),
      '+': () => zoom(KEY_ZOOM),
      '=': () => zoom(KEY_ZOOM),
      '-': () => zoom(1 / KEY_ZOOM),
      Home: () => session.fit(),
      '/': onSearch,
    };
    const move = moves[key];
    if (move) {
      event.preventDefault();
      move();
    }
  };
  const sceneProps = { session, state, index, size, onDust, stations, onStation };
  const description =
    view.kind === 'universe'
      ? 'Universe map. Arrow keys pan, plus and minus zoom, slash searches.'
      : view.kind === 'system'
        ? `${view.system.label} system map. Arrow keys pan, plus and minus zoom.`
        : `${view.planet.label} planet map. Arrow keys pan, plus and minus zoom.`;
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
        {view.kind !== 'planet' ? <SpaceStage {...sceneProps} view={view} /> : null}
        {view.kind === 'planet' ? (
          <PlanetScene {...sceneProps} planet={view.planet} selectedRegion={view.selectedRegion} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ stage: { flex: 1, overflow: 'hidden' } });
