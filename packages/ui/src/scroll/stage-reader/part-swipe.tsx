import { useMemo, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View, useWindowDimensions } from 'react-native';
import { partMoveOf, type PartMove } from './part-gesture';

/** One responder per mount: it keeps where the touch began in its own closure. */
function createPartResponder(onMove: (move: PartMove) => void, screenWidth: number) {
  let startX = 0;
  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: (event) => {
      startX = event.nativeEvent.pageX;
      return false;
    },
    onMoveShouldSetPanResponder: (_event, movement) =>
      Math.abs(movement.dx) > 12 && Math.abs(movement.dx) > Math.abs(movement.dy) * 1.2,
    onPanResponderRelease: (_event, movement) => {
      const move = partMoveOf({ dx: movement.dx, dy: movement.dy, startedAtEnd: false, startX, screenWidth });
      if (move !== undefined) onMove(move);
    },
    onPanResponderTerminationRequest: () => false,
  });
}

/**
 * Native: a responder around the text and stop surfaces only. It claims a touch once it is clearly
 * sideways, so the vertical scroll keeps every vertical movement; the stage, the spine and the dock
 * are siblings and never inside it (D-071). A pull up past the end is reported by the scroll view
 * itself (`onScrollEndDrag`), not here, because the view's own overscroll owns that touch.
 */
export function PartSwipe({
  children,
  onMove,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: PartMove) => void;
  /** Used by the web file; the native pull is reported by the scroll view. */
  readonly atEnd?: () => boolean;
}) {
  const { width } = useWindowDimensions();
  // `onMove` should be stable (the reader keeps it so): a new one makes a new responder.
  const responder = useMemo(() => createPartResponder(onMove, width), [onMove, width]);
  return (
    <View style={styles.fill} {...responder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
