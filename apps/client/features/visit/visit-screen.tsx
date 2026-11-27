import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope, FeedbackTarget, VisitSession, VisitState } from '@knowscroll/client-core';
import { space, spacing } from '@knowscroll/design-tokens';
import { Button, printedSurface, Skeleton, Text, useDisplay } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useDocumentTitle } from '../../platform/document-title';
import { FeedbackSheet } from '../feedback/feedback-sheet';
import { createCrossingDirector } from '../universe/crossing/crossing-director';
import { crossingSeconds } from '../universe/crossing/crossing-frame';
import { FrameRateReadout } from '../universe/frame-rate/frame-rate-readout';
import { UniverseBackdrop } from '../universe/universe-backdrop';
import { indexUniverse } from '../universe/universe-layout';
import { UniverseSurface } from '../universe/universe-surface';
import { useUniverseBack } from '../universe/use-universe-back';
import { useUniverseTrial } from '../universe/universe-trial';
import { crossingSeen, markCrossingSeen } from './crossing-seen';
import { crossingWorldOf } from './crossing-world';
import type { VisitMapSession } from './visit-map-session';
import { useVisitSessions } from './use-visit-sessions';
import { InCommonChip } from './in-common-chip';
import { systemsInCommon } from './in-common';
import { useOwnSystemLabels } from './use-own-system-labels';
import { VisitCrossing, type CrossingEnd } from './visit-crossing';
import { VisitFrame } from './visit-frame';
import { VisitorBar, VisitorPrivacy } from './visitor-bar';
import { visitorDescriptors, visitorLooks } from './visitor-scene';

/**
 * `/visit/[handle]` (U06): a friend's universe, as much of it as they chose to share, drawn by the
 * Universe's own renderer. Signed out, there is nothing to visit.
 */
export function VisitScreen({ handle }: { readonly handle: string }) {
  const router = useRouter();
  const { state } = useAccountScope();
  const trial = useUniverseTrial();
  if (state.status !== 'signed_in')
    return (
      <Ground>
        <Text variant="heading" heading={1} color={space.label}>
          Sign in to visit a friend
        </Text>
        <Text variant="body" color={space.label2}>
          A friend’s universe is open only to the friends they chose.
        </Text>
        <View style={styles.actions}>
          <Button
            label="Sign in"
            variant="space"
            role="link"
            href="/welcome"
            onPress={() => router.navigate('/welcome')}
          />
        </View>
      </Ground>
    );
  // In the new look one visit has one crossing: another friend is a new screen with its own film. The old look keeps
  // the screen it had across a change of friend, as it always did.
  return <SignedInVisit key={trial.on ? handle : undefined} scope={state.scope} handle={handle} />;
}

const noSubscribe = () => () => {};
const noState = () => undefined;

/** The device says it has no connection (the web's `navigator.onLine`; native has no such answer, which is not "offline"). */
const deviceOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * One visit: its data session and its map session, made when the screen mounts and dropped when it leaves, under the
 * primary navigation. With "Try the new Universe" on, the crossing film plays over all of it when the screen first
 * mounts (every start of a visit lands here: a Friends row, the chat rail, a link), and Leave plays it home. With it off
 * there is no film, ever, and Leave goes back as it always did.
 */
