import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope, VisitSession, VisitState } from '@knowscroll/client-core';
import { space, spacing } from '@knowscroll/design-tokens';
import { Button, Skeleton, Text, useDisplay } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { useDocumentTitle } from '../../platform/document-title';
import { UniverseBackdrop } from '../universe/universe-backdrop';
import { indexUniverse } from '../universe/universe-layout';
import { UniverseSurface } from '../universe/universe-surface';
import { useUniverseBack } from '../universe/use-universe-back';
import type { VisitMapSession } from './visit-map-session';
import { useVisitSessions } from './use-visit-sessions';
import { VisitorBar } from './visitor-bar';
import { visitorDescriptors } from './visitor-scene';

/**
 * `/visit/[handle]` (U06): a friend's universe, as much of it as they chose to share, drawn by the
 * Universe's own renderer. Signed out, there is nothing to visit.
 */
export function VisitScreen({ handle }: { readonly handle: string }) {
  const router = useRouter();
  const { state } = useAccountScope();
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
  return <SignedInVisit scope={state.scope} handle={handle} />;
}

/** One visit: its data session and its map session, made when the screen mounts and dropped when it leaves. */
function SignedInVisit({ scope, handle }: { readonly scope: AccountScope; readonly handle: string }) {
  const sessions = useVisitSessions(scope, handle);
  useDocumentTitle('Visiting a friend');
  if (!sessions) return <QuietGround label="Opening this universe" />;
  return <Visit visit={sessions.visit} map={sessions.map} />;
}

function Visit({ visit, map }: { readonly visit: VisitSession; readonly map: VisitMapSession }) {
  const router = useRouter();
  const { reducedMotion } = useDisplay();
  const state = useSyncExternalStore(visit.subscribe, visit.getState, visit.getState);
  const mapState = useSyncExternalStore(map.subscribe, map.getState, map.getState);
  const [foreground, setForeground] = useState(false);
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
  useLayoutEffect(() => map.setDescriptors(descriptors), [map, descriptors]);
  const index = useMemo(() => indexUniverse(descriptors, []), [descriptors]);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/friends'));

  if (state.status === 'loading' || state.status === 'ended') return <QuietGround label="Opening this universe" />;
  if (state.status === 'unavailable') return <Unavailable state={state} onLeave={leave} />;
  if (state.status === 'offline') return <Offline onRetry={() => void visit.read()} onLeave={leave} />;
  return (
    <UniverseSurface
      session={map}
      state={mapState}
      index={index}
      status={state.stale ? 'Last list shown' : undefined}
      visitor={{
        ownerName: state.owner.displayName,
        bar: <VisitorBar ownerName={state.owner.displayName} onLeave={leave} />,
      }}
    />
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
  ground: { flex: 1, backgroundColor: space.s0, paddingHorizontal: spacing[5] },
  centred: { flex: 1, justifyContent: 'center', gap: spacing[4] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
