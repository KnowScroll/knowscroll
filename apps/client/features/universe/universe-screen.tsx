import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope } from '@knowscroll/client-core';
import { Button, Icon, printedSurface, Skeleton, Text, useDisplay } from '@knowscroll/ui';
import { space, spacing } from '@knowscroll/design-tokens';
import { useAccountScope } from '../../providers/account-scope';
import { roomHref } from '../rooms/room-links';
import { useRoomStationsOnMap } from '../rooms/use-room-stations';
import { ScreenFrame } from '../shell/screen-frame';
import { useDocumentTitle } from '../../platform/document-title';
import { FirstOpenGate } from './animation/first-open';
import { EmptyUniverseScreen } from './empty-universe-screen';
import { FormationNotice, FormationPresentation } from './formation-presentation';
import { lowMemoryDevice } from './space/low-memory-device';
import { SkyBackdrop } from './space/sky-backdrop';
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
  const { reducedMotion, breakpoint } = useDisplay(),
    { session, state } = useUniverseSession(scope, reducedMotion),
    router = useRouter(),
    { focus: focusParam } = useLocalSearchParams<{ focus?: string }>();
  const [foreground, setForeground] = useState(false);
  const stations = useRoomStationsOnMap(scope);
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
    // A region, planet or system with its own target gets focus. Back from an encounter lands on the region
    // marked "you were here"; a planet's globe or map is otherwise the stage itself.
    (
      document.querySelector<HTMLElement>(`[data-testid="universe-focus-${state.focusId}"]`) ??
      (state.youWereHere
        ? document.querySelector<HTMLElement>(`[data-testid="universe-focus-${state.youWereHere}"]`)
        : null) ??
      document.querySelector<HTMLElement>('[data-testid="universe-map"]')
    )?.focus();
  }, [foreground, state.overlay, state.focusId, state.historyDepth, state.youWereHere, state.landed]);

  const dust = state.dust.cues.length > 0;
  const emptyNow = read.status === 'empty' && !dust && state.dust.status !== 'idle' && state.dust.status !== 'loading';
  // The first open (D-114) plays once in the account's life, where 3D can be drawn and motion is welcome.
  const opening =
    !reducedMotion && state.detail !== 'low' && breakpoint !== 'desktop' && canDrawSpace() && !lowMemoryDevice();
  // The Universe is its authored sky with cream controls over it: the same in both appearances (#666).
  const gated = (screenNode: ReactNode) => (
    <View style={styles.sky} {...printedSurface()}>
      <FirstOpenGate scope={scope} enabled={opening} endsOnEmpty={emptyNow} empty={<EmptyUniverseScreen over />}>
        {screenNode}
      </FirstOpenGate>
    </View>
  );
  if (read.status === 'empty' && !dust)
    return gated(
      state.dust.status === 'idle' || state.dust.status === 'loading' ? (
        <QuietGround label="Looking at your universe" />
      ) : (
        <EmptyUniverseScreen />
      ),
    );
  if (!snapshot && read.status !== 'empty')
    return gated(<Unavailable session={session} state={state} onExplore={() => router.navigate('/explore')} />);
  return gated(
    <>
      <UniverseSurface
        session={session}
        state={state}
        index={index}
        status={statusOf(state)}
        stations={stations}
        onStation={(roomId) => router.push(roomHref(roomId))}
        notice={<FormationNotice session={session} />}
        scope={scope}
      />
      <FormationPresentation session={session} />
    </>,
  );
}

/** A cheap first look at whether the opening's 3D scene can run at all; the claim itself waits for its real WebGL context (D-114). */
const canDrawSpace = (): boolean => Platform.OS !== 'web' || typeof WebGL2RenderingContext !== 'undefined';

function QuietGround({ label }: { label: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.ground, { paddingTop: insets.top + spacing[6] }]}>
      <SkyBackdrop />
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
  const { read } = state;
  const { breakpoint } = useDisplay();
  if (['idle', 'loading'].includes(read.status)) return <QuietGround label="Loading your universe" />;
  const { heading, message } = unavailableWords(read);
  return (
    <ScreenFrame
      tone="space"
      title="Your universe"
      pageTitle="Universe"
      titleVariant="heading"
      backdrop={<SkyBackdrop />}
      bodyPlacement="center"
    >
      <View style={styles.offline}>
        <View style={styles.offlineMark}>
          <Icon name="wifiOff" size={28} color={space.label} />
        </View>
        <Text variant="heading" heading={2} color={space.label} align="center">
          {heading}
        </Text>
        <Text variant="body" color={space.label2} align="center">
          {message}
        </Text>
        {/* Error · Offline draws the two buttons stacked on a phone; from a tablet up they sit side by side. */}
        <View
          testID="universe-offline-actions"
          style={[styles.actions, breakpoint === 'compact' || breakpoint === 'phone' ? styles.actionsStacked : null]}
        >
          <Button
            label="Refresh map"
            variant="space"
            icon="retry"
            disabled={read.status === 'ended'}
            onPress={() => {
              void session.refresh();
            }}
          />
          <Button
            label="Go to Explore"
            variant="spaceGhost"
            icon="explore"
            role="link"
            href="/explore"
            onPress={onExplore}
          />
        </View>
      </View>
    </ScreenFrame>
  );
}

/** The heading and the one plain line for each reason there is no map to draw (the design's Offline, in three voices). */
export function unavailableWords(read: ReturnType<typeof useUniverseSession>['state']['read']): {
  heading: string;
  message: string;
} {
  if (read.status === 'unsupported')
    return { heading: 'Not on this device yet', message: 'This drawing isn’t supported on this device yet.' };
  if (read.reason === 'authority')
    return { heading: 'No longer available', message: 'Your map is no longer available.' };
  if (read.reason === 'network')
    return {
      heading: 'You’re offline',
      message: 'Your universe is kept. Refresh when you’re connected.',
    };
  return { heading: 'Couldn’t draw your map', message: 'Couldn’t draw your map. Try again in a moment.' };
}

export function UniverseScreen() {
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <SignedInUniverse scope={state.scope} />;
  return <EmptyUniverseScreen />;
}

const styles = StyleSheet.create({
  sky: { flex: 1 },
  ground: { flex: 1, backgroundColor: space.s0, paddingHorizontal: spacing[5] },
  centred: { flex: 1, justifyContent: 'center', gap: spacing[4] },
  offline: { alignItems: 'center', justifyContent: 'center', gap: spacing[3] },
  offlineMark: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1.5,
    borderColor: 'rgba(255,253,242,0.35)',
    backgroundColor: 'rgba(2,3,8,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], justifyContent: 'center', marginTop: spacing[2] },
  actionsStacked: { flexDirection: 'column', alignItems: 'center' },
});