function SignedInVisit({ scope, handle }: { readonly scope: AccountScope; readonly handle: string }) {
  const sessions = useVisitSessions(scope, handle);
  const trial = useUniverseTrial();
  useDocumentTitle('Visiting a friend');
  const router = useRouter();
  const { reducedMotion } = useDisplay();
  // What this screen was opened with decides about its film for good: a switch or a setting changed under it changes nothing here.
  const [withFilm] = useState(trial.on);
  const [cut] = useState(reducedMotion);
  const [director] = useState(() => createCrossingDirector());
  useEffect(() => {
    // The first mount only (a second setup of the same screen is not a second visit); and not with no connection: the
    // screen that says so is the answer, not a film that has to be stopped.
    if (!withFilm || director.getState().runs > 0 || deviceOffline()) return;
    director.start({ direction: 'out', seconds: crossingSeconds('out', crossingSeen(scope, handle)), cut });
  }, [director, withFilm, cut, scope, handle]);

  // Your own names, for "What we have in common" in the cards and the film: not read at all with the switch off.
  const ownLabels = useOwnSystemLabels(scope, trial.on);
  const visit = sessions?.visit;
  const visitState = useSyncExternalStore(visit?.subscribe ?? noSubscribe, () => visit?.getState(), noState);
  const world = useMemo(() => crossingWorldOf(visitState, ownLabels), [visitState, ownLabels]);
  useEffect(() => {
    director.world(world);
  }, [director, world]);

  const onEnd = useCallback(
    (end: CrossingEnd) => {
      // Home ends on your own Universe (the visit is left, not stacked over); going out ends where the visit already is, which the film was drawn over.
      if (end.direction === 'home') router.dismissTo('/universe');
      else if (!end.cut) markCrossingSeen(scope, handle);
    },
    [router, scope, handle],
  );
  const leaveHome = useCallback(
    () => director.start({ direction: 'home', seconds: crossingSeconds('home', false), cut }),
    [director, cut],
  );

  const visitTree = (
    <VisitFrame>
      {sessions ? (
        // In the new look, one visit has one "What we have in common" switch: off when you arrive, and off again for
        // another friend. The old look keeps the screen it had across a change of friend.
        <Visit
          key={trial.on ? handle : undefined}
          visit={sessions.visit}
          map={sessions.map}
          ownLabels={ownLabels}
          {...(withFilm ? { onLeaveToUniverse: leaveHome } : {})}
        />
      ) : (
        <QuietGround label="Opening this universe" />
      )}
    </VisitFrame>
  );
  // With the switch off the screen is the one it always was: no film, no readout, nothing round it.
  if (!withFilm) return visitTree;
  // The readout is the Universe's (Settings: "Show the Universe frame rate"); the film's frames are in it.
  return (
    <FrameRateReadout on={trial.frameRate} placed>
      <View style={styles.root}>
        {visitTree}
        <VisitCrossing director={director} handle={handle} onEnd={onEnd} />
      </View>
    </FrameRateReadout>
  );
}

function Visit({
  visit,
  map,
  ownLabels,
  onLeaveToUniverse,
}: {
  readonly visit: VisitSession;
  readonly map: VisitMapSession;
  /** The names of your own systems, for "What we have in common" (the new look only); undefined when not in hand. */
  readonly ownLabels: readonly string[] | undefined;
  /** The new look's Leave: plays the film home and lands on your Universe. Absent: Leave goes back, as it always did. */
  readonly onLeaveToUniverse?: () => void;
}) {
  // The Universe's new look on trial (a switch on this device) draws a friend's Universe too.
  const trial = useUniverseTrial();
  const router = useRouter();
  const { reducedMotion } = useDisplay();
  const state = useSyncExternalStore(visit.subscribe, visit.getState, visit.getState);
  const mapState = useSyncExternalStore(map.subscribe, map.getState, map.getState);
  const [foreground, setForeground] = useState(false);
  const [reporting, setReporting] = useState<FeedbackTarget>();
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      const active = (value: boolean) => {
        map.setForeground(value);
        visit.setForeground(value);
        setForeground(value);
      };
      active(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => active(value === 'active'));
      return () => {
        active(false);
        listener.remove();
      };
    }, [map, visit]),
  );
  useEffect(() => map.configure({ detail: mapState.detail, reducedMotion }), [map, mapState.detail, reducedMotion]);
  useUniverseBack(map, foreground);
  const ready = state.status === 'ready' ? state : undefined;
  // The session keeps the same state object while a read finds the same list, so this redraws only
  // when what the owner shares changes.
  const descriptors = useMemo(() => (ready ? visitorDescriptors(ready.owner.personId, ready.systems) : []), [ready]);
  const looks = useMemo(() => (ready ? visitorLooks(ready.systems) : []), [ready]);
  useLayoutEffect(() => map.setDescriptors(descriptors, looks), [map, descriptors, looks]);
  const index = useMemo(() => indexUniverse(descriptors, []), [descriptors]);
  // "What we have in common" (the new look only): the friend's systems whose names you have too, compared on this device.
  const shared = useMemo(
    () => (ready && ownLabels ? systemsInCommon(ownLabels, ready.systems).map((system) => system.publicSystemId) : []),
    [ready, ownLabels],
  );
  const [commonOn, setCommonOn] = useState(false);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/friends'));

  if (state.status === 'loading' || state.status === 'ended') return <QuietGround label="Opening this universe" />;
  if (state.status === 'unavailable') return <Unavailable state={state} onLeave={leave} />;
  if (state.status === 'offline') return <Offline onRetry={() => void visit.read()} onLeave={leave} />;
  const { owner } = state;
  return (
    <>
      <PinnedLight pinned={trial.on}>
        <UniverseSurface
          session={map}
          state={mapState}
          index={index}
          voyage={trial.on}
          status={state.stale ? 'Last list shown' : undefined}
          visitor={{
            ownerName: owner.displayName,
            footer: <VisitorPrivacy ownerName={owner.displayName} />,
            // Nothing to compare with (your own universe is empty or not in hand): no chip, rather than a chip that finds nothing.
            ...(trial.on && ownLabels && ownLabels.length > 0
              ? {
                  inCommon: {
                    on: commonOn,
                    shared,
                    chip: (
                      <InCommonChip
                        on={commonOn}
                        nothingShared={shared.length === 0}
                        onToggle={() => setCommonOn((on) => !on)}
                      />
                    ),
                  },
                }
              : {}),
            bar: (
              <VisitorBar
                ownerName={owner.displayName}
                onLeave={onLeaveToUniverse ?? leave}
                onReport={() =>
                  setReporting({
                    kind: 'person',
                    person: { personId: owner.personId, displayName: owner.displayName, handle: owner.handle },
                  })
                }
              />
            ),
          }}
        />
      </PinnedLight>
      <FeedbackSheet target={reporting} onClose={() => setReporting(undefined)} />
    </>
  );
}

