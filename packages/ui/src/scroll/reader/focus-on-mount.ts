import { useEffect, type RefObject } from 'react';
import { AccessibilityInfo, type ViewInstance } from 'react-native';

/**
 * Native: moves the screen reader's focus to the view when it appears (or when `enabled` turns on).
 * A press that replaces the button it was made on would otherwise leave focus nowhere.
 */
export function useFocusOnMount(ref: RefObject<ViewInstance | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled || ref.current === null) return;
    AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
  }, [ref, enabled]);
}
