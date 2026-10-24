import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope } from '@knowscroll/client-core';
import { content, layout } from '@knowscroll/design-tokens';
import { Skeleton } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useDocumentTitle } from '../../platform/document-title';
import type { EncounterEntry } from '../encounter/encounter-history';
import { EncounterEnding } from '../encounter/encounter-ending';
import { EncounterSheets } from '../encounter/encounter-sheets';
import { EncounterStateScreen } from '../encounter/encounter-states';
import { EncounterView } from '../encounter/encounter-view';
import { useEncounterBack } from '../encounter/use-encounter-back';
import { useEncounterContext } from '../encounter/use-encounter-context';
import { useEncounterSession } from '../encounter/use-encounter-session';
import { railWidth, usesRail } from '../shell/app-navigation';
import { ReelPage } from '../reel/reel-page';
import { useDisplay } from '@knowscroll/ui';
import { ReelFrame } from './reel-frame';
import { FirstArrivalHint } from './first-arrival-hint';
import { FirstArrivalScreen } from './first-arrival-screen';
import { asideWidthFor, ThreadAside } from './thread-aside';

/** A Scroll owns its reading viewport. Only Reel pages need the measured page around the stage. */
function EncounterPage({ reading, children }: { readonly reading: boolean; readonly children: ReactNode }) {
  return reading ? (
    <View testID="encounter-page" style={styles.fill}>
      {children}
    </View>
  ) : (
    <ReelPage testID="encounter-page">{children}</ReelPage>
  );
}

/** Phases that keep the current Reel or Scroll on screen: playing, or opening the next one over it. */
const SURFACE_PHASES = new Set(['active', 'opening', 'ready_offer', 'activating']);

const HINTS = {
  reel: {
    lines: [
      { icon: 'arrowUp', text: 'Swipe up for something new' },
      { icon: 'arrowRight', text: 'Go deeper with the tab on the right' },
    ],
    footnote: 'Prefer buttons? The ⋯ menu and the yellow edge tab do the same.',
  },
  scroll: {
    lines: [
      { icon: 'arrowDown', text: 'Read down the page' },
      { icon: 'arrowRight', text: 'Go deeper at the end of the Scroll' },
    ],
    footnote: 'Prefer buttons? The ⋯ menu has every move.',
  },
} as const;

export function SignedInExplore({ scope }: { readonly scope: AccountScope }) {
  const { session, state } = useEncounterSession(scope);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { breakpoint } = useDisplay();
  const { width: windowWidth } = useWindowDimensions();
  const railed = usesRail(breakpoint);
  const desktop = breakpoint === 'desktop';
  const [foreground, setForeground] = useState(false);
  // "Done for now" belongs to the entry it was chosen on; any other state or entry shows its own screen.
  const [calmedEntry, setCalmedEntry] = useState<EncounterEntry>();
  useEncounterContext(scope, session, state.entry, foreground);
  const [hintOpen, setHintOpen] = useState(() => scope.storage.get('explore.hint.dismissed') !== '1');
  useDocumentTitle(state.entry?.offer.metadata.title ?? 'Explore');
  useFocusEffect(
    useCallback(() => {
      const activity = (active: boolean) => {
        session.setForeground(active);
        setForeground(active);
      };
      activity(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => activity(value === 'active'));
      if (session.getState().phase === 'idle') session.open({ kind: 'discover' });
      else void session.refreshContext();
      return () => {
        activity(false);
        listener.remove();
      };
    }, [session]),
  );
  const onMedia = state.entry?.kind === 'reel' && SURFACE_PHASES.has(state.phase);
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle(onMedia ? 'light' : 'dark');
    }, [onMedia]),
  );
  const back = useEncounterBack(session, foreground);
  useEffect(() => {
    if (state.phase === 'stale') session.park();
  }, [session, state.phase]);
  const backOrRoot = () => {
    if (!back() && router.canGoBack()) router.back();
  };
  const entry = state.entry;
  const calm = state.phase === 'exhausted' && entry !== undefined && calmedEntry === entry;
  const showSurface = entry !== undefined && SURFACE_PHASES.has(state.phase);
  const opening = state.phase !== 'active';
  // The thread sits beside the encounter from 768 px up (V01, D01); the desktop Reel is a card (D01).
  const asideWidth = showSurface && railed ? asideWidthFor(windowWidth) : 0;
  const framedReel = showSurface && desktop && entry.kind === 'reel';
  // The swipe hint is written for touch; a desktop Reel shows its keys under the card instead.
  const hint =
    hintOpen && showSurface && !framedReel ? (
      <FirstArrivalHint
        {...HINTS[entry.kind]}
        lines={HINTS[entry.kind].lines}
        onDismiss={() => {
          if (scope.active) scope.storage.set('explore.hint.dismissed', '1');
          setHintOpen(false);
        }}
      />
    ) : null;
  const ground = !showSurface
    ? state.phase === 'exhausted' && entry && !calm
      ? content.continue
      : content.paper
    : entry.kind === 'reel' && !framedReel
      ? content.ink
      : content.paper;
  const encounterView = (framed: boolean) =>
    entry === undefined ? null : (
      <EncounterView
        key={`${entry.exposureId}:${String(state.surfaceRevision)}`}
        scope={scope}
        entry={entry}
        state={state}
        session={session}
        foreground={foreground}
        back={backOrRoot}
        hint={hint}
        framed={framed}
      />
    );
  const openingNotice = opening ? (
    <View style={styles.opening} pointerEvents="none">
      <Skeleton rows={1} label="Opening your next encounter" />
    </View>
  ) : null;
  return (
    <View
      style={[
        styles.ground,
        { backgroundColor: ground, paddingLeft: railed ? 0 : insets.left, paddingRight: insets.right },
      ]}
      testID="encounter-explore"
    >
      <View role="main" style={styles.main}>
        {showSurface ? (
          <EncounterPage reading={entry.kind === 'scroll'}>
            <View style={styles.centered}>
              {entry.kind === 'reel' ? (
                <ReelFrame
                  entry={entry}
                  state={state}
                  session={session}
                  framed={framedReel}
                  areaWidth={windowWidth - railWidth(breakpoint) - asideWidth}
                >
                  {encounterView(framedReel)}
                  {openingNotice}
                </ReelFrame>
              ) : (
                <View style={styles.readingColumn}>
                  {encounterView(false)}
                  {openingNotice}
                </View>
              )}
            </View>
          </EncounterPage>
        ) : state.phase === 'exhausted' && entry && !calm ? (
          <EncounterEnding entry={entry} state={state} session={session} onDone={() => setCalmedEntry(entry)} />
        ) : (
          <EncounterStateScreen
            state={state}
            session={session}
            calm={calm}
            onLeaveCalm={() => setCalmedEntry(undefined)}
          />
        )}
      </View>
      {asideWidth > 0 && showSurface ? (
        <ThreadAside entry={entry} state={state} session={session} width={asideWidth} />
      ) : null}
      <EncounterSheets state={state} session={session} />
    </View>
  );
}
export function ExploreScreen() {
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <SignedInExplore scope={state.scope} />;
  return <FirstArrivalScreen />;
}
const styles = StyleSheet.create({
  ground: { flex: 1, minHeight: 0, flexDirection: 'row' },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  fill: { flex: 1, minHeight: 0 },
  centered: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center' },
  readingColumn: { flex: 1, minHeight: 0, width: '100%', maxWidth: layout.measureDesktop + 2 * layout.gutter },
  opening: { position: 'absolute', top: '45%', left: 24, right: 24 },
});