/**
 * The new look's map is as your own Universe: an authored sky with cream controls, the same in both appearances (D-400).
 * The old look draws no wrapper and follows the appearance as it ever did; the tab bar or rail around it follow it in both.
 */
function PinnedLight({ pinned, children }: { readonly pinned: boolean; readonly children: React.ReactNode }) {
  if (!pinned) return <>{children}</>;
  return (
    <View style={styles.surface} {...printedSurface()}>
      {children}
    </View>
  );
}

function Ground({ children }: { readonly children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.ground, { paddingTop: insets.top + spacing[6] }]}>
      <UniverseBackdrop />
      <View style={styles.centred}>{children}</View>
    </View>
  );
}

function QuietGround({ label }: { readonly label: string }) {
  return (
    <Ground>
      <Skeleton rows={2} label={label} />
    </Ground>
  );
}

/**
 * Not shown. One screen for never shared, no longer shared, an ended friendship and an unknown person,
 * because the server answers them all the same. After a list was on screen it says "stopped sharing",
 * which is this visitor's own memory of the visit, and promises that nothing is kept.
 */
function Unavailable({
  state,
  onLeave,
}: {
  readonly state: Extract<VisitState, { status: 'unavailable' }>;
  readonly onLeave: () => void;
}) {
  const router = useRouter();
  return (
    <Ground>
      <View testID="visit-unavailable" role="alert">
        <Text variant="heading" heading={1} color={space.label}>
          {state.wasShown && state.ownerName
            ? `${state.ownerName} stopped sharing their universe`
            : 'This universe isn’t shared with you'}
        </Text>
      </View>
      <Text variant="body" color={space.label2}>
        {state.wasShown
          ? 'Nothing from it is kept on your side. Your conversations are unaffected.'
          : 'You can visit a friend’s universe when they choose to share it with you.'}
      </Text>
      <View style={styles.actions}>
        <Button
          label="Back to your universe"
          variant="space"
          role="link"
          href="/universe"
          onPress={() => router.navigate('/universe')}
        />
        <Button label="Back to Friends" variant="space" role="link" href="/friends" onPress={onLeave} />
      </View>
    </Ground>
  );
}

function Offline({ onRetry, onLeave }: { readonly onRetry: () => void; readonly onLeave: () => void }) {
  return (
    <Ground>
      <Text variant="heading" heading={1} color={space.label}>
        You’re offline
      </Text>
      <Text variant="body" color={space.label2}>
        Reconnect to visit. A friend’s universe isn’t kept on this device.
      </Text>
      <View style={styles.actions}>
        <Button label="Try again" variant="space" onPress={onRetry} />
        <Button label="Leave" variant="space" onPress={onLeave} />
      </View>
    </Ground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  ground: { flex: 1, backgroundColor: space.s0, paddingHorizontal: spacing[5] },
  surface: { flex: 1 },
  centred: { flex: 1, justifyContent: 'center', gap: spacing[4] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
