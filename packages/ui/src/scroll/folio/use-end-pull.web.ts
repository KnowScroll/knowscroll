import { useEffect, useRef, useState, type RefObject } from 'react';
import { Animated } from 'react-native';
import { atVeryEnd, pullProgress, type PullStart } from './end-pull';

/** A control that takes its own drag: a drag that starts on one is the control's. */
const OWN_DRAG = 'input,select,textarea,[role="slider"],[contenteditable="true"]';

/**
 * Web: a finger pulling up past the end of the essay asks for the next topic (`end-pull.ts`), and the value it returns
 * follows the pull from 0 to 1 for the end plate's meter. Only a finger: a mouse or pen drag on the text is selecting it.
 * Touch events, not pointer events, because the browser takes a vertical pan and cancels the pointer. Whether the page is
 * at its end is read from the scrollable node as the finger goes down, since the reader's own scroll record can trail it.
 * Undefined where nothing can pull: no way on, or a screen without touch.
 */
export function useEndPull(scroller: RefObject<unknown>, onPull: (() => void) | undefined): Animated.Value | undefined {
  const [pull] = useState(() => new Animated.Value(0));
  const latest = useRef(onPull);
  useEffect(() => {
    latest.current = onPull;
  }, [onPull]);
  const pulls = onPull !== undefined && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  useEffect(() => {
    if (!pulls) return undefined;
    const node = (scroller.current as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
    if (node === null || node === undefined) return undefined;
    let start: PullStart | undefined;
    const settle = () => {
      start = undefined;
      pull.setValue(0);
    };
    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      const own = event.target instanceof Element && event.target.closest(OWN_DRAG) !== null;
      if (event.touches.length !== 1 || touch === undefined || own) return settle();
      start = {
        x: touch.clientX,
        y: touch.clientY,
        atEnd: atVeryEnd(node.scrollTop, node.clientHeight, node.scrollHeight),
        screenWidth: window.innerWidth,
      };
    };
    const follow = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (start === undefined) return;
      if (event.touches.length !== 1 || touch === undefined) return settle();
      pull.setValue(pullProgress(start, touch.clientX, touch.clientY));
    };
    const finish = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      const pulled =
        start !== undefined && touch !== undefined && pullProgress(start, touch.clientX, touch.clientY) >= 1;
      settle();
      if (pulled) latest.current?.();
    };
    const listeners = [
      ['touchstart', begin],
      ['touchmove', follow],
      ['touchend', finish],
      ['touchcancel', settle],
    ] as const;
    for (const [name, listener] of listeners) node.addEventListener(name, listener, { passive: true });
    return () => {
      for (const [name, listener] of listeners) node.removeEventListener(name, listener);
    };
  }, [scroller, pull, pulls]);
  return pulls ? pull : undefined;
}
