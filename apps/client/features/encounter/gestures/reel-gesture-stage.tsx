import { useMemo, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View, useWindowDimensions } from 'react-native';
import { createGestureArbitrator } from './arbitration';

function createReelResponder(onMove: (move: 'next' | 'previous' | 'subject') => void, width: number) {
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
}: {
  readonly children: ReactNode;
  readonly onMove: (move: 'next' | 'previous' | 'subject') => void;
}) {
  const { width } = useWindowDimensions();
  const responder = useMemo(() => createReelResponder(onMove, width), [onMove, width]);
  return (
    <View style={styles.stage} {...responder.panHandlers} testID="reel-navigation-stage">
      {children}
    </View>
  );
}
const styles = StyleSheet.create({ stage: { flex: 1 } });
