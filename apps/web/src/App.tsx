import { useEffect, useMemo } from 'react';
import { ApiClient } from './api/client.ts';
import { ScrollScreen } from './components/ScrollScreen.tsx';
import { UniverseScreen } from './components/UniverseScreen.tsx';
import { useReaderStore } from './hooks/useReaderStore.ts';
import { ReaderStore } from './state/readerStore.ts';
import { createBrowserStorage } from './state/storage.ts';

export function App() {
  const store = useMemo(() => new ReaderStore(new ApiClient(), createBrowserStorage()), []);
  const state = useReaderStore(store);

  useEffect(() => {
    store.init();
  }, [store]);

  useEffect(() => {
    if (!state.toast) return undefined;
    const timeout = setTimeout(() => store.consumeToast(), 5000);
    return () => clearTimeout(timeout);
  }, [state.toast, store]);

  return (
    <div className="app-shell">
      {state.toast && (
        <div className="toast" role="status" aria-live="polite">
          {state.toast}
          <button type="button" className="ghost toast-dismiss" onClick={() => store.consumeToast()} aria-label="Dismiss message">
            Dismiss
          </button>
        </div>
      )}
      {state.screen === 'universe' ? (
        <UniverseScreen
          state={state.universe}
          onEnterScroll={() => store.enterScroll()}
          onOpenTrace={trace => store.openTrace(trace)}
          onRetry={() => store.retryUniverse()}
        />
      ) : (
        <ScrollScreen
          state={state.scroll}
          onVisible={assetId => store.onVisible(assetId)}
          onKeep={() => store.keep()}
          onNext={() => store.nextScroll()}
          onReturn={() => store.returnToUniverse()}
          onRetry={() => store.retryScrollLoad()}
          onReadingPosition={(assetId, position) => store.updateReadingPosition(assetId, position)}
        />
      )}
    </div>
  );
}
