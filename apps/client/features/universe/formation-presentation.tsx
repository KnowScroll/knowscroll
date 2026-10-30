import { useEffect, useState, useSyncExternalStore } from 'react';
import { Modal, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Ellipse, G, Line } from 'react-native-svg';
import { Button, dialogHostSemantics, dialogSemantics, Icon, Tag, Text, usePageInert } from '@knowscroll/ui';
import { content, layout, radius, space, spacing } from '@knowscroll/design-tokens';
import type { SceneGeometry } from '@knowscroll/scene-core';
import type { FormationPresentationState } from '@knowscroll/client-core';
import type { FormationPresentationFact } from '@knowscroll/contracts';
import { PlanetGlyph, StarGlyph } from './universe-bodies';
import { SpaceChip } from './space-chip';
import { UniverseBackdrop } from './universe-backdrop';
import type { UniverseViewSession } from './universe-session';

/** Only a confirmed current claim can mount a surface. Pending/absent service is not a story. */
export function FormationPresentation({ session }: { session: UniverseViewSession }) {
  const controller = session.formation;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  if (state.fact)
    return <FormationSurface key={state.fact.transitionId} session={session} state={state} fact={state.fact} />;
  if (state.status === 'unavailable')
    return (
      <Notice
        text="New-place views aren’t available right now."
        action="Refresh"
        actionLabel="Refresh new-place view"
        onAction={() => {
          void controller.refresh();
        }}
      />
    );
  if (state.status === 'claim_unknown' || state.status === 'ack_unknown')
    return (
      <Notice
        text="This map view couldn’t be confirmed. Retry when connected."
        action="Retry"
        actionLabel="Retry map view"
        onAction={() => controller.retry()}
      />
    );
  return null;
}
/**
 * A quiet card over the map when the new-place story cannot be shown or confirmed (the design's
 * "Notice Formation"): a round mark, one plain line and a short action. The map stays usable.
 */
