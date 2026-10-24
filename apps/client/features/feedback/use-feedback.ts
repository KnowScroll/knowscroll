import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { feedbackFor, type AccountScope, type FeedbackState, type FeedbackStore } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';

/**
 * The scope's feedback store. Opening any surface that can report wakes it, so a report kept from an
 * earlier run (no connection then) is sent now.
 */
export function useFeedbackStore(scope: AccountScope): FeedbackStore {
  const store = feedbackFor({ scope, newId: newCommandId });
  useEffect(() => {
    store.resume();
  }, [store]);
  return store;
}

export function useFeedbackState(store: FeedbackStore): FeedbackState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * Runs "Not interested" from the menu and reports whether it is saving or failed. The caller moves on
 * to the next subject when it is saved, which closes the sheet; a failure stays in the menu with its Retry.
 */
export function useNotInterested(run: (() => Promise<boolean>) | undefined) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    saving,
    failed,
    run: () => {
      if (run === undefined || saving) return;
      setSaving(true);
      setFailed(false);
      void run().then((saved) => {
        // Saved: the screen is moving on and closes the sheet, so the row stays busy rather than saving twice.
        if (!mounted.current || saved) return;
        setSaving(false);
        setFailed(true);
      });
    },
  };
}
