import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope } from '@knowscroll/client-core';
import { Button, Skeleton, Text, useDisplay } from '@knowscroll/ui';
import { space, spacing } from '@knowscroll/design-tokens';
import { useAccountScope } from '../../providers/account-scope';
import { useDocumentTitle } from '../../platform/document-title';
import { EmptyUniverseScreen } from './empty-universe-screen';
import { FormationPresentation } from './formation-presentation';
import { UniverseBackdrop } from './universe-backdrop';
import { indexUniverse } from './universe-layout';
import { UniverseSurface } from './universe-surface';
import { useUniverseBack } from './use-universe-back';
import { useUniverseSession } from './use-universe-session';

/** A quiet, honest word over the map while it catches up; never a percentage or a count. */
function statusOf(state: ReturnType<typeof useUniverseSession>['state']): string | undefined {
  const { read } = state;
  if (read.status === 'empty') return undefined;
  if (read.status === 'loading' && read.snapshot) return 'Drawing…';
  if (read.status === 'lagging') return 'Drawing…';
  if (read.snapshot && read.status !== 'ready') return 'Last map shown';
  return undefined;
}

export function SignedInUniverse({ scope }: { scope: AccountScope }) {
  const { reducedMotion } = useDisplay(),
    { session, state } = useUniverseSession(scope, reducedMotion),
    router = useRouter(),
    { focus: focusParam } = useLocalSearchParams<{ focus?: string }>();
  const [foreground, setForeground] = useState(false);
  useDocumentTitle('Universe · KnowScroll');
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      const active = (value: boolean) => {
        session.setForeground(value);
        setForeground(value);
      };
      active(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => active(value === 'active'));
      return () => {
        active(false);
        listener.remove();
      };
    }, [session]),
  );
  useUniverseBack(session, foreground);
  const { read } = state;
  const snapshot = read.snapshot;
  const index = useMemo(
    () =>
      indexUniverse(
        snapshot?.chunks.flatMap((chunk) => chunk.objects) ?? [],
        snapshot?.chunks.flatMap((chunk) => chunk.routes) ?? [],
      ),
    [snapshot],
  );
  // `?focus=last` puts the ship at the last place once, when the map first has something to fly to.
  const flown = useRef(false);
  useEffect(() => {
    if (focusParam !== 'last' || flown.current || !foreground || !snapshot) return;
    flown.current = true;
    session.focusLast();
  }, [focusParam, foreground, snapshot, session]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !foreground || state.overlay || !state.focusId) return;
    // A region, planet or system with its own target gets focus; a planet's own close-up is the map itself.
    (
      document.querySelector<HTMLElement>(`[data-testid="universe-focus-${state.focusId}"]`) ??
      document.querySelector<HTMLElement>('[data-testid="universe-map"]')
    )?.focus();
  }, [foreground, state.overlay, state.focusId, state.historyDepth]);

  const dust = state.dust.cues.length > 0;
  if (read.status === 'empty' && !dust)
    return state.dust.status === 'idle' || state.dust.status === 'loading' ? (
      <QuietGround label="Looking at your universe" />
    ) : (
      <EmptyUniverseScreen />
    );
  if (!snapshot && read.status !== 'empty')
    return <Unavailable session={session} state={state} onExplore={() => router.navigate('/explore')} />;
  return (
    <>
      <UniverseSurface session={session} state={state} index={index} status={statusOf(state)} />
      <FormationPresentation session={session} />
    </>
  );
}

function QuietGround({ label }: { label: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.ground, { paddingTop: insets.top + spacing[6] }]}>
      <UniverseBackdrop />
      <View style={styles.centred}>
        <Skeleton rows={2} label={label} />
      </View>
    </View>
  );
}

/** No map to draw: loading, offline, no longer permitted or a drawing this app cannot read. */
function Unavailable({
  session,
  state,
  onExplore,
}: {
  session: ReturnType<typeof useUniverseSession>['session'];
  state: ReturnType<typeof useUniverseSession>['state'];
  onExplore: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { read } = state;
  if (['idle', 'loading'].includes(read.status)) return <QuietGround label="Loading your universe" />;
  const message =
    read.status === 'unsupported'
      ? 'This drawing isn’t supported on this device yet.'
      : read.reason === 'authority'
        ? 'Your map is no longer available.'
        : read.reason === 'network'
          ? 'You’re offline. Your universe is kept; refresh when you’re connected.'
          : 'Couldn’t draw your map. Try again in a moment.';
  return (
    <View style={[styles.ground, { paddingTop: insets.top + spacing[6] }]}>
      <UniverseBackdrop />
      <View style={styles.centred}>
        <Text variant="heading" heading={1} color={space.label}>
          Your universe
        </Text>
        <Text variant="body" color={space.label2}>
          {message}
        </Text>
        <View style={styles.actions}>
          <Button
            label="Refresh map"
            variant="space"
            disabled={read.status === 'ended'}
            onPress={() => {
              void session.refresh();
            }}
          />
          <Button label="Go to Explore" variant="space" role="link" href="/explore" onPress={onExplore} />
        </View>
      </View>
    </View>
  );
}

export function UniverseScreen() {
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <SignedInUniverse scope={state.scope} />;
  return <EmptyUniverseScreen />;
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: space.s0, paddingHorizontal: spacing[5] },
  centred: { flex: 1, justifyContent: 'center', gap: spacing[4] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
