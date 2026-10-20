import { useEffect, useRef } from 'react';
import type { ScrollReadingObserver } from '../observer';
import { monotonicNow } from './visibility';

/** Web: the tab is visible (`visibilitychange`) and no overlay holds the reader (`paused`). */
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
    const apply = () => {
      const active = document.visibilityState !== 'hidden' && !pausedRef.current;
      if (active === lastRef.current) return;
      lastRef.current = active;
      observerRef.current?.onActivity({ active, at: monotonicNow() });
    };
    applyRef.current = apply;
    document.addEventListener('visibilitychange', apply);
    apply();
    return () => {
      document.removeEventListener('visibilitychange', apply);
      applyRef.current = () => undefined;
      if (lastRef.current === true) observerRef.current?.onActivity({ active: false, at: monotonicNow() });
      lastRef.current = null;
    };
  }, []);
}
