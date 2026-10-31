import { useEffect, type RefObject } from 'react';
import type { ViewInstance } from 'react-native';

/**
 * Web: focuses the element when it appears (or when `enabled` turns on). The element carries
 * `tabIndex={-1}`, so it takes focus from a script and never joins the Tab order. A press that replaces
 * the button it was made on would otherwise drop focus to the page.
 */
export function useFocusOnMount(ref: RefObject<ViewInstance | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    (ref.current as unknown as { focus?: () => void } | null)?.focus?.();
  }, [ref, enabled]);
}
