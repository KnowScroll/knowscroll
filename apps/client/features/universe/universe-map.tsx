import { useMemo, useState } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, View, type ViewProps } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';
import { Button, Text } from '@knowscroll/ui';
import { space, spacing } from '@knowscroll/design-tokens';
import type { SceneGeometry } from '@knowscroll/scene-core';
import { DRAW_LIMITS, projectPoint, type UniverseFrame } from './universe-camera';
import type { UniverseViewSession, UniverseViewState } from './universe-session';

function groundResponder(session: UniverseViewSession, width: number) {
  let origin: UniverseFrame = { x: 0, y: 0, scale: 1 },
    distance = 0;
  return PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 8,
    onPanResponderGrant: (event) => {
      origin = session.getState().frame;
      const [a, b] = event.nativeEvent.touches;
      distance = a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
    },
    onPanResponderMove: (event, gesture) => {
      const [a, b] = event.nativeEvent.touches;
      if (a && b) {
        const now = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
        if (!distance) distance = now;
        session.camera({
          ...origin,
          scale: (origin.scale * now) / Math.max(1, distance),
        });
      } else
        session.camera({
          ...origin,
          x: origin.x - (gesture.dx * 1000) / width / origin.scale,
          y: origin.y - (gesture.dy * 1000) / width / origin.scale,
        });
    },
    onPanResponderTerminationRequest: () => true,
  });
}

