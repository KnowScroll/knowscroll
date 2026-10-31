import { useEffect, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import type { RoomMotion } from '@knowscroll/contracts';

/** How long one turn of each loop takes, in milliseconds: slow, one at a time (R3: "one slow loop per room"). */
const LOOP_MS: Record<RoomMotion, number> = {
  twinkle: 6000,
  draw: 8000,
  blink: 3000,
  pan: 20000,
  rise: 6000,
  ripple: 5000,
};

const sine = (t: number): number => Easing.sin(t);

/** The Animated style each loop drives, from one value that runs 0 to 1 and starts over. */
function styleOf(motion: RoomMotion, progress: Animated.Value) {
  const through = (inputRange: number[], outputRange: number[]) => progress.interpolate({ inputRange, outputRange });
  switch (motion) {
    case 'twinkle':
      return { opacity: through([0, 0.5, 1], [1, 0.45, 1]) };
    case 'draw':
      return {
        opacity: through([0, 0.3, 1], [0.15, 1, 1]),
        transform: [{ translateX: through([0, 0.3, 1], [-24, 0, 0]) }],
      };
    case 'blink':
      return { opacity: through([0, 0.4, 0.5, 0.6, 1], [1, 1, 0.25, 1, 1]) };
    case 'pan':
      return { transform: [{ translateX: through([0, 0.5, 1], [0, -14, 0]) }] };
    case 'rise':
      return {
        opacity: through([0, 0.2, 0.8, 1], [0, 1, 1, 0]),
        transform: [{ translateY: through([0, 1], [8, -8]) }],
      };
    case 'ripple':
      return { opacity: through([0, 1], [1, 0.4]), transform: [{ scale: through([0, 1], [1, 1.1]) }] };
  }
}

/**
 * The style that moves a room's band, or `undefined` for a still frame (D-170). Reduced motion is always the still frame:
 * nothing starts, and a loop that was running stops. The loop uses only opacity and transforms, never layout.
 */
export function useBandMotion(motion: RoomMotion, reducedMotion: boolean) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: LOOP_MS[motion],
        easing: Easing.inOut(sine),
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [motion, reducedMotion, progress]);
  return reducedMotion ? undefined : styleOf(motion, progress);
}
