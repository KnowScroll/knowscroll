import { useRef, type ReactElement } from 'react';
import { classifyMove, type Axis } from '../../gestures/arbitration';
import { valueAt } from './slider-model';
import type { SliderGesture, SliderGestureInput } from './slider-gesture';

interface PointerLike {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: Element;
  preventDefault(): void;
}

/** Pointer events as the DOM gives them (React Native Web passes the synthetic event through). */
function pointer(event: unknown): PointerLike {
  return event as PointerLike;
}

/**
 * Web: pointer events with the same rule as native. The track says `touch-action: pan-y`, so the
 * browser itself keeps vertical panning on a touch screen (and sends `pointercancel` when it
 * takes the touch); a pointer that moves sideways past the slop locks the horizontal axis, the
 * slider captures it and owns it until release; one that moves vertically first is left alone. A
 * tap that never moves jumps to that position.
 */
export function useSliderGesture({
  param,
  travel,
  inset,
  onPreview,
  onCommit,
  onDragging,
}: SliderGestureInput): SliderGesture {
  const state = useRef<{ id: number; startX: number; startY: number; axis: Axis; value: number | null } | null>(null);
  const at = (event: PointerLike, element: Element) => {
    const rect = element.getBoundingClientRect();
    return valueAt(param, travel > 0 ? (event.clientX - rect.left - inset) / travel : 0);
  };

  const viewProps = {
    onPointerDown: (raw: unknown) => {
      const event = pointer(raw);
      state.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        axis: 'undecided',
        value: null,
      };
    },
    onPointerMove: (raw: unknown) => {
      const event = pointer(raw);
      const current = state.current;
      if (current === null || current.id !== event.pointerId) return;
      if (current.axis === 'undecided') {
        current.axis = classifyMove(event.clientX - current.startX, event.clientY - current.startY);
        if (current.axis === 'horizontal') {
          event.currentTarget.setPointerCapture(event.pointerId);
          onDragging(true);
        }
      }
      if (current.axis !== 'horizontal') return;
      event.preventDefault();
      current.value = at(event, event.currentTarget);
      onPreview(current.value);
    },
    onPointerUp: (raw: unknown) => {
      const event = pointer(raw);
      const current = state.current;
      if (current === null || current.id !== event.pointerId) return;
      state.current = null;
      if (current.axis === 'horizontal') {
        onDragging(false);
        if (current.value !== null) onCommit(current.value, true);
      } else if (current.axis === 'undecided') {
        // A tap: jump to where it landed.
        onCommit(at(event, event.currentTarget), false);
      }
    },
    onPointerCancel: () => {
      // The browser took the touch for vertical scrolling: nothing was changed, so nothing is kept.
      if (state.current?.axis === 'horizontal') onDragging(false);
      state.current = null;
    },
    style: { touchAction: 'pan-y' },
  };
  return { wrap: (track: ReactElement) => track, viewProps };
}
