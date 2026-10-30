import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** `unknown` is the state before the first event on some platforms; the app is then in front. */
const inForeground = (state: string | null | undefined): boolean => state !== 'background' && state !== 'inactive';

/**
 * Whether the app is in the foreground. On native this is `AppState`; react-native-web maps it to
 * the page's visibility, so a hidden browser tab reads as not active.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => inForeground(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(inForeground(state)));
    return () => subscription.remove();
  }, []);
  return active;
}
