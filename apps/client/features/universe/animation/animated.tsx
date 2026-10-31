import { useEffect, useMemo, type ReactNode } from 'react';
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { ScriptFrame } from '../space/space-script';
import type { AnimationPlayer } from './player';
import type { ScriptFeed } from './use-universe-animation';

/**
 * Values that follow an animation without rendering. The animation's `t` (or the renderer's report of a
 * frame) is written into `Animated.Value`s, so a frame moves styles and re-renders nothing: the tab
 * keeps its 30 fps cap and never waits on React (D-100).
 */

/** What a piece of chrome shows at a moment of an animation: how visible it is and how far below its place. */
export interface Rising {
  readonly opacity: number;
  readonly offset: number;
}

/** An animated value that is `read(t)` while the player plays and `rest` when it does not. */
export function usePlayerValue(
  player: AnimationPlayer | undefined,
  read: ((t: number) => number) | undefined,
  rest: number,
) {
  const value = useMemo(() => new Animated.Value(rest), [rest]);
  useEffect(() => {
    if (read === undefined || player === undefined) {
      value.setValue(rest);
      return;
    }
    const start = player.current();
    value.setValue(start === undefined ? rest : read(start.t));
    const off = player.subscribe((run) => value.setValue(read(run.t)));
    const ended = player.onEnd(() => value.setValue(rest));
    return () => {
      off();
      ended();
    };
  }, [player, read, rest, value]);
  return value;
}

/** An animated value that is `read(frame)` for each frame the renderer reports, and `rest` when none plays. */
export function useFeedValue(
  feed: ScriptFeed,
  read: ((frame: ScriptFrame) => number | undefined) | undefined,
  rest: number,
) {
  const value = useMemo(() => new Animated.Value(rest), [rest]);
  useEffect(() => {
    if (read === undefined) {
      value.setValue(rest);
      return;
    }
    const apply = () => {
      const frame = feed.latest();
      const next = frame === undefined ? undefined : read(frame);
      if (next !== undefined) value.setValue(next);
    };
    apply();
    return feed.subscribe(apply);
  }, [feed, read, rest, value]);
  return value;
}

/**
 * A piece of chrome that rises in or fades out with an animation (design: "Destination chrome rises in
 * last"). With no `rising` it is plain: the wrapper stays in the tree so what is inside is never
 * mounted again when an animation starts or ends.
 */
export function Reveal({
  player,
  rising,
  children,
  style,
}: {
  readonly player: AnimationPlayer;
  readonly rising: ((t: number) => Rising) | undefined;
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const opacity = usePlayerValue(player, useMemoRead(rising, 'opacity'), 1);
  const offset = usePlayerValue(player, useMemoRead(rising, 'offset'), 0);
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.reveal, style, { opacity, transform: [{ translateY: offset }] }]}
    >
      {children}
    </Animated.View>
  );
}

function useMemoRead(rising: ((t: number) => Rising) | undefined, field: keyof Rising) {
  return useMemo(() => (rising === undefined ? undefined : (t: number) => rising(t)[field]), [rising, field]);
}

/** One ring that opens and fades where the tap that started an animation touched (design: "Tap ring"). */
export function TapRing({
  x,
  y,
  opacity,
  scale,
}: {
  readonly x: Animated.Value;
  readonly y: Animated.Value;
  readonly opacity: Animated.Value;
  readonly scale: Animated.Value;
}) {
  return (
    <Animated.View
      pointerEvents="none"
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      testID="universe-tap-ring"
      style={[
        styles.ring,
        {
          opacity,
          transform: [
            { translateX: Animated.subtract(x, RING_SIZE / 2) },
            { translateY: Animated.subtract(y, RING_SIZE / 2) },
            { scale },
          ],
        },
      ]}
    />
  );
}

const RING_SIZE = 30;

const styles = StyleSheet.create({
  reveal: {},
  ring: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 2,
    borderColor: '#FFFDF2',
  },
});
