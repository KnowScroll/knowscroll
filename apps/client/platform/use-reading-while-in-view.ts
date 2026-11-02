import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/** What a thread or conversation controller needs for its read position. */
interface ReadingController {
  readonly setActive: (active: boolean) => void;
  readonly refresh: () => Promise<void>;
}

/**
 * Tells a controller whether its messages are being looked at: the app is in the foreground and this screen is the
 * focused one. A screen kept under another (a Scroll opened from a thread) keeps its controller, but nothing that
 * arrives meanwhile may count as read: the position is stored, and the other person can be shown it as "seen"
 * (D-150), so marking it would say the person saw what they did not. Coming back marks what is there, and a return
 * to the foreground reads again.
 */
export function useReadingWhileInView(controller: ReadingController): void {
  const focused = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const sync = useCallback(() => controller.setActive(focused.current && foreground.current), [controller]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      sync();
      return () => {
        focused.current = false;
        sync();
      };
    }, [sync]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      foreground.current = next === 'active';
      sync();
      if (next === 'active') void controller.refresh();
    });
    return () => {
      subscription.remove();
      controller.setActive(false);
    };
  }, [controller, sync]);
}
