import { useEffect, useMemo, type ReactNode } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import type { ScriptFrame } from '../space/space-script';
import { useFeedValue } from './animated';
import { enterWorldFrame, type WorldScene } from './enter-world';
import type { AnimationPlayer } from './player';
import type { ScriptFeed } from './use-universe-animation';

type FeedRead = (frame: ScriptFrame) => number | undefined;

/**
 * The globe of a planet's own view laid over the 3D planet while the camera glides down to it
 * ("Enter a planet", design 3): every frame the renderer reports the planet's projected centre and radius, and
 * the globe is placed there, scaled by that radius over its own, blurred at first and sharper as it nears.
 * The globe is drawn exactly as the planet's view draws it, so the last frame is that view.
 */
export function GlobeLayer({
  feed,
  globe,
  children,
}: {
  readonly feed: ScriptFeed;
  /** Where the planet view draws its globe: centre and radius in layout pixels. */
  readonly globe: { readonly x: number; readonly y: number; readonly radius: number };
  readonly children: ReactNode;
}) {
  const { x, y, radius } = globe;
  const readOpacity = useMemo<FeedRead>(() => (frame) => frame.planet?.appearance.opacity, []);
  const readBlur = useMemo<FeedRead>(() => (frame) => frame.planet?.appearance.blur, []);
  const readShiftX = useMemo<FeedRead>(
    () => (frame) => (frame.planet === undefined ? undefined : frame.planet.x - x),
    [x],
  );
  const readShiftY = useMemo<FeedRead>(
    () => (frame) => (frame.planet === undefined ? undefined : frame.planet.y - y),
    [y],
  );
  const readScale = useMemo<FeedRead>(
    () => (frame) => (frame.planet === undefined ? undefined : frame.planet.radiusPx / radius),
    [radius],
  );
  const opacity = useFeedValue(feed, readOpacity, 0);
  const shiftX = useFeedValue(feed, readShiftX, 0);
  const shiftY = useFeedValue(feed, readShiftY, 0);
  const scale = useFeedValue(feed, readScale, 1);
  const blur = useFeedValue(feed, readBlur, 6);
  const style = {
    opacity,
    transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale }],
    transformOrigin: `${String(x)}px ${String(y)}px`,
    // Blur on the globe only; iOS has no blur filter, so there it simply fades in.
    ...(Platform.OS === 'ios'
      ? {}
      : { filter: blur.interpolate({ inputRange: [0, 6], outputRange: ['blur(0px)', 'blur(6px)'] }) }),
  };
  return (
    <Animated.View
      testID="universe-globe-layer"
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, style]}
    >
      {children}
    </Animated.View>
  );
}

/** The animated values of "Enter a world", all set from one frame of the animation's `t`. */
function useWorldValues(player: AnimationPlayer, scene: WorldScene) {
  const values = useMemo(() => {
    const first = enterWorldFrame(0, scene);
    const make = (initial: number) => new Animated.Value(initial);
    return {
      left: make(first.circle.x - first.circle.radius),
      top: make(first.circle.y - first.circle.radius),
      diameter: make(first.circle.radius * 2),
      radius: make(first.circle.radius),
      mapOpacity: make(first.map.opacity),
      mapScale: make(first.map.scale),
      shiftX: make(first.map.shiftX),
      shiftY: make(first.map.shiftY),
      globeScale: make(first.globeScale),
      globeOpacity: make(first.globeOpacity),
      names: make(first.names),
      clouds: make(first.clouds),
    };
  }, [scene]);
  useEffect(() => {
    const apply = (t: number) => {
      const frame = enterWorldFrame(t, scene);
      values.left.setValue(frame.circle.x - frame.circle.radius);
      values.top.setValue(frame.circle.y - frame.circle.radius);
      values.diameter.setValue(frame.circle.radius * 2);
      values.radius.setValue(frame.circle.radius);
      values.mapOpacity.setValue(frame.map.opacity);
      values.mapScale.setValue(frame.map.scale);
      values.shiftX.setValue(frame.map.shiftX);
      values.shiftY.setValue(frame.map.shiftY);
      values.globeScale.setValue(frame.globeScale);
      values.globeOpacity.setValue(frame.globeOpacity);
      values.names.setValue(frame.names);
      values.clouds.setValue(frame.clouds);
    };
    apply(player.current()?.t ?? 0);
    return player.subscribe((run) => apply(run.t));
  }, [player, scene, values]);
  return values;
}

/**
 * "Enter a world": the globe leans in while the flat map fades up inside its circle, and the circle opens out until it
 * fills the screen. The map is the live map, moved and clipped, so the last frame is the landed screen exactly. Its
 * names and its clouds come in last, as the design leaves both out of the picture that moves.
 */
export function WorldLayers({
  player,
  scene,
  globe,
  map,
}: {
  readonly player: AnimationPlayer;
  /** The stage and where its globe sits. Keep it the same object between renders of one animation. */
  readonly scene: WorldScene;
  /** The planet's globe, drawn as its own view draws it. */
  readonly globe: ReactNode;
  /** The planet's landed map; told how its names and clouds arrive. */
  readonly map: (arrival: { names: Animated.Value; clouds: Animated.Value }) => ReactNode;
}) {
  const v = useWorldValues(player, scene);
  return (
    <View testID="universe-world-layers" pointerEvents="none" aria-hidden style={StyleSheet.absoluteFill}>
      <Animated.View
        style={{
          position: 'absolute',
          overflow: 'hidden',
          left: v.left,
          top: v.top,
          width: v.diameter,
          height: v.diameter,
          borderRadius: v.radius,
        }}
      >
        <Animated.View
          style={{
            position: 'absolute',
            left: Animated.multiply(v.left, -1),
            top: Animated.multiply(v.top, -1),
            width: scene.screen.width,
            height: scene.screen.height,
            opacity: v.mapOpacity,
            transform: [{ translateX: v.shiftX }, { translateY: v.shiftY }, { scale: v.mapScale }],
          }}
        >
          {map({ names: v.names, clouds: v.clouds })}
        </Animated.View>
      </Animated.View>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: v.globeOpacity,
            transform: [{ scale: v.globeScale }],
            transformOrigin: `${String(scene.globe.x)}px ${String(scene.globe.y)}px`,
          },
        ]}
      >
        {globe}
      </Animated.View>
    </View>
  );
}
