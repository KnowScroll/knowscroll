import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from './api/client.ts';
import { KeepScreen } from './components/KeepScreen.tsx';
import { AtlasScreen } from './components/AtlasScreen.tsx';
import { BranchPanel } from './components/BranchPanel.tsx';
import { PrivacyScreen } from './components/PrivacyScreen.tsx';
import { ReelPlayer } from './components/ReelPlayer.tsx';
import { EncounterGesture } from './components/EncounterGesture.tsx';
import { ScrollScreen } from './components/ScrollScreen.tsx';
import { UniverseScreen } from './components/UniverseScreen.tsx';
import { useReaderStore } from './hooks/useReaderStore.ts';
import { ReaderStore } from './state/readerStore.ts';
import { createBrowserStorage, type ReaderStorage } from './state/storage.ts';
import { OriginExperience, type OriginEnd } from './cosmos/OriginExperience.tsx';
import { hasSeenOrigin, markOriginSeen } from './cosmos/originStorage.ts';
import { usePrefersReducedMotion } from './cosmos/usePrefersReducedMotion.ts';

export interface AppProps {
  /** Owned by `Root` (#135): the one `ApiClient` instance for the whole page, so the CSRF token
   * `SignInPage` fed it (or that a lazy 403 discovers) survives every reader action without a
   * reload. `App` never constructs its own -- Root is the only place a bare `new ApiClient()` is
   * still built, matching the pre-#135 default this class's own tests never exercised directly. */
  apiClient: ApiClient;
  /** Fired on a 401 from any authenticated call, a real sign-out, or a real account deletion
   * (`ReaderStore`'s own `onSignedOut`, forwarded verbatim, including its `verify` argument --
   * see that class's doc comment) -- `Root` uses it to swap this whole reader tree for the
   * signed-out screen. */
  onSignedOut: (message: string | null, verify: boolean) => void;
}

/**
 * ADR-0049 §5: the opening plays for a first visit only. A browser that finished or skipped it, a
 * reader restored into a Scroll, or one this browser already knows (an observed universe) goes
 * straight to their Universe; the opening stays available to replay from there.
 */
function offersOrigin(storage: ReaderStorage): boolean {
  if (hasSeenOrigin()) return false;
  const screen = storage.readScreen();
  if (screen === 'scroll' || screen === 'revisit') return false;
  return storage.readObservedUniverseId() === '';
}

function findSeedTarget() {
  const target = document.querySelector('[data-origin-target]');
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (rect.width === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, radius: rect.width / 2 };
}

