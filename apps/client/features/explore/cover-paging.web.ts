import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import type { View } from 'react-native';

/** How far a finger travels up or down a cover to turn to the next or the previous one. */
const SWIPE_DISTANCE = 64;
/** A swipe is a page turn only when it is mostly vertical. */
const SWIPE_STRAIGHTNESS = 1.5;
/** How much wheel movement turns one cover. */
const WHEEL_DISTANCE = 40;
/** Wheel events closer together than this belong to the gesture that already turned a cover. */
const WHEEL_GESTURE_MS = 450;

export interface CoverMoves {
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onOpen: () => void;
  readonly onBack: () => void;
}

/** A cover that overflows (large text at a narrow width) scrolls first; only at its edge does a gesture turn the cover. */
function scrollerOf(target: EventTarget | null, root: HTMLElement): HTMLElement | undefined {
  for (let node = target instanceof HTMLElement ? target : null; node && node !== root; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return undefined;
}

function canScroll(node: HTMLElement | undefined, direction: 1 | -1): boolean {
  if (!node) return false;
  return direction > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0;
}

/** Keys typed into a field, or pressed with a modifier, are not the cover's. */
function ownsKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  return !(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/**
 * The covers' own moves on the web: a vertical swipe or one wheel gesture turns to the next or previous cover, ↓ or J
 * and ↑ or K do the same, Enter opens the cover and Esc is Back. Every move also has a button on the cover, so none of
 * these is the only way. A finger or wheel that is scrolling an overflowing cover scrolls it until it reaches its edge.
 */
export function useCoverPaging(
  rootRef: RefObject<ComponentRef<typeof View> | null>,
  enabled: boolean,
  moves: CoverMoves,
) {
  const latest = useRef(moves);
  useEffect(() => {
    latest.current = moves;
  });
  useEffect(() => {
    const root = rootRef.current as unknown as HTMLElement | null;
    if (!enabled || !root) return;
    let touch: { x: number; y: number; scroller?: HTMLElement; top: number } | undefined;
    let wheel = { total: 0, last: 0, turned: false };

    const turn = (direction: 1 | -1) => (direction > 0 ? latest.current.onNext() : latest.current.onPrevious());

    const touchStart = (event: TouchEvent) => {
      const point = event.touches[0];
      if (event.touches.length !== 1 || !point) {
        touch = undefined;
        return;
      }
      const scroller = scrollerOf(event.target, root);
      touch = { x: point.clientX, y: point.clientY, ...(scroller ? { scroller } : {}), top: scroller?.scrollTop ?? 0 };
    };
    const touchEnd = (event: TouchEvent) => {
      const start = touch;
      touch = undefined;
      const point = event.changedTouches[0];
      if (!start || !point) return;
      const up = start.y - point.clientY;
      const across = Math.abs(start.x - point.clientX);
      if (Math.abs(up) < SWIPE_DISTANCE || Math.abs(up) < SWIPE_STRAIGHTNESS * across) return;
      const direction = up > 0 ? 1 : -1;
      // The finger was reading an overflowing cover: it turns the page only from the edge it started at.
      if (start.scroller && (start.scroller.scrollTop !== start.top || canScroll(start.scroller, direction))) return;
      turn(direction);
    };
    const onWheel = (event: WheelEvent) => {
      const direction = event.deltaY > 0 ? 1 : -1;
      if (event.deltaY === 0 || canScroll(scrollerOf(event.target, root), direction)) return;
      event.preventDefault();
      const now = event.timeStamp;
      if (now - wheel.last > WHEEL_GESTURE_MS) wheel = { total: 0, last: now, turned: false };
      wheel.last = now;
      if (wheel.turned) return;
      wheel.total += event.deltaY;
      if (Math.abs(wheel.total) < WHEEL_DISTANCE) return;
      wheel.turned = true;
      turn(direction);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!ownsKey(event) || event.defaultPrevented || event.repeat) return;
      const key = event.key;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      // Keys are the covers' only while focus is on the page itself or inside the covers: a tab of the app's rail, a
      // switch or a sheet keeps its own keys, so Enter there never opens a Scroll the person did not choose.
      if (target && target !== document.body && !root.contains(target)) return;
      if (key === 'ArrowDown' || key === 'j' || key === 'J') turn(1);
      else if (key === 'ArrowUp' || key === 'k' || key === 'K') turn(-1);
      // Enter on a focused button presses that button; anywhere else it opens the cover.
      else if (key === 'Enter' && !target?.closest('button, a, [role="button"], [role="link"]'))
        latest.current.onOpen();
      else if (key === 'Escape') latest.current.onBack();
      else return;
      event.preventDefault();
    };

    root.addEventListener('touchstart', touchStart, { passive: true });
    root.addEventListener('touchend', touchEnd, { passive: true });
    root.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('touchstart', touchStart);
      root.removeEventListener('touchend', touchEnd);
      root.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [rootRef, enabled]);
}
