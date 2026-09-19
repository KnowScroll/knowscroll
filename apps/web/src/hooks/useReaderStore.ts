import { useSyncExternalStore } from 'react';
import type { ReaderState, ReaderStore } from '../state/readerStore.ts';

export function useReaderStore(store: ReaderStore): ReaderState {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getState(),
  );
}
