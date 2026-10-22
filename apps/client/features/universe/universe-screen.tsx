import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { AccountScope } from '@knowscroll/client-core';
import { Button, Skeleton, Text, useDisplay } from '@knowscroll/ui';
import { space, spacing } from '@knowscroll/design-tokens';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { EmptyUniverseScreen } from './empty-universe-screen';
import { UniverseBackdrop } from './universe-backdrop';
import { useUniverseSession } from './use-universe-session';
import { useUniverseBack } from './use-universe-back';
import { UniverseMap } from './universe-map';
import { UniverseOutline } from './universe-outline';
import { UniversePlaceCard } from './universe-place-card';
import { FormationPresentation } from './formation-presentation';

export function SignedInUniverse({ scope }: { scope: AccountScope }) {
  const { reducedMotion } = useDisplay(),
    { session, state } = useUniverseSession(scope, reducedMotion),
    router = useRouter();
  const [foreground, setForeground] = useState(false);
  useFocusEffect(
    useCallback(() => {
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
  const back = useUniverseBack(session, foreground),
    read = state.read,
    places = session.places(),
    place = places.find((p) => p.id === state.focusId);
  useEffect(() => {
    if (Platform.OS !== 'web' || !foreground || state.overlay || !state.focusId) return;
    document.querySelector<HTMLElement>(`[data-testid="universe-focus-${state.focusId}"]`)?.focus();
  }, [foreground, state.overlay, state.focusId, state.historyDepth]);
  if (read.status === 'empty') return <EmptyUniverseScreen />;
  const stale = Boolean(read.snapshot) && read.status !== 'ready';
  const routes =
    read.status === 'ready'
      ? (read.snapshot?.chunks
          .flatMap((c) => c.routes)
          .filter((r) => r.fromObjectId === state.focusId || r.toObjectId === state.focusId) ?? [])
      : [];
  return (
    <ScreenFrame
      tone="space"
      title="Your universe"
      pageTitle="Universe"
      titleVariant="heading"
      bodyOffset={spacing[5]}
      backdrop={<UniverseBackdrop glow={false} />}
      testID="universe-screen"
    >
      <View style={styles.body}>
        {session.canBack() ? (
          <Button
            label="Back to previous view"
            variant="space"
            onPress={() => {
              if (!back() && router.canGoBack()) router.back();
            }}
          />
        ) : null}
        <FormationPresentation session={session} />
        {state.notice ? (
          <Text variant="body" color={space.label}>
            That place is no longer available in this map. Choose a place from the outline.
          </Text>
        ) : null}
        {place ? (
          <>
            <Text variant="displayL" heading={2} color={space.label}>
              {place.label}
            </Text>
            <Text variant="meta" color={space.label2}>
              {place.kind}
              {place.truthStatus === 'hypothetical' ? ' · Hypothetical' : ''}
            </Text>
          </>
        ) : null}
        {['idle', 'loading'].includes(read.status) && !read.snapshot ? (
          <Skeleton rows={3} label="Loading your universe" />
        ) : null}
        {read.status === 'loading' && read.pendingProjection ? (
          <Text variant="body" color={space.label}>
            Your map is being drawn.
          </Text>
        ) : null}
        {stale ? (
          <Text variant="body" color={space.label}>
            Showing your last available map. It may be out of date.
          </Text>
        ) : null}
        {read.status === 'lagging' ? (
          <Text variant="body" color={space.label}>
            A newer map is being drawn.
          </Text>
        ) : null}
        {read.status === 'unsupported' ? (
          <Text variant="body" color={space.label}>
            This drawing isn’t supported. You can use the outline.
          </Text>
        ) : null}
        {read.status === 'unavailable' ? (
          <Text variant="body" color={space.label}>
            {read.reason === 'authority'
              ? 'Your map is no longer available.'
              : read.reason === 'network'
                ? 'You’re offline. Refresh when you’re connected.'
                : 'Couldn’t draw your map. Refresh or use the available outline.'}
          </Text>
        ) : null}
        {read.snapshot ? <UniverseMap session={session} state={state} /> : null}
        <View style={styles.actions}>
          {places.length ? (
            <Button label="List view" variant="space" onPress={() => session.showOverlay('outline')} />
          ) : null}
          {place ? <Button label="Place details" variant="space" onPress={() => session.showOverlay('place')} /> : null}
          <Button
            label="Refresh map"
            variant="space"
            disabled={!foreground || read.status === 'ended'}
            onPress={() => {
              void session.refresh();
            }}
          />
        </View>
        {routes.slice(0, 64).map((route) => {
          const target = places.find(
            (p) => p.id === (route.fromObjectId === state.focusId ? route.toObjectId : route.fromObjectId),
          );
          return target ? (
            <Button
              key={route.id}
              label={`Travel to ${target.label}`}
              variant="space"
              onPress={() => session.travel(route.id)}
            />
          ) : null;
        })}
        {routes.length > 64 ? (
          <Text variant="body" color={space.label}>
            Use List view to choose another place.
          </Text>
        ) : null}
      </View>
      {state.overlay === 'outline' ? <UniverseOutline session={session} /> : null}
      {state.overlay === 'place' ? <UniversePlaceCard session={session} /> : null}
    </ScreenFrame>
  );
}
export function UniverseScreen() {
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <SignedInUniverse scope={state.scope} />;
  return <EmptyUniverseScreen />;
}
const styles = StyleSheet.create({
  body: { gap: spacing[4] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
