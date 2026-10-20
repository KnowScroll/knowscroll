import { useRef, type ReactElement } from 'react';
import type { DragGesture, DragInput } from './drag-gesture';
import type { Point } from './layout';

interface PointerLike {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly currentTarget: Element;
  preventDefault(): void;
}

const pointer = (event: unknown) => event as PointerLike;

/**
 * Web: pointer events on the token's handle, which says `touch-action: none` so the touch is the
 * token's from the first contact (a block that captures both axes owns the drag until release;
 * the rest of the article scrolls as usual). The pointer is captured, so a drag that leaves the
 * handle keeps working; `pointercancel` puts the token back and changes nothing.
 */
export function useDragGesture({ enabled, unit, home, onStart, onMove, onDrop, onEnd }: DragInput): DragGesture {
  const state = useRef<{ id: number; startX: number; startY: number; last: Point } | null>(null);
  const viewProps = {
    onPointerDown: (raw: unknown) => {
      if (!enabled) return;
      const event = pointer(raw);
      state.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, last: home };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      onStart();
    },
    onPointerMove: (raw: unknown) => {
      const event = pointer(raw);
      const current = state.current;
      if (current === null || current.id !== event.pointerId) return;
      current.last = {
        x: home.x + (event.clientX - current.startX) * unit,
        y: home.y + (event.clientY - current.startY) * unit,
      };
      onMove(current.last);
    },
    onPointerUp: (raw: unknown) => {
      const event = pointer(raw);
      const current = state.current;
      if (current === null || current.id !== event.pointerId) return;
      state.current = null;
      onDrop(current.last);
      onEnd();
    },
    onPointerCancel: () => {
      if (state.current === null) return;
      state.current = null;
      onEnd();
    },
    style: { touchAction: 'none' },
  };
  return { wrap: (handle: ReactElement) => handle, viewProps };
}
