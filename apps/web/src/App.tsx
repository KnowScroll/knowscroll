import { useEffect, useMemo } from 'react';
import { ApiClient } from './api/client.ts';
import { PrivacyScreen } from './components/PrivacyScreen.tsx';
import { ScrollScreen } from './components/ScrollScreen.tsx';
import { SystemScreen } from './components/SystemScreen.tsx';
import { UniverseScreen } from './components/UniverseScreen.tsx';
import { useReaderStore } from './hooks/useReaderStore.ts';
import { ReaderStore } from './state/readerStore.ts';
import { createBrowserStorage } from './state/storage.ts';

export function App() {
  const storage = useMemo(() => createBrowserStorage(), []);
  const store = useMemo(() => new ReaderStore(new ApiClient(), storage), [storage]);
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
          <button type="button" className="pill ghost toast-dismiss" onClick={() => store.consumeToast()} aria-label="Dismiss message">
            Dismiss
          </button>
        </div>
      )}
      {state.screen === 'universe' && (
        <UniverseScreen
          state={state.universe}
          storage={storage}
          onEnterScroll={() => store.enterScroll()}
          onOpenTrace={trace => store.openTrace(trace)}
          onEnterSystem={() => store.enterSystem()}
          onOpenPrivacy={() => store.openPrivacy()}
          onRetry={() => store.retryUniverse()}
        />
      )}
      {state.screen === 'system' && (
        <SystemScreen state={state.system} onReturn={() => store.returnFromSystem()} onRetry={() => store.retrySystem()} onEnterScroll={() => store.enterScroll()} />
      )}
      {state.screen === 'privacy' && (
        <PrivacyScreen
          universe={state.universe}
          privacy={state.privacy}
          onReturn={() => store.closePrivacy()}
          onPause={() => store.pauseRecording()}
          onResume={() => store.resumeRecording()}
          onExport={() => store.requestExport()}
          onBeginReset={() => store.beginReset()}
          onCancelReset={() => store.cancelReset()}
          onConfirmReset={typed => store.confirmReset(typed)}
          onAcknowledgeReset={() => store.acknowledgeReset()}
          onEnterScroll={() => store.enterScroll()}
        />
      )}
      {(state.screen === 'scroll' || state.screen === 'revisit') && (
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