function Notice({
  text,
  action,
  actionLabel,
  onAction,
}: {
  text: string;
  action: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View pointerEvents="box-none" style={styles.noticeHost}>
      <View style={styles.notice} role="status">
        <View style={styles.noticeMark}>
          <Icon name="info" size={16} color={content.ink} />
        </View>
        <Text variant="bodyS" style={styles.noticeText}>
          {text}
        </Text>
        <Button label={action} accessibilityLabel={actionLabel} variant="ink" size="sm" onPress={onAction} />
      </View>
    </View>
  );
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
  const insets = useSafeAreaInsets();
  usePageInert(true);
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
  const systemLabel = newSystem ? fact.targets.find((t) => t.objectId === newSystem.systemId)!.label : undefined;
  const starFor =
    starDescriptor ?? session.descriptors().find((d) => d.kind === 'star' && d.parentId === descriptor?.parentId);
  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={() => controller.skip(fact)}
      {...dialogHostSemantics('A new place')}
    >
      <View testID="formation-presentation" {...dialogSemantics('A new place')} style={styles.host}>
        <UniverseBackdrop glow={false} />
        <View style={[styles.corner, { top: insets.top + spacing[3] }]}>
          <SpaceChip
            label={state.completed ? 'Done' : 'Skip'}
            variant={state.completed ? 'ghost' : 'solid'}
            onPress={() => (state.completed ? session.dismissFormation(fact) : controller.skip(fact))}
          />
        </View>
        {geometry ? (
          <FormationDrawing
            beat={final ? 4 : beat}
            geometry={geometry}
            seed={descriptor!.seed}
            hasStar={Boolean(starFor)}
            newSystem={Boolean(newSystem)}
            systemLabel={systemLabel}
            planetLabel={target.label}
            low={Boolean(state.reducedMotion)}
          />
        ) : (
          <Text variant="body" color={space.label}>
            The current drawing is unavailable.
          </Text>
        )}
        {target.truthStatus === 'hypothetical' ? (
          <View style={styles.status}>
            <Tag label="Hypothetical" variant="hypothetical" />
          </View>
        ) : null}
        {final ? (
          <View accessibilityLiveRegion="polite" style={styles.caption}>
            <Text variant="ui" color={space.onControl}>
              {`A new place: ${target.label}`}
            </Text>
          </View>
        ) : null}
        {pending ? (
          <View style={styles.pending}>
            <Text variant="body" color={space.label}>
              This view couldn’t be confirmed.
            </Text>
            <Button label="Retry map view" variant="space" onPress={() => controller.retry()} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const BEAT_NOTE = [
  'Dust drifts, scattered and slow',
  'Gathering, spiralling inward',
  'A protostar lights; the disc flattens',
  'The star takes its first orbit',
  'The planet settles',
] as const;

/**
 * The 2.4 s storyboard of U05, drawn from the committed creation facts: dust drifts, gathers,
 * lights a protostar, a star takes its orbit (new systems only), and the planet settles. It never
 * says what the person learned. Under reduced motion only the last frame is drawn.
 */
function FormationDrawing({
  beat,
  geometry,
  seed,
  hasStar,
  newSystem,
  systemLabel,
  planetLabel,
  low,
}: {
  beat: number;
  geometry: SceneGeometry;
  seed: string;
  hasStar: boolean;
  newSystem: boolean;
  systemLabel: string | undefined;
  planetLabel: string;
  low: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const stage = { width: Math.min(width, 560), height: Math.min(height * 0.62, 520) };
  const cx = stage.width / 2,
    cy = stage.height * 0.5;
  const orbit = { rx: stage.width * 0.34, ry: stage.width * 0.12 };
  const specks = Array.from({ length: 9 }, (_, step) => {
    const angle = step * 2.4 + 0.5;
    const pull = beat === 0 ? 1 : 0.55;
    const distance = (34 + ((step * 53) % 90)) * pull;
    return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance, angle };
  });
  const showStar = beat >= 3 || (!newSystem && beat >= 2 && hasStar);
  const showPlanet = beat >= 4;
  return (
    <View
      style={[styles.drawing, { width: stage.width, height: stage.height }]}
      accessibilityLabel={BEAT_NOTE[beat]}
      accessible={false}
    >
      <Svg width={stage.width} height={stage.height} aria-hidden pointerEvents="none">
        {beat <= 1 ? (
          <>
            <Circle cx={cx} cy={cy} r={beat === 0 ? 138 : 92} fill={space.s1} opacity={0.6} />
            {beat === 1 ? <Circle cx={cx} cy={cy} r={55} fill="#0E3A3F" opacity={0.6} /> : null}
            {beat === 1 ? (
              <Circle
                cx={cx}
                cy={cy}
                r={84}
                fill="none"
                stroke={space.label}
                strokeOpacity={0.3}
                strokeDasharray="2 5"
              />
            ) : null}
            {specks.map((speck, step) => (
              <G key={step}>
                {beat === 0 ? (
                  <Line
                    x1={speck.x}
                    y1={speck.y}
                    x2={speck.x + Math.cos(speck.angle) * 7}
                    y2={speck.y + Math.sin(speck.angle) * 7}
                    stroke={space.label}
                    strokeOpacity={0.4}
                  />
                ) : null}
                <Circle cx={speck.x} cy={speck.y} r={1.6 + (step % 3) * 0.4} fill={space.label} opacity={0.6} />
              </G>
            ))}
          </>
        ) : null}
        {beat === 2 && !showStar ? (
          <>
            <Ellipse cx={cx} cy={cy} rx={stage.width * 0.24} ry={13} fill="#12525A" opacity={0.45} />
            <Circle cx={cx} cy={cy} r={16} fill={space.star} opacity={0.25} />
            <Circle cx={cx} cy={cy} r={8} fill={space.star} />
          </>
        ) : null}
        {showStar ? (
          <>
            <StarGlyph cx={cx} cy={cy} r={26} />
          </>
        ) : null}
        {showPlanet ? (
          <PlanetGlyph
            cx={cx - orbit.rx * 0.78}
            cy={cy + orbit.ry * 0.35}
            r={low ? 26 : 24}
            geometry={geometry}
            seed={seed}
            low
          />
        ) : null}
      </Svg>
      {showStar && systemLabel && beat >= 3 ? (
        <View pointerEvents="none" style={[styles.systemLabel, { top: cy + orbit.ry + 22 }]}>
          <Text variant="ui" color={space.label} align="center">
            {systemLabel}
          </Text>
          <Text variant="label" color={space.label2} align="center">
            A system
          </Text>
        </View>
      ) : null}
      {showPlanet ? (
        <View
          pointerEvents="none"
          style={[styles.planetLabel, { left: cx - orbit.rx * 0.78 - 60, top: cy + orbit.ry * 0.35 + 30 }]}
        >
          <Text variant="spaceLabel" color={space.label} align="center">
            {planetLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: space.s0, alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', right: spacing[4], zIndex: 2 },
  drawing: { alignSelf: 'center' },
  systemLabel: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 2 },
  planetLabel: { position: 'absolute', width: 120, alignItems: 'center' },
  status: { position: 'absolute', top: '70%' },
  caption: {
    position: 'absolute',
    top: '68%',
    backgroundColor: space.control,
    paddingHorizontal: spacing[5],
    minHeight: 48,
    borderRadius: radius.pill,
    justifyContent: 'center',
  },
  noticeHost: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    bottom: layout.tabBarSlot + spacing[18],
    alignItems: 'center',
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: content.paper,
    borderRadius: 20,
    paddingVertical: spacing[2],
    paddingLeft: spacing[3],
    paddingRight: spacing[2],
    gap: spacing[3],
    maxWidth: 460,
  },
  noticeMark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(21,48,42,0.07)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeText: { flex: 1 },
  pending: { position: 'absolute', bottom: spacing[12], alignItems: 'center', gap: spacing[3] },
});
