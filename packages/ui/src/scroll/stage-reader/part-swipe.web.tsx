import { useRef, type ReactNode } from 'react';
import { scrolledToEnd } from './current-stop';
import { partMoveOf, type PartMove } from './part-gesture';

/** A control that takes its own drag: a swipe that starts on one is the control's. */
const OWN_DRAG = 'input,select,textarea,[role="slider"],[contenteditable="true"]';

/**
 * Whether the text under the finger is scrolled to its end, read from the page at the moment of the
 * touch. The reader's own record of the scroll position can trail the real one (a scroll report is
 * throttled and the last one comes when scrolling ends), and a pull that starts at the end must not
 * depend on it.
 */
function textUnderFingerAtEnd(touched: EventTarget | null, within: Element): boolean {
  for (let node = touched instanceof Element ? touched : null; node !== null; node = node.parentElement) {
    const scrolls = node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY);
    if (scrolls)
      return scrolledToEnd({ scrollTop: node.scrollTop, viewport: node.clientHeight, content: node.scrollHeight });
    if (node === within) break;
  }
  return false;
}

interface Press {
  readonly x: number;
  readonly y: number;
  readonly atEnd: boolean;
}

/**
 * Web: the text and stop surfaces only (D-071), and only a finger. A mouse or pen drag across the
 * text is selecting it (the way to "Simpler" and "Ask about this"), so it never moves a Part or asks
 * for a new topic; on a desktop every move is a button and a key. A finger is read from touch events
 * because `touch-action: pan-y` hands the vertical movement to the browser (which then cancels the
 * pointer) while a sideways swipe or a pull still reach us. One drag is one intent, decided at release
 * by `partMoveOf`.
 */
export function PartSwipe({
  children,
  onMove,
}: {
  readonly children: ReactNode;
  readonly onMove: (move: PartMove) => void;
}) {
  const press = useRef<Press | undefined>(undefined);
  const begin = (x: number, y: number, target: EventTarget | null, surface: Element) => {
    press.current =
      target instanceof Element && target.closest(OWN_DRAG) !== null
        ? undefined
        : { x, y, atEnd: textUnderFingerAtEnd(target, surface) };
  };
  const finish = (x: number, y: number) => {
    const from = press.current;
    press.current = undefined;
    if (from === undefined) return;
    const move = partMoveOf({ dx: x - from.x, dy: y - from.y, startedAtEnd: from.atEnd });
    if (move !== undefined) onMove(move);
  };
  return (
    <div
      data-testid="part-swipe"
      style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column', touchAction: 'pan-y' }}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        if (touch !== undefined && event.touches.length === 1)
          begin(touch.clientX, touch.clientY, event.target, event.currentTarget);
        else press.current = undefined;
      }}
      onTouchEnd={(event) => {
        const touch = event.changedTouches[0];
        if (touch !== undefined) finish(touch.clientX, touch.clientY);
      }}
      onTouchCancel={() => {
        press.current = undefined;
      }}
    >
      {children}
    </div>
  );
}
