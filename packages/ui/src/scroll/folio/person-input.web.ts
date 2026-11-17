import { useEffect, type RefObject } from 'react';

/** What the person does to the page that scrolling by the page itself never does. */
const PERSON_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const;

/**
 * Web: calls `onInput` when the person wheels, touches or presses on the scroller. React Native Web has no drag event
 * for a wheel or a trackpad, and a scroll event cannot tell the person from the page moving.
 */
export function usePersonInput(scroller: RefObject<unknown>, onInput: () => void): void {
  useEffect(() => {
    const node = (scroller.current as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
    if (node === null || node === undefined) return undefined;
    for (const name of PERSON_EVENTS) node.addEventListener(name, onInput, { passive: true });
    return () => {
      for (const name of PERSON_EVENTS) node.removeEventListener(name, onInput);
    };
  }, [scroller, onInput]);
}
