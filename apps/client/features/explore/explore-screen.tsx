import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope } from '@knowscroll/client-core';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, ErrorState, OfflineState, Skeleton, StateBlock, Text, useDisplay } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useDocumentTitle } from '../../platform/document-title';
import { EncounterChrome, EncounterMenu } from '../encounter/encounter-chrome';
import { EncounterView } from '../encounter/encounter-view';
import { EncounterGestures } from '../encounter/gestures/encounter-gestures';
import { useEncounterBack } from '../encounter/use-encounter-back';
import { useEncounterSession } from '../encounter/use-encounter-session';
import { useEncounterContext } from '../encounter/use-encounter-context';
import { usesRail } from '../shell/app-navigation';
import { ReelPage } from '../reel/reel-page';
import { FirstArrivalScreen } from './first-arrival-screen';

/** A Scroll owns its reading viewport. Only Reel pages need a surrounding normal-flow scroller. */
function EncounterPage({ reading, children }: { readonly reading: boolean; readonly children: ReactNode }) {
  return reading ? (
    <View testID="encounter-page" style={styles.readingPage}>
      {children}
    </View>
  ) : (
    <ReelPage testID="encounter-page">{children}</ReelPage>
  );
}

export function SignedInExplore({ scope }: { readonly scope: AccountScope }) {
  const { session, state } = useEncounterSession(scope);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const railed = usesRail(useDisplay().breakpoint);
  const [foreground, setForeground] = useState(false);
  useEncounterContext(scope, session, state.entry, foreground);
  const [hint, setHint] = useState(() => scope.storage.get('explore.hint.dismissed') !== '1');
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
  const back = useEncounterBack(session, foreground);
  useEffect(() => {
    if (state.phase === 'stale') session.park();
  }, [session, state.phase]);
  const backOrRoot = () => {
    if (!back() && router.canGoBack()) router.back();
  };
  const entry = state.entry;
  const hasReadyDirection =
    entry && Object.values(entry.context.continuations).some((direction) => direction.status === 'ready');
  const showEntry = entry && state.phase !== 'revoked';
  return (
    <View
      style={[
        styles.ground,
        {
          paddingTop: insets.top,
          paddingBottom: (railed ? 0 : layout.tabBarSlot) + insets.bottom,
          paddingLeft: railed ? 0 : insets.left,
          paddingRight: insets.right,
        },
      ]}
      testID="encounter-explore"
    >
      <EncounterPage reading={entry?.kind === 'scroll'}>
        {showEntry ? (
          <>
            <EncounterChrome state={state} session={session} back={backOrRoot} />
            <EncounterView
              key={`${entry.exposureId}:${String(state.surfaceRevision)}`}
              scope={scope}
              entry={entry}
              state={state}
              session={session}
              foreground={foreground}
            />
            {entry.kind === 'scroll' ? <EncounterGestures scroll onMove={(move) => session.gesture(move)} /> : null}
            <View testID="encounter-subject-navigation" style={styles.buttons}>
              <Button
                label="Previous subject"
                size="sm"
                variant="ghost"
                disabled={state.phase !== 'active' || state.actionFailed}
                onPress={() => session.navigate({ mode: 'vertical', direction: 'previous' })}
              />
              <Button
                label="Next subject"
                size="sm"
                variant="ghost"
                disabled={state.phase !== 'active' || state.actionFailed}
                onPress={() => session.navigate({ mode: 'vertical', direction: 'next' })}
              />
              <Button
                label={hasReadyDirection ? 'Continue this idea' : 'Your path'}
                size="sm"
                variant={hasReadyDirection ? 'continue' : 'ghost'}
                onPress={() => session.setOverlay(true)}
              />
            </View>
          </>
        ) : null}
        {hint && showEntry ? (
          <View accessibilityLabel="How to move around" role="note" style={styles.hint}>
            <Text variant="ui">
              Use Next subject for something new. Continue this idea follows ready Parts or Related directions.
            </Text>
            <Text variant="meta">
              Swipe up on a Reel for something new, or sideways to continue. Scrolls read vertically. Every move also
              has a button.
            </Text>
            <Button
              label="Got it"
              size="sm"
              onPress={() => {
                if (scope.active) scope.storage.set('explore.hint.dismissed', '1');
                setHint(false);
              }}
            />
          </View>
        ) : null}
        {['opening', 'ready_offer', 'activating'].includes(state.phase) ? (
          <Skeleton rows={2} label="Opening your encounter" />
        ) : null}
        {state.phase === 'keep_blocked' ? (
          <StateBlock
            title="Your saved place needs attention"
            body="It changed or couldn't be checked. No saved position has been applied."
            actions={[
              { label: 'Start from the top', onPress: () => session.startKeepFromTop(), variant: 'primary' },
              {
                label: 'Return to Keep',
                onPress: () => {
                  if (session.leaveKeep()) router.navigate('/saved');
                },
                variant: 'default',
              },
            ]}
          />
        ) : null}
        {state.phase === 'offline' ? (
          <OfflineState
            body="Your place is kept. Retry the same move when you're connected."
            onRetry={() => session.retry()}
          />
        ) : null}
        {state.phase === 'error' ? (
          <ErrorState title="Couldn't open that encounter" body="Your place is kept." onRetry={() => session.retry()} />
        ) : null}
        {state.phase === 'pending' ? (
          <Banner
            kind="info"
            lead="Nothing new is ready yet."
            message="Your current encounter stays here. Check again when you choose."
          />
        ) : null}
        {state.phase === 'exhausted' ? (
          <StateBlock
            title="A good place to stop"
            body="There are no more ready encounters in that direction. Your way back stays in Keep when saved."
            actions={[
              { label: 'Explore again', onPress: () => session.open({ kind: 'discover' }), variant: 'primary' },
            ]}
          />
        ) : null}
        {state.phase === 'stale' ? (
          <StateBlock
            title="Your path changed"
            body={
              entry
                ? 'Refresh current directions, then choose your next move again.'
                : 'That offer is no longer ready. Choose something new when you want.'
            }
            actions={[
              {
                label: !entry
                  ? 'Choose something new'
                  : state.contextReady
                    ? 'Review current directions'
                    : 'Refresh current directions',
                onPress: () => {
                  if (!entry) session.open({ kind: 'discover' });
                  else if (state.contextReady) session.acknowledgeStale();
                  else void session.refreshContext();
                },
                variant: 'primary',
              },
            ]}
          />
        ) : null}
        {state.phase === 'revoked' ? (
          <StateBlock
            title="This encounter isn't available"
            body="It may have been withdrawn, or your access changed."
            actions={[
              {
                label: 'Go to Keep',
                href: '/saved',
                role: 'link',
                onPress: () => router.navigate('/saved'),
                variant: 'primary',
              },
              { label: 'Find something new', onPress: () => session.open({ kind: 'discover' }), variant: 'default' },
            ]}
          />
        ) : null}
        {(state.phase === 'pending' || state.phase === 'exhausted') && entry ? (
          <Button label="Return to this encounter" onPress={() => session.resumeCurrent()} />
        ) : null}
        {state.phase === 'pending' ? (
          <Button label="Check for a ready encounter" onPress={() => session.open({ kind: 'discover' })} />
        ) : null}
      </EncounterPage>
      <EncounterMenu state={state} session={session} />
    </View>
  );
}
export function ExploreScreen() {
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <SignedInExplore scope={state.scope} />;
  return <FirstArrivalScreen />;
}
const styles = StyleSheet.create({
  ground: { flex: 1, minHeight: 0, backgroundColor: content.paper },
  readingPage: { flex: 1, minHeight: 0 },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  hint: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: 1,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
});
