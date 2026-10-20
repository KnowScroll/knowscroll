import { useRef, type ReactElement } from 'react';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { SimulationParam } from '@knowscroll/scroll-model';
import { HORIZONTAL_PAN } from '../../gestures/arbitration';
import { valueAt } from './slider-model';

export interface SliderGestureInput {
  readonly param: SimulationParam;
  /** Length of the part of the track the thumb travels along, in px. */
  readonly travel: number;
  /** Space before the first value (half the thumb). */
  readonly inset: number;
  readonly onPreview: (value: number) => void;
  /** `dragged`: the value was dragged (a release); otherwise it was a tap. */
  readonly onCommit: (value: number, dragged: boolean) => void;
  readonly onDragging: (dragging: boolean) => void;
}

export interface SliderGesture {
  /** Puts the gesture detector around the track. */
  readonly wrap: (track: ReactElement) => ReactElement;
  /** Extra props for the track view (the web's pointer handlers). */
  readonly viewProps: Record<string, unknown>;
}

/**
 * Native: a pan that react-native-gesture-handler gives to the slider only after the horizontal
 * axis locks (`HORIZONTAL_PAN`: it activates after 10 px sideways and fails if the touch moves 10
 * px up or down first, which leaves the article's vertical scroll with the touch). Once active the
 * slider owns the drag until release. Callbacks run on the JS thread (`runOnJS`): the value is
 * React state, and nothing here animates on the UI thread.
 */
export function useSliderGesture({
  param,
  travel,
  inset,
  onPreview,
  onCommit,
  onDragging,
}: SliderGestureInput): SliderGesture {
  const last = useRef<number | null>(null);
  const at = (x: number) => valueAt(param, travel > 0 ? (x - inset) / travel : 0);
  // No spread in the config: the Worklets Babel plugin (babel-preset-expo adds it) refuses one in a
  // gesture hook's object, so the numbers are named one by one.
  const pan = usePanGesture({
    activeOffsetX: HORIZONTAL_PAN.activeOffsetX,
    failOffsetY: HORIZONTAL_PAN.failOffsetY,
    runOnJS: true,
    onActivate: (event) => {
      onDragging(true);
      last.current = at(event.x);
      onPreview(last.current);
    },
    onUpdate: (event) => {
      last.current = at(event.x);
      onPreview(last.current);
    },
    onDeactivate: () => {
      if (last.current !== null) onCommit(last.current, true);
    },
    onFinalize: () => {
      last.current = null;
      onDragging(false);
    },
  });
  return { wrap: (track) => <GestureDetector gesture={pan}>{track}</GestureDetector>, viewProps: {} };
}
