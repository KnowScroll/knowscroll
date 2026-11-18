import { useEffect, type RefObject } from 'react';

/** What the person does to the page that scrolling by the page itself never does. */
const PERSON_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const;

function scrollableNodeOf(scroller: RefObject<unknown>): HTMLElement | null | undefined {
  return (scroller.current as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
}

/**
 * Web: calls `onInput` when the person wheels, touches or presses on the scroller. React Native Web has no drag event
 * for a wheel or a trackpad, and a scroll event cannot tell the person from the page moving.
 */
export function usePersonInput(scroller: RefObject<unknown>, onInput: () => void): void {
  useEffect(() => {
    const node = scrollableNodeOf(scroller);
    if (node === null || node === undefined) return undefined;
    for (const name of PERSON_EVENTS) node.addEventListener(name, onInput, { passive: true });
    return () => {
      for (const name of PERSON_EVENTS) node.removeEventListener(name, onInput);
    };
  }, [scroller, onInput]);
}

/**
 * Web: stops a smooth scroll the reader started (Home, End, an arrow key) where it has got to, so the person's wheel
 * takes over from there; without it a wheel turned in the first second after End is undone. It calls the element's own
 * `scroll`: React Native Web puts its own `scrollTo` on the node, which reads `{ y, animated }` and would start another
 * smooth scroll to the top.
 */
export function stopScrolling(scroller: RefObject<unknown>): void {
  const node = scrollableNodeOf(scroller);
  node?.scroll({ top: node.scrollTop, behavior: 'instant' });
}
