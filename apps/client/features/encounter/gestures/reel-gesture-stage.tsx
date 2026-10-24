import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { createGestureArbitrator, type EncounterGestureMove } from './arbitration';

/** Holding a finger still this long on the video opens the feedback menu (P03); the ⋯ is the visible way. */
export const LONG_PRESS_MS = 500;
/** A finger that moves further than this is a swipe, not a hold. */
const HOLD_SLOP = 10;

function createReelResponder(onMove: (move: EncounterGestureMove) => void, width: number) {
  let gesture: ReturnType<typeof createGestureArbitrator> | undefined;
  let locked = false;
  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: (event) => {
      gesture = createGestureArbitrator({
        startX: event.nativeEvent.pageX,
        scroll: false,
        childOwns: event.nativeEvent.touches.length !== 1,
        native: true,
        width,
      });
      locked = false;
      return false;
    },
    onMoveShouldSetPanResponder: (event, movement) => {
      if (event.nativeEvent.touches.length !== 1) gesture?.cancel();
      const owner = gesture?.move(movement.dx, movement.dy);
      locked = owner === 'horizontal' || owner === 'vertical';
      return locked;
    },
    onPanResponderMove: (event, movement) => {
      if (event.nativeEvent.touches.length !== 1) gesture?.cancel();
      gesture?.move(movement.dx, movement.dy);
    },
    onPanResponderRelease: (_event, movement) => {
      gesture?.move(movement.dx, movement.dy);
      const move = gesture?.release();
      gesture = undefined;
      if (move) onMove(move);
    },
    onPanResponderTerminationRequest: () => !locked,
    onPanResponderTerminate: () => {
      gesture?.cancel();
      gesture = undefined;
    },
    onShouldBlockNativeResponder: () => locked,
  });
}

/** Native responder boundary around the actual noninteractive video stage only. Player controls are siblings. */
export function ReelGestureStage({
  children,
  onMove,
  onMenu,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: EncounterGestureMove) => void;
  /** A keyboard action of the web stage (Space); touch has the player's own button. */
  readonly onToggle?: () => void;
  /** A long press on the video: opens the feedback menu. */
  readonly onMenu?: () => void;
}) {
  const { width } = useWindowDimensions();
  const responder = useMemo(() => createReelResponder(onMove, width), [onMove, width]);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; x: number; y: number }>({
    timer: undefined,
    x: 0,
    y: 0,
  });
  const release = useCallback(() => {
    clearTimeout(hold.current.timer);
    hold.current.timer = undefined;
  }, []);
  useEffect(() => release, [release]);
  const begin = (event: GestureResponderEvent) => {
    release();
    if (onMenu === undefined || event.nativeEvent.touches.length !== 1) return;
    hold.current.x = event.nativeEvent.pageX;
    hold.current.y = event.nativeEvent.pageY;
    hold.current.timer = setTimeout(onMenu, LONG_PRESS_MS);
  };
  const drift = (event: GestureResponderEvent) => {
    if (
      Math.abs(event.nativeEvent.pageX - hold.current.x) > HOLD_SLOP ||
      Math.abs(event.nativeEvent.pageY - hold.current.y) > HOLD_SLOP
    )
      release();
  };
  return (
    <View
      style={styles.stage}
      {...responder.panHandlers}
      onTouchStart={begin}
      onTouchMove={drift}
      onTouchEnd={release}
      onTouchCancel={release}
      testID="reel-navigation-stage"
    >
      {children}
    </View>
  );
}
const styles = StyleSheet.create({ stage: { flex: 1 } });
