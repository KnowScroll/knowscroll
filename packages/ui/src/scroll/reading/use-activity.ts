import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { ScrollReadingObserver } from '../observer';
import { monotonicNow } from './visibility';

/**
 * Reports whether the article is being read: native, the app is in the foreground (`AppState`)
 * and no overlay holds the reader (`paused`). The web file uses `visibilitychange`. The first
 * state is reported when the article mounts, and `active: false` when it unmounts, so the
 * recorder never counts time the article was not on screen.
 */
export function useArticleActivity(observer: ScrollReadingObserver | undefined, paused: boolean): void {
  const observerRef = useRef(observer);
  const pausedRef = useRef(paused);
  const lastRef = useRef<boolean | null>(null);
  const applyRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (observerRef.current !== observer) {
      if (lastRef.current === true) observerRef.current?.onActivity({ active: false, at: monotonicNow() });
      lastRef.current = null;
      observerRef.current = observer;
    }
    pausedRef.current = paused;
    applyRef.current();
  });

  useEffect(() => {
    let foreground = AppState.currentState === 'active';
    const apply = () => {
      const active = foreground && !pausedRef.current;
      if (active === lastRef.current) return;
      lastRef.current = active;
      observerRef.current?.onActivity({ active, at: monotonicNow() });
    };
    applyRef.current = apply;
    const subscription = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      apply();
    });
    apply();
    return () => {
      subscription.remove();
      applyRef.current = () => undefined;
      if (lastRef.current === true) observerRef.current?.onActivity({ active: false, at: monotonicNow() });
      lastRef.current = null;
    };
  }, []);
}
