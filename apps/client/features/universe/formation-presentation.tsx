import { useEffect, useState, useSyncExternalStore } from 'react';
import { Modal, Platform, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { Button, Text } from '@knowscroll/ui';
import { space, spacing } from '@knowscroll/design-tokens';
import type { SceneGeometry } from '@knowscroll/scene-core';
import type { FormationPresentationState } from '@knowscroll/client-core';
import type { FormationPresentationFact } from '@knowscroll/contracts';
import type { UniverseViewSession } from './universe-session';

/** Only a confirmed current claim can mount a surface. Pending/absent service is not a story. */
export function FormationPresentation({ session }: { session: UniverseViewSession }) {
  const controller = session.formation;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  if (state.fact)
    return <FormationSurface key={state.fact.transitionId} session={session} state={state} fact={state.fact} />;
  if (state.status === 'unavailable')
    return (
      <View>
        <Text variant="body" color={space.label}>
          New-place views aren’t available right now.
        </Text>
        <Button
          label="Refresh new-place view"
          variant="space"
          onPress={() => {
            void controller.refresh();
          }}
        />
      </View>
    );
  if (state.status === 'claim_unknown' || state.status === 'ack_unknown')
    return (
      <View>
        <Text variant="body" color={space.label}>
          This map view couldn’t be confirmed. Retry when connected.
        </Text>
        <Button label="Retry map view" variant="space" onPress={() => controller.retry()} />
      </View>
    );
  return null;
}
function FormationSurface({
  session,
  state,
  fact,
}: {
  session: UniverseViewSession;
  state: FormationPresentationState;
  fact: FormationPresentationFact;
}) {
  const controller = session.formation;
  const [beat, setBeat] = useState(0);
  const planet = fact.sequence.kind === 'planet' ? fact.sequence.planetId : fact.targets[0]!.objectId;
  const descriptor = session.descriptors().find((d) => d.objectId === planet);
  const newSystem = fact.sequence.kind === 'planet' ? fact.sequence.newSystem : undefined;
  const starDescriptor = newSystem && session.descriptors().find((d) => d.objectId === newSystem.starId);
  let geometry: SceneGeometry | undefined, starGeometry: SceneGeometry | undefined;
  try {
    geometry = descriptor && session.geometry(descriptor);
    starGeometry = starDescriptor ? session.geometry(starDescriptor) : undefined;
  } catch {
    geometry = starGeometry = undefined;
  }
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (!geometry || (newSystem && !starGeometry)) {
      controller.skip(fact);
      return;
    }
    controller.mounted(fact); // Synchronously wins once before any timer or callback.
  }, [controller, fact, geometry, newSystem, starGeometry, state.status]);
  useEffect(() => {
    if (state.status !== 'presenting') return;
    if (state.reducedMotion) {
      controller.complete(fact);
      return;
    }
    const timers = [500, 1100, 1600, 2000].map((at, n) => setTimeout(() => setBeat(n + 1), at));
    timers.push(setTimeout(() => controller.complete(fact), 2400));
    return () => timers.forEach(clearTimeout);
  }, [controller, fact, state.reducedMotion, state.status]);
  useEffect(() => () => controller.unmounted(fact), [controller, fact]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const previous = document.activeElement;
    let active = true;
    queueMicrotask(() => {
      if (active && controller.getState().fact === fact)
        document.querySelector<HTMLElement>('[data-testid="formation-presentation"] [role="button"]')?.focus();
    });
    return () => {
      active = false;
      if (session.getState().read.active && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [controller, fact, session]);
  const final = state.reducedMotion || state.completed || beat === 4;
  const target = fact.targets.find((t) => t.objectId === planet)!;
  const pending = state.status === 'claim_unknown' || state.status === 'ack_unknown';
  return (
    <Modal visible transparent animationType="none" onRequestClose={() => controller.skip(fact)}>
      <View
        testID="formation-presentation"
        role="dialog"
        accessibilityLabel="A new place"
        accessibilityViewIsModal
        style={styles.host}
      >
        <Button
          label={state.completed ? 'Done' : 'Skip'}
          variant="space"
          onPress={() => (state.completed ? session.dismissFormation(fact) : controller.skip(fact))}
        />
        {geometry ? (
          <Svg width="100%" height={300} viewBox="0 0 400 300" aria-hidden pointerEvents="none">
            {!final
              ? [0, 1, 2, 3, 4, 5].map((n) => (
                  <Circle
                    key={n}
                    cx={80 + n * 45}
                    cy={110 + (n % 3) * 30}
                    r={2}
                    opacity={beat === 0 ? 0.3 : 0.6}
                    fill={space.label}
                  />
                ))
              : null}
            {starGeometry && (beat >= 2 || final) ? (
              <G transform="translate(280 80) scale(0.65)">
                <Path
                  d={`M ${starGeometry.silhouette.map((v) => `${v.x},${v.y}`).join(' L ')} Z`}
                  fill={space.star}
                  stroke={space.label2}
                  strokeWidth={1.5}
                />
              </G>
            ) : null}
            <G
              transform={`translate(190 160) scale(${final ? 1.3 : beat < 2 ? 0.2 : newSystem && beat < 4 ? 0.55 : 1})`}
              opacity={final ? 1 : beat === 0 ? 0.1 : 0.7}
            >
              <Path
                d={`M ${geometry.silhouette.map((v) => `${v.x},${v.y}`).join(' L ')} Z`}
                fill={geometry.palette === 'ochre' ? space.star : space.regionPin.fill}
                stroke={space.label2}
                strokeWidth={1.5}
              />
            </G>
          </Svg>
        ) : (
          <Text variant="body" color={space.label}>
            The current drawing is unavailable.
          </Text>
        )}
        {newSystem && (beat >= 3 || final) ? (
          <Text variant="meta" color={space.label}>
            {fact.targets.find((t) => t.objectId === newSystem.systemId)!.label}
          </Text>
        ) : null}
        {target.truthStatus === 'hypothetical' ? (
          <Text variant="meta" color={space.label}>
            Hypothetical
          </Text>
        ) : null}
        {final ? (
          <View accessibilityLiveRegion="polite">
            <Text variant="heading" color={space.label}>
              A new place: {target.label}
            </Text>
          </View>
        ) : null}
        {pending ? (
          <>
            <Text variant="body" color={space.label}>
              This view couldn’t be confirmed.
            </Text>
            <Button label="Retry map view" variant="space" onPress={() => controller.retry()} />
          </>
        ) : null}
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  host: {
    flex: 1,
    backgroundColor: space.s0,
    padding: spacing[5],
    paddingTop: spacing[8],
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: spacing[4],
  },
});
