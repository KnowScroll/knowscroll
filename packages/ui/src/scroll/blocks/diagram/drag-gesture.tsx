import { useRef, type ReactElement } from 'react';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { TWO_AXIS_PAN } from '../../gestures/arbitration';
import type { Point } from './layout';

export interface DragInput {
  readonly enabled: boolean;
  /** Canvas units per screen px. */
  readonly unit: number;
  /** Where the token rests, in canvas units. */
  readonly home: Point;
  readonly onStart: () => void;
  readonly onMove: (point: Point) => void;
  readonly onDrop: (point: Point) => void;
  readonly onEnd: () => void;
}

export interface DragGesture {
  readonly wrap: (handle: ReactElement) => ReactElement;
  readonly viewProps: Record<string, unknown>;
}

/**
 * Native: the token's handle takes a pan in both axes almost at once (`TWO_AXIS_PAN`) and owns it
 * until release; everything else in the block, and the article, keeps the touch. Released, the
 * token is dropped where it is: on a target it chooses that frame, anywhere else the diagram stays
 * as it was. Callbacks run on the JS thread (`runOnJS`).
 */
export function useDragGesture({ enabled, unit, home, onStart, onMove, onDrop, onEnd }: DragInput): DragGesture {
  const last = useRef<Point>(home);
  const at = (translationX: number, translationY: number): Point => ({
    x: home.x + translationX * unit,
    y: home.y + translationY * unit,
  });
  // No spread in the config: the Worklets Babel plugin (babel-preset-expo adds it) refuses one in a
  // gesture hook's object, so the numbers are named one by one.
  const pan = usePanGesture({
    minDistance: TWO_AXIS_PAN.minDistance,
    enabled,
    runOnJS: true,
    onActivate: () => {
      last.current = home;
      onStart();
    },
    onUpdate: (event) => {
      last.current = at(event.translationX, event.translationY);
      onMove(last.current);
    },
    onDeactivate: () => onDrop(last.current),
    onFinalize: () => onEnd(),
  });
  return { wrap: (handle) => <GestureDetector gesture={pan}>{handle}</GestureDetector>, viewProps: {} };
}
