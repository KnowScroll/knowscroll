import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope, UniverseSceneState } from '@knowscroll/client-core';
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
import { descriptorsOf, routesOf, skyOf } from './universe-places';
import { FrameRateReadout } from './frame-rate/frame-rate-readout';
import { UniverseSurface } from './universe-surface';
import { useUniverseTrial } from './universe-trial';
import { escapeOneStop } from './voyage/ladder';
import { createOuterStop, OuterStopContext, type OuterStop } from './voyage/outer/outer-stop';
import { useUniverseBack } from './use-universe-back';
import { useUniverseSession } from './use-universe-session';
import type { UniverseViewSession } from './universe-session';

/** A quiet, honest word over the map while it catches up; never a percentage or a count. */
function statusOf(state: ReturnType<typeof useUniverseSession>['state']): string | undefined {
  const { read } = state;
  if (read.status === 'empty') return undefined;
  if (read.status === 'loading' && read.snapshot) return 'Drawing…';
  if (read.status === 'lagging') return 'Drawing…';
  if (read.snapshot && read.status !== 'ready') return 'Last map shown';
  return undefined;
}

/**
 * The Back of the new look with an outer stop: the list of every friend first, then the stop, then the session's own. The
 * web's history marker (`use-universe-back.web.ts`) follows `canBack`, so browser Back leaves the stop too. With the
 * switch off none of this is made: the session is handed on as it is.
 */
function backWithOuter(session: UniverseViewSession, outer: OuterStop): UniverseViewSession {
  const leaveFirst = (): boolean => {
    const { on, listOpen } = outer.getState();
    if (listOpen) outer.closeList();
    else if (on) outer.leave();
    return on;
  };
  return {
    ...session,
    canBack: () => outer.getState().on || session.canBack(),
    back: () => leaveFirst() || session.back(),
    escape: () => leaveFirst() || escapeOneStop(session),
    subscribe: (listener) => {
      const stopSession = session.subscribe(listener);
      const stopOuter = outer.subscribe(listener);
      return () => {
        stopSession();
        stopOuter();
      };
    },
  };
}

export function SignedInUniverse({ scope }: { scope: AccountScope }) {
  const { reducedMotion, breakpoint } = useDisplay(),
    { session, state } = useUniverseSession(scope, reducedMotion),
    router = useRouter(),
    { focus: focusParam } = useLocalSearchParams<{ focus?: string }>();
  const [foreground, setForeground] = useState(false);
  const stations = useRoomStationsOnMap(scope);
  const trial = useUniverseTrial();
  // Made once for this screen; given to the tree only with the switch on. Nothing in it is stored.
  const [outer] = useState(() => createOuterStop());
  const outerHere = trial.on ? outer : null;
  useDocumentTitle('Universe · KnowScroll');
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      const hold = (value: boolean) => {
        session.setForeground(value);
        setForeground(value);
      };
      // The app goes to the background: the person is no longer past the rim.
      const active = (value: boolean) => {
        if (!value) outer.leave();
        hold(value);
      };
      active(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => active(value === 'active'));
      return () => {
        hold(false);
        listener.remove();
        // The screen blurs, and a visit is what blurs it: it pushes `/visit/<handle>`, so Leave on it lands on your universe,
        // not out among the friends. The stop is left once the rest of this blur has run, after Back's own cleanup has
        // stopped listening to it: the web's history marker would otherwise see Back become impossible and go back, taking
        // the visit with it.
        queueMicrotask(outer.leave);
      };
    }, [session, outer]),
  );
  // Anything that moves to a place leaves the stop, so the flag never outlives the view it was set on.
  useEffect(() => {
    if (state.focusId !== null) outer.leave();
  }, [state.focusId, outer]);
  // The new look's Escape climbs from the ground to the globe, as its Back pill does; with the switch off it is as ever.
  const backSession = useMemo(
    () => (outerHere === null ? session : backWithOuter(session, outerHere)),
    [session, outerHere],
  );
  useUniverseBack(backSession, foreground, trial.on);
  const { read } = state;
  const { snapshot, sky, loadedSystemIds } = read;
  // The map is its sky (every system) and the loaded systems' places (D-417); it is rebuilt only when one of them changes,
  // not on a status that leaves them as they were.
  const index = useMemo(() => {
    const held: UniverseSceneState = { status: 'ready', active: true, snapshot, sky, loadedSystemIds };
    return indexUniverse(descriptorsOf(held), routesOf(held), skyOf(held));
  }, [snapshot, sky, loadedSystemIds]);
  // `?focus=last` puts the ship at the last place once, when the map first has something to fly to.
  const flown = useRef(false);
  useEffect(() => {
    if (focusParam !== 'last' || flown.current || !foreground || !snapshot) return;
    flown.current = true;
    session.focusLast();
  }, [focusParam, foreground, snapshot, session]);
  const overlayBefore = useRef(state.overlay);
  useEffect(() => {
    const before = overlayBefore.current;
    overlayBefore.current = state.overlay;
    // In the new look a map that closes hands the keyboard back itself (to the chip that opened it): not taken here.
    const mapClosed = trial.on && (before === 'planet-map' || before === 'place');
    if (Platform.OS !== 'web' || mapClosed || !foreground || state.overlay || !state.focusId) return;
    // A region, planet or system with its own target gets focus. Back from an encounter lands on the region
    // marked "you were here"; a planet's globe or map is otherwise the stage itself.
    (
      document.querySelector<HTMLElement>(`[data-testid="universe-focus-${state.focusId}"]`) ??
      (state.youWereHere
        ? document.querySelector<HTMLElement>(`[data-testid="universe-focus-${state.youWereHere}"]`)
        : null) ??
      document.querySelector<HTMLElement>('[data-testid="universe-map"]')
    )?.focus();
  }, [trial.on, foreground, state.overlay, state.focusId, state.historyDepth, state.youWereHere, state.landed]);

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
    <OuterStopContext value={outerHere}>
      <FrameRateReadout on={trial.frameRate} placed={trial.on}>
        <UniverseSurface
          session={session}
          state={state}
          index={index}
          status={statusOf(state)}
          stations={stations}
          onStation={(roomId) => router.push(roomHref(roomId))}
          notice={<FormationNotice session={session} />}
          scope={scope}
          voyage={trial.on}
          onFriend={(handle) => router.push(`/visit/${encodeURIComponent(handle)}`)}
        />
        <FormationPresentation session={session} />
      </FrameRateReadout>
    </OuterStopContext>,
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
