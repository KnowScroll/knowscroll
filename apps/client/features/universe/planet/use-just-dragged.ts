import { useCallback, useEffect, useRef } from 'react';

/** A press this soon after the camera last moved is the end of a drag, not a tap. */
const AFTER_DRAG_MS = 350;

/**
 * Tells a tap from the end of a drag. A browser sends a click when a pointer is lifted over the
 * element it went down on, even after a drag that panned the view, so a pan that begins on a region
 * or on the globe must not also choose or land. Returns a function that answers whether the camera
 * moved a moment ago.
 */
export function useJustDragged(x: number, y = 0, scale = 1): () => boolean {
  const movedAt = useRef(Number.NEGATIVE_INFINITY);
  const previous = useRef({ x, y, scale });
  useEffect(() => {
    const before = previous.current;
    if (before.x === x && before.y === y && before.scale === scale) return;
    previous.current = { x, y, scale };
    movedAt.current = Date.now();
  }, [x, y, scale]);
  return useCallback(() => Date.now() - movedAt.current < AFTER_DRAG_MS, []);
}