export function App({ apiClient, onSignedOut }: AppProps) {
  const storage = useMemo(() => createBrowserStorage(), []);
  const store = useMemo(() => new ReaderStore(apiClient, storage, onSignedOut), [apiClient, storage, onSignedOut]);
  const state = useReaderStore(store);
  const reducedMotion = usePrefersReducedMotion();
  const [origin, setOrigin] = useState<'off' | 'first' | 'replay'>(() => (offersOrigin(storage) ? 'first' : 'off'));
  const [originDismiss, setOriginDismiss] = useState<'returning' | 'unavailable' | null>(null);
  const [sealed, setSealed] = useState(origin !== 'off');
  // Until the bootstrap (and the sky) say whether this reader already has history, the opening holds
  // a dark frame; a slow network starts it anyway after 2.5 s and it can still step aside later.
  const [holdExpired, setHoldExpired] = useState(false);
  useEffect(() => {
    if (origin !== 'first') return undefined;
    const timer = setTimeout(() => setHoldExpired(true), 2500);
    return () => clearTimeout(timer);
  }, [origin]);
  const historyKnown = state.universe.status === 'unavailable'
    || (state.universe.status === 'loaded'
      && (state.universe.universe.traces.length > 0 || state.sky.status === 'loaded' || state.sky.status === 'unavailable'));
  // A returning reader is recognised during render, not one effect later, so the hold never drops
  // for them and no frame of the story or its controls is drawn.
  const returningNow = origin === 'first' && (
    (state.universe.status === 'loaded' && state.universe.universe.traces.length > 0)
    || (state.sky.status === 'loaded' && state.sky.response.places.length > 0)
    || state.screen === 'scroll' || state.screen === 'revisit');
  const unavailableNow = origin === 'first' && state.universe.status === 'unavailable';
  const holdOrigin = origin === 'first' && ((!historyKnown && !holdExpired) || returningNow || unavailableNow);

  // A first visit that turns out to be a returning reader (history already recorded) or an
  // unavailable Universe gives way at once, before the story has really begun.
  useEffect(() => {
    if (origin !== 'first' || originDismiss) return;
    if (state.universe.status === 'unavailable') setOriginDismiss('unavailable');
    else if (state.universe.status === 'loaded' && state.universe.universe.traces.length > 0) setOriginDismiss('returning');
    else if (state.sky.status === 'loaded' && state.sky.response.places.length > 0) setOriginDismiss('returning');
    else if (state.screen === 'scroll' || state.screen === 'revisit') setOriginDismiss('returning');
  }, [origin, originDismiss, state.universe, state.sky, state.screen]);

  const endOrigin = useCallback((reason: OriginEnd) => {
    // Called while the overlay is still mounted: was the reader using the keyboard in it?
    const keyboard = !!document.querySelector('.origin--keyboard');
    if (reason !== 'failed' || originDismiss !== 'unavailable') markOriginSeen();
    setOrigin('off');
    setOriginDismiss(null);
    setSealed(false);
    // A keyboard reader's focus continues in the Universe: the first thing to explore, else its main
    // action. Pointer viewers are left as they were, with no focus ring drawn onto the scene.
    if (keyboard) requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('[data-origin-target], .universe-bodies-nav button, .universe-cta');
      target?.focus({ preventScroll: true });
    });
  }, [originDismiss]);
  const unseal = useCallback(() => setSealed(false), []);
  const replayOrigin = useCallback(() => {
    setOriginDismiss(null);
    setSealed(true);
    setOrigin('replay');
  }, []);

  useEffect(() => {
    store.init();
  }, [store]);

  useEffect(() => {
    if (!state.toast) return undefined;
    const timeout = setTimeout(() => store.consumeToast(), 5000);
    return () => clearTimeout(timeout);
  }, [state.toast, store]);

  const branchView = state.branches;
  const branchChoices = branchView.status === 'loaded' ? branchView.branches : [];
  const canReturnAlongBranch = state.scroll.status === 'reading' && state.scroll.origin.type === 'branch';
  const branchPanel = state.screen === 'scroll' && state.scroll.status === 'reading' ? (
    <BranchPanel
      key={state.scroll.item.assetId}
      choices={branchChoices}
      status={branchView.status === 'loaded' && branchView.opening ? 'opening' : branchView.status}
      error={branchView.status === 'loaded' ? branchView.error : branchView.status === 'unavailable' ? branchView.message : null}
      canOpen={branchView.status === 'loaded' && branchView.canOpen}
      canReturn={canReturnAlongBranch}
      onExplore={() => store.refreshBranches()}
      onOpen={branchId => store.openBranch(branchId)}
      onReturn={() => store.returnAlongBranch()}
    />
  ) : undefined;
  const canExploreCurrent = state.scroll.status === 'reading' && !(state.scroll.origin.type === 'branch' && !state.scroll.origin.recorded);
  const openFirstBranch = branchView.status === 'loaded' && branchView.canOpen && branchChoices.length > 0
    ? () => store.openBranch(branchChoices[0]!.branchId)
    : canExploreCurrent && (branchView.status === 'idle' || branchView.status === 'unavailable')
      ? () => store.refreshBranches()
      : undefined;
  const branchForwardLabel = branchView.status === 'loaded' ? 'Follow connection' : 'Find connections';
  const returnBranch = canReturnAlongBranch ? () => store.returnAlongBranch() : undefined;

  const scrollScreen = (
    <ScrollScreen
      state={state.scroll}
      onVisible={assetId => store.onVisible(assetId)}
      onKeep={() => store.keep()}
      onOpenKeep={() => store.openKeep()}
      onNext={() => store.nextScroll()}
      onReturn={() => store.returnToUniverse()}
      onReturnBranch={() => store.returnAlongBranch()}
      onRetry={() => store.retryScrollLoad()}
      onReadingPosition={(assetId, position) => store.updateReadingPosition(assetId, position)}
      why={state.why}
      onOpenWhy={() => store.openWhy()}
      onCloseWhy={() => store.closeWhy()}
      onRetryWhy={() => store.retryWhy()}
      onCorrect={kind => store.correctEncounter(kind)}
      branchPanel={branchPanel}
      representation={store.currentRepresentation()}
      onSwitchRepresentation={kind => store.switchRepresentation(kind)}
    />
  );

  return (
    <>
    {origin !== 'off' && (
      <OriginExperience
        key={origin}
        reducedMotion={reducedMotion}
        findSeedTarget={findSeedTarget}
        dismiss={originDismiss ?? (returningNow ? 'returning' : unavailableNow ? 'unavailable' : null)}
        hold={holdOrigin}
        onHandoff={unseal}
        onEnd={endOrigin}
      />
    )}
    <div className="app-shell" data-screen={state.screen} inert={sealed}>
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
          sky={state.sky}
          reducedMotion={reducedMotion}
          onRetrySky={() => store.retrySky()}
          onReadFrom={(placeId, name) => store.enterPlace(placeId, name)}
          onSetAside={placeId => store.setAsideStar(placeId)}
          onReplayOrigin={replayOrigin}
          onEnterScroll={() => store.enterScroll()}
          onEnterTestReels={import.meta.env.VITE_KS_TEST_REELS === '1' ? () => store.enterTestReels() : undefined}
          onEnterRichScrolls={import.meta.env.VITE_KS_RICH_SCROLL_PREVIEW === '1' ? () => store.enterRichScrolls() : undefined}
          onOpenTrace={trace => store.openTrace(trace)}
          onEnterSystem={() => store.enterAtlas()}
          onOpenPrivacy={() => store.openPrivacy()}
          onOpenKeep={() => store.openKeep()}
          onRetry={() => store.retryUniverse()}
        />
      )}
      {state.screen === 'atlas' && state.atlas.status !== 'idle' && (
        <AtlasScreen
          state={state.atlas}
          onReturn={() => store.returnFromAtlas()}
          onRetry={() => store.retryAtlas()}
          onSetAside={placeId => store.setAsideAtlasPlace(placeId)}
        />
      )}
      {state.screen === 'keep' && <KeepScreen state={state.universe} onReturn={() => store.returnToUniverse()} onEnterScroll={() => store.enterScroll()} onOpenTrace={trace => store.openTrace(trace)} />}
      {state.screen === 'privacy' && (
        <PrivacyScreen
          universe={state.universe}
          privacy={state.privacy}
          onOpenKeep={() => store.openKeep()}
          onReturn={() => store.closePrivacy()}
          onPause={() => store.pauseRecording()}
          onResume={() => store.resumeRecording()}
          onExport={() => store.requestExport()}
          onBeginReset={() => store.beginReset()}
          onCancelReset={() => store.cancelReset()}
          onConfirmReset={typed => store.confirmReset(typed)}
          onAcknowledgeReset={() => store.acknowledgeReset()}
          onEnterScroll={() => store.enterScroll()}
          onSignOut={() => store.signOut()}
          onBeginDeleteAccount={() => store.beginDeleteAccount()}
          onCancelDeleteAccount={() => store.cancelDeleteAccount()}
          onConfirmDeleteAccount={typed => store.confirmDeleteAccount(typed)}
        />
      )}
      {state.screen === 'scroll' && state.scroll.status === 'reading' && state.scroll.item.kind === 'Reel' && (
        <EncounterGesture onNext={() => store.nextScroll()} onBranchNext={openFirstBranch} onBranchPrevious={returnBranch} branchNextLabel={branchForwardLabel}>
        <ReelPlayer
          key={state.scroll.item.assetId}
          item={state.scroll.item}
          active={state.scroll.discovery !== 'loading'}
          onVisible={assetId => store.onVisible(assetId)}
          onKeep={() => store.keep()}
          onNext={() => store.nextScroll()}
          onReturn={() => store.returnToUniverse()}
          keepStatus={state.scroll.keep.status === 'conflict' ? 'failed' : state.scroll.keep.status === 'failed' ? 'failed' : state.scroll.keep.status}
          why={state.why}
          onOpenWhy={() => store.openWhy()}
          onCloseWhy={() => store.closeWhy()}
          onRetryWhy={() => store.retryWhy()}
          onCorrect={kind => store.correctEncounter(kind)}
          branchPanel={branchPanel}
          onSwitchRepresentation={kind => store.switchRepresentation(kind)}
          onBranchNext={openFirstBranch}
          branchNextLabel={branchForwardLabel}
        />
        </EncounterGesture>
      )}
      {(state.screen === 'revisit' || (state.screen === 'scroll' && !(state.scroll.status === 'reading' && state.scroll.item.kind === 'Reel'))) && (
        state.screen === 'scroll' && state.scroll.status === 'reading'
          ? <EncounterGesture onNext={() => store.nextScroll()} onBranchNext={openFirstBranch} onBranchPrevious={returnBranch} branchNextLabel={branchForwardLabel} keyboardNavigation={false}>{scrollScreen}</EncounterGesture>
          : scrollScreen
      )}
    </div>
    </>
  );
}
