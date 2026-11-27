import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Text } from '@knowscroll/ui';
import { UNKNOWN_FRIEND, type CrossingDirector, type CrossingState } from '../universe/crossing/crossing-director';
import { crossingFrame, type CrossingDirection } from '../universe/crossing/crossing-frame';
import { CrossingStage } from '../universe/crossing/crossing-stage';
import { advanceClock, startClock } from '../universe/space/frame-clock';
import { useFlightRecorder, useFrameTimeRecorder } from '../universe/frame-rate/frame-rate-readout';

/** The seed of your own bubble: the film draws yours and the friend's from a seed each (the friend's from their handle). */
const YOURS = 'you';

/** The white of the arrival fades over what is under it for this long (the prototype's flash: about 0.3 s). */
const ARRIVAL_MS = 300;
const NATIVE = Platform.OS !== 'web';

/** The black the film opens on and the cut is made of. */
const GROUND = '#000000';
/** The arrival flash's white (a warm one, as the film's own flash). */
const FLASH = 'rgb(255,250,240)';
/** A skip drops a dark veil of this strength over its jump, which the last moments of the film then lift. */
const VEIL = 0.8;

/** How a crossing ended, for the screen that started it. */
export interface CrossingEnd {
  readonly direction: CrossingDirection;
  /** A dark cut (reduced motion) rather than the film. */
  readonly cut: boolean;
  /** A tap or Escape cut the film short. */
  readonly skipped: boolean;
}

/** The skip target is named for what it does. */
const SKIP_LABEL = 'Skip the crossing';

/** The veil over a skip's jump: full strength at the jump, gone when the film ends. */
const veilOf = (state: CrossingState): number =>
  state.skipped ? VEIL * Math.max(0, 1 - (state.q - 0.985) / 0.015) : 0;

/**
 * The crossing over a visit (Round 7.3, behind the device switch): the film full screen, or a dark cut under reduced
 * motion, then the white of the arrival fading over what is under it. The {@link CrossingDirector} decides what is
 * on screen; this draws it, runs its clock, and says where the person is going once.
 *
 * Always mounted while the switch is on, because a live region that is removed is not read, and a browser sends the
 * rest of a touch to the element it started on: had the skip target gone with the film, a finger that came down during
 * it would never be heard to lift. Between crossings the target lets every touch through, is out of the tab order and is
 * hidden from assistive technology; its role never changes (the role picks the element on the web).
 */
export function VisitCrossing({
  director,
  handle,
  onEnd,
}: {
  readonly director: CrossingDirector;
  /** The friend's public handle, which seeds their bubble before the read has given anything else. */
  readonly handle: string;
  readonly onEnd: (end: CrossingEnd) => void;
}) {
  const state = useSyncExternalStore(director.subscribe, director.getState, director.getState);
  const recordFrame = useFrameTimeRecorder();
  const recordLeg = useFlightRecorder();
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ width, height });
  }, []);
  const live = useRef({ onEnd, recordLeg });
  useEffect(() => {
    live.current = { onEnd, recordLeg };
  });
  const playing = state.mode === 'film' || state.mode === 'cut';

  // The clock: from the moment a crossing starts, one step a drawn frame, until the director says it is over. A film
  // is also reported to the frame-rate readout as one flight, from its start to the end of the film.
  useEffect(() => {
    if (!playing) return;
    let clock = startClock();
    let handleId = 0;
    const startedMs = performance.now();
    const tick = (nowMs: number): void => {
      const step = advanceClock(clock, nowMs);
      clock = step.clock;
      if (step.draw) {
        director.advance(clock.t);
        const now = director.getState();
        if (now.mode !== 'film' && now.mode !== 'cut') {
          if (now.mode === 'arrival')
            live.current.recordLeg?.({
              label: now.direction === 'home' ? 'crossing home' : 'crossing',
              startMs: startedMs,
              endMs: performance.now(),
              programsLinked: 0,
            });
          return;
        }
      }
      handleId = requestAnimationFrame(tick);
    };
    handleId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handleId);
  }, [playing, state.runs, director]);

  // Escape skips, as a tap does.
  useEffect(() => {
    if (!playing || Platform.OS !== 'web') return;
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') director.skip();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [playing, director]);

  // The screen that started the crossing is told once when it has ended, however it ended (a stop is not an end).
  useEffect(() => {
    if (state.ended === null || state.ended === 'stopped') return;
    live.current.onEnd({ direction: state.direction, cut: state.cut, skipped: state.ended === 'skipped' });
  }, [state.ended, state.runs, state.direction, state.cut]);

  const frame = useMemo(
    () =>
      size === null || state.mode !== 'film'
        ? null
        : crossingFrame(state.q, state.direction, {
            size,
            friendName: state.friendName ?? UNKNOWN_FRIEND,
            names: state.names,
            seconds: state.seconds,
          }),
    [size, state.mode, state.q, state.direction, state.friendName, state.names, state.seconds],
  );
  const friendSeed = `friend:${handle}`;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={onLayout} testID="visit-crossing">
      {state.mode === 'film' ? (
        <View pointerEvents="none" style={styles.fill} testID="visit-crossing-film">
          {frame === null || size === null ? null : (
            <CrossingStage
              key={state.runs}
              frame={frame}
              size={size}
              behindSeed={state.direction === 'home' ? friendSeed : YOURS}
              aheadSeed={state.direction === 'home' ? YOURS : friendSeed}
              {...(recordFrame ? { onFrameTime: recordFrame } : {})}
            />
          )}
          {state.skipped ? (
            <View pointerEvents="none" style={[styles.fill, styles.veil, { opacity: veilOf(state) }]} />
          ) : null}
        </View>
      ) : null}
      {state.mode === 'cut' ? <View pointerEvents="none" style={styles.fill} testID="visit-crossing-cut" /> : null}
      {state.mode === 'arrival' ? <Arrival onDone={director.arrived} /> : null}
      <Pressable
        style={StyleSheet.absoluteFill}
        pointerEvents={playing ? 'auto' : 'none'}
        focusable={false}
        tabIndex={-1}
        accessibilityRole="button"
        {...(playing ? { accessibilityLabel: SKIP_LABEL } : HIDDEN)}
        onPress={playing ? director.skip : undefined}
        testID="visit-crossing-skip"
      />
      {/* Always there, so a screen reader hears the line when it appears, once; empty between crossings. */}
      <View pointerEvents="none" style={styles.line} accessibilityLiveRegion="polite" testID="visit-crossing-line">
        {state.announcement === null ? null : (
          <Text variant="label" testID="visit-crossing-announcement">
            {state.announcement}
          </Text>
        )}
      </View>
    </View>
  );
}

/** Out of reach of assistive technology: the skip target between crossings. */
const HIDDEN = {
  'aria-hidden': true,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

/** The film ended white; the white lets go of what is under it. */
function Arrival({ onDone }: { readonly onDone: () => void }) {
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const fade = Animated.timing(opacity, { toValue: 0, duration: ARRIVAL_MS, useNativeDriver: NATIVE });
    fade.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => fade.stop();
  }, [opacity, onDone]);
  return (
    <Animated.View
      pointerEvents="none"
      testID="visit-crossing-arrival"
      style={[styles.fill, styles.flash, { opacity }]}
    />
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, backgroundColor: GROUND },
  flash: { backgroundColor: FLASH },
  veil: { backgroundColor: GROUND },
  // Read, not seen: one pixel, clipped, still in the page so that a change to it is announced.
  line: { position: 'absolute', left: 0, bottom: 0, width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});