export function UniverseMap({ session, state }: { session: UniverseViewSession; state: UniverseViewState }) {
  const [width, setWidth] = useState(1000);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const all = session.descriptors();
  const selected = all.filter((o) =>
    state.focusId ? o.objectId === state.focusId || o.parentId === state.focusId : o.kind === 'system',
  );
  const visible = selected.filter((o) => {
    const p = projectPoint(o.anchor, state.frame);
    return p.x >= -100 && p.x <= 1100 && p.y >= -100 && p.y <= 700;
  });
  const crowded = visible.length > DRAW_LIMITS.bodies;
  let failed = false;
  const bodies: SceneGeometry[] = [];
  for (const o of visible.slice(0, DRAW_LIMITS.bodies)) {
    try {
      const geometry = session.geometry(o, crowded);
      if (geometry) bodies.push(geometry);
    } catch {
      failed = true;
      break;
    }
  }
  const ids = new Set(bodies.map((b) => b.objectId));
  const routes =
    state.read.snapshot?.chunks
      .flatMap((c) => c.routes)
      .filter((r) => ids.has(r.fromObjectId) && ids.has(r.toObjectId)) ?? [];
  const controls = (dx: number, dy: number, scale = 1) => {
    const f = session.getState().frame;
    session.camera({ x: f.x + dx / f.scale, y: f.y + dy / f.scale, scale: f.scale * scale });
  };
  const responder = useMemo(() => groundResponder(session, width), [session, width]);
  const onKeyDown: NonNullable<ViewProps['onKeyDown']> = (event) => {
    if (event.target !== event.currentTarget) return;
    if (!('key' in event.nativeEvent) || typeof event.nativeEvent.key !== 'string') return;
    const key = event.nativeEvent.key;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => controls(-60, 0),
      ArrowRight: () => controls(60, 0),
      ArrowUp: () => controls(0, -60),
      ArrowDown: () => controls(0, 60),
      '+': () => controls(0, 0, 1.25),
      '-': () => controls(0, 0, 0.8),
    };
    if (moves[key]) {
      event.preventDefault();
      moves[key]();
    }
  };
  const keyboard = Platform.OS === 'web' ? { onKeyDown } : {};
  if (failed)
    return (
      <Text variant="body" color={space.label}>
        The drawing is unavailable. Use the outline to choose a place.
      </Text>
    );
  return (
    <View style={styles.group}>
      <View
        testID="universe-map"
        role="group"
        accessibilityLabel="Universe map. Arrow keys pan, plus and minus zoom."
        focusable
        {...keyboard}
        onLayout={(e) => setWidth(Math.max(1, e.nativeEvent.layout.width))}
        style={styles.canvas}
      >
        <Svg width="100%" height="100%" viewBox="0 0 1000 600" pointerEvents="none" aria-hidden>
          {routes.slice(0, DRAW_LIMITS.routes).map((r) => {
            const a = all.find((o) => o.objectId === r.fromObjectId)!,
              b = all.find((o) => o.objectId === r.toObjectId)!;
            const from = projectPoint(a.anchor, state.frame),
              to = projectPoint(b.anchor, state.frame);
            return (
              <Line key={r.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={space.route} strokeDasharray="8 8" />
            );
          })}
          {bodies.map((b) => {
            const p = projectPoint(b.anchor, state.frame);
            return (
              <G key={b.objectId} transform={`translate(${p.x} ${p.y}) scale(${state.frame.scale})`}>
                <Circle r={b.atmosphereRadius} fill={space.s2} />
                <Path
                  d={`M ${b.silhouette.map((v) => `${v.x},${v.y}`).join(' L ')} Z`}
                  fill={b.palette === 'ochre' ? space.star : b.palette === 'sage' ? space.regionPin.fill : space.s2}
                  stroke={space.label2}
                  strokeWidth={1.5}
                />
                {all.find((o) => o.objectId === b.objectId)?.kind === 'star' ? (
                  <Circle r={12} fill={space.star} />
                ) : null}
              </G>
            );
          })}
        </Svg>
        <View style={StyleSheet.absoluteFill} {...responder.panHandlers} accessible={false} />
        {bodies.map((b, index) => {
          const p = projectPoint(b.anchor, state.frame),
            descriptor = all.find((o) => o.objectId === b.objectId)!;
          return (
            <Pressable
              key={b.objectId}
              testID={`universe-focus-${b.objectId}`}
              accessibilityState={{ selected: state.focusId === b.objectId }}
              accessibilityRole="button"
              accessibilityLabel={`Focus ${b.label}, ${descriptor.kind}${b.truthStatus === 'hypothetical' ? ', Hypothetical' : ''}`}
              onPress={() => session.focus(b.objectId)}
              onFocus={() => setFocusedId(b.objectId)}
              onBlur={() => setFocusedId(null)}
              style={[
                styles.hit,
                { left: `${p.x / 10}%`, top: `${p.y / 6}%` },
                focusedId === b.objectId ? styles.focus : null,
              ]}
            >
              {index < DRAW_LIMITS.labels ? (
                <Text variant="meta" color={space.label} style={styles.label}>
                  {b.label}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {crowded || routes.length > DRAW_LIMITS.routes ? (
        <Text variant="body" color={space.label}>
          Map view is crowded. Use the outline to reach every place.
        </Text>
      ) : null}
      <View style={styles.tools}>
        <Button label="Zoom in" variant="space" onPress={() => controls(0, 0, 1.25)} />
        <Button label="Zoom out" variant="space" onPress={() => controls(0, 0, 0.8)} />
        <Button label="Fit places" variant="space" onPress={() => session.fit()} />
        <Button
          label={state.detail === 'full' ? 'Use low detail' : 'Use full detail'}
          variant="space"
          onPress={() => session.configure({ detail: state.detail === 'full' ? 'low' : 'full', reducedMotion: true })}
        />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  group: { gap: spacing[3] },
  canvas: {
    width: '100%',
    aspectRatio: 5 / 3,
    backgroundColor: space.s1,
    borderWidth: 1,
    borderColor: space.edge,
    overflow: 'hidden',
  },
  hit: {
    position: 'absolute',
    width: 44,
    height: 44,
    marginLeft: -22,
    marginTop: -22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  focus: { borderWidth: 3, borderColor: space.focus },
  label: { position: 'absolute', top: 40, width: 130, textAlign: 'center', backgroundColor: space.labelChip },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
