import { useMemo, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View, useWindowDimensions } from 'react-native';
import { dragOf, EDGE_ZONE, partMoveOf, type PartDrag, type PartMove } from './part-gesture';

/** One responder per mount: it keeps where the touch began in its own closure. */
function createPartResponder(
  onMove: (move: PartMove) => void,
  onDrag: ((drag: PartDrag) => void) | undefined,
  screenWidth: number,
) {
  let startX = 0;
  let shown = false;
  return PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: (event) => {
      startX = event.nativeEvent.pageX;
      return false;
    },
    onMoveShouldSetPanResponder: (_event, movement) =>
      Math.abs(movement.dx) > 12 && Math.abs(movement.dx) > Math.abs(movement.dy) * 1.2,
    onPanResponderMove: (_event, movement) => {
      if (onDrag === undefined) return;
      const drag = dragOf({ dx: movement.dx, dy: movement.dy, startedAtEnd: false });
      if (drag?.kind === 'part' && (startX < EDGE_ZONE || startX > screenWidth - EDGE_ZONE)) return;
      if (drag !== undefined) {
        shown = true;
        onDrag(drag);
      } else if (shown) {
        shown = false;
        onDrag({ kind: 'part', dx: 0 });
      }
    },
    onPanResponderRelease: (_event, movement) => {
      const move = partMoveOf({ dx: movement.dx, dy: movement.dy, startedAtEnd: false, startX, screenWidth });
      if (move !== undefined) onMove(move);
      if (shown) onDrag?.({ kind: 'end', move });
      shown = false;
    },
    onPanResponderTerminate: () => {
      if (shown) onDrag?.({ kind: 'end', move: undefined });
      shown = false;
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
  onDrag,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: PartMove) => void;
  /** What the drag looks like so far, for what the screen draws under the finger (sideways drags only on native). */
  readonly onDrag?: ((drag: PartDrag) => void) | undefined;
}) {
  const { width } = useWindowDimensions();
  // `onMove` and `onDrag` should be stable (the reader keeps them so): a new one makes a new responder.
  const responder = useMemo(() => createPartResponder(onMove, onDrag, width), [onMove, onDrag, width]);
  return (
    <View style={styles.fill} {...responder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
