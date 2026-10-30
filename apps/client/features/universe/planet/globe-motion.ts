import { useEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';
import { useIsFocused } from 'expo-router';
import { createRenderLoop, type FrameScheduler } from '../space/render-loop';
import { useAppActive } from '../space/use-app-active';

/** The globe turns once in 70 s, its clouds once in 46 s, and the moon goes round in about 56 s. */
const SURFACE_SECONDS = 70;
const CLOUD_SECONDS = 46;
const MOON_SECONDS_PER_RADIAN = 9;
/** The band wraps every 480 units. */
const BAND = 480;
/** The moon's orbit, as fractions of the globe's radius, tilted a little. */
const MOON_REACH = { x: 200 / 146, y: 52 / 146, tilt: -0.24 } as const;
/** Where the moon stands when nothing moves: on the near side, the design's still frame. */
const STILL_MOON_ANGLE = 1;

const scheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

const wrap = (value: number): number => ((value % BAND) + BAND) % BAND;

/** The animated places of a globe's moving parts. Set from the render loop, never from React state. */
export interface GlobeMotion {
  /** Horizontal shift of the land band and of its names, in pixels (zero or negative). */
  readonly surfaceX: Animated.Value;
  /** Horizontal shift of the cloud band, in pixels. */
  readonly cloudX: Animated.Value;
  /** The moon's offset from the globe's centre, in pixels. */
  readonly moonX: Animated.Value;
  readonly moonY: Animated.Value;
  /** One is 1 and the other 0: the moon passes in front of the globe and behind it. */
  readonly moonFront: Animated.Value;
  readonly moonBehind: Animated.Value;
}

/**
 * Turns a globe. Everything is a pure function of the time `t` and of how far the person has
 * dragged, so one frame is a whole picture: under reduced motion the globe stands still at a calm
 * moment and only a drag turns it. The loop stops when the screen is not in front (D-100).
 *
 * @param spin Band units the person has turned the globe by hand (a drag), added to the slow turn.
 * @param unit Pixels in one band unit.
 */
export function useGlobeMotion(options: {
  readonly reducedMotion: boolean;
  readonly spin: number;
  readonly unit: number;
  readonly radius: number;
}): GlobeMotion {
  const { reducedMotion, spin, unit, radius } = options;
  const motion = useMemo<GlobeMotion>(
    () => ({
      surfaceX: new Animated.Value(0),
      cloudX: new Animated.Value(0),
      moonX: new Animated.Value(0),
      moonY: new Animated.Value(0),
      moonFront: new Animated.Value(1),
      moonBehind: new Animated.Value(0),
    }),
    [],
  );
  const latest = useRef({ spin, unit, radius });
  useEffect(() => {
    latest.current = { spin, unit, radius };
  }, [spin, unit, radius]);
  const focused = useIsFocused();
  const appActive = useAppActive();
  const loop = useRef<ReturnType<typeof createRenderLoop> | undefined>(undefined);

  useEffect(() => {
    const draw = (t: number) => {
      const { spin: turned, unit: pixels, radius: reach } = latest.current;
      motion.surfaceX.setValue(-wrap((t / SURFACE_SECONDS) * BAND + turned) * pixels);
      motion.cloudX.setValue(-wrap((t / CLOUD_SECONDS) * BAND + turned) * pixels);
      const angle = STILL_MOON_ANGLE + (reducedMotion ? 0 : t / MOON_SECONDS_PER_RADIAN);
      const x = Math.cos(angle) * MOON_REACH.x * reach;
      const y = Math.sin(angle) * MOON_REACH.y * reach;
      const cos = Math.cos(MOON_REACH.tilt);
      const sin = Math.sin(MOON_REACH.tilt);
      motion.moonX.setValue(x * cos - y * sin);
      motion.moonY.setValue(x * sin + y * cos);
      const behind = Math.sin(angle) < 0;
      motion.moonFront.setValue(behind ? 0 : 1);
      motion.moonBehind.setValue(behind ? 1 : 0);
    };
    const created = createRenderLoop({ draw, reducedMotion, scheduler });
    loop.current = created;
    return () => {
      created.dispose();
      loop.current = undefined;
    };
  }, [motion, reducedMotion]);

  useEffect(() => {
    loop.current?.setActive(focused && appActive);
  }, [focused, appActive, reducedMotion]);

  useEffect(() => {
    // A drag, or a new size, draws the still again; with motion the loop redraws by itself.
    if (reducedMotion) loop.current?.redraw();
  }, [reducedMotion, spin, unit, radius]);

  return motion;
}
