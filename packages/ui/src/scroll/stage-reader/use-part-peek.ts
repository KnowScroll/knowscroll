import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, type LayoutChangeEvent } from 'react-native';
import type { NextPartPeek } from './end-tray';
import { SWIPE_DISTANCE, type PartDrag } from './part-gesture';
import { notePartSwipeCommitted } from './part-handoff';
import type { PeekSide } from './part-peek';

/** How long a Part that a swipe asked for is waited for before its panel is put away (a failed or slow open). */
const WAIT_MS = 6_000;
/** How long the panel takes to settle: onto the screen when the swipe counts, back to its edge when it does not. */
const SETTLE_MS = 140;

/**
 * What a sideways drag brings in under the finger (V3 G2, E1): the Part it would open, from the edge that Part waits at,
 * following the finger, and settling when the finger lets go: it fills the area when the swipe counts (and stays until the
 * Part opens, or is put away if none does), and goes back to its edge when it does not. Nothing is drawn under reduced
 * motion, nor for a Part nobody admitted; the move itself is `onMove`'s, decided at release as before.
 */
export function usePartPeek(input: {
  readonly next: NextPartPeek | undefined;
  readonly previous: NextPartPeek | undefined;
  readonly reducedMotion: boolean;
}) {
  const [dx] = useState(() => new Animated.Value(0));
  const [side, setSide] = useState<PeekSide | undefined>();
  const [past, setPast] = useState(false);
  const [width, setWidth] = useState(0);
  const latest = useRef({ ...input, width });
  useEffect(() => {
    latest.current = { ...input, width };
  });
  const waiting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(waiting.current), []);

  const putAway = useCallback(() => {
    Animated.timing(dx, { toValue: 0, duration: SETTLE_MS, useNativeDriver: false }).start(() => setSide(undefined));
  }, [dx]);

  const onDrag = useCallback(
    (drag: PartDrag) => {
      const { next, previous, reducedMotion, width: area } = latest.current;
      if (drag.kind === 'pull' || reducedMotion) return;
      if (drag.kind === 'part') {
        const towards: PeekSide = drag.dx < 0 ? 'next' : 'previous';
        if (drag.dx === 0 || (towards === 'next' ? next : previous) === undefined) {
          dx.setValue(0);
          setSide(undefined);
          setPast(false);
          return;
        }
        clearTimeout(waiting.current);
        dx.setValue(drag.dx);
        setSide(towards);
        setPast(Math.abs(drag.dx) >= SWIPE_DISTANCE);
        return;
      }
      const opens = drag.move === 'next-part' ? next : drag.move === 'previous-part' ? previous : undefined;
      if (opens === undefined) {
        putAway();
        setPast(false);
        return;
      }
      notePartSwipeCommitted();
      Animated.timing(dx, {
        toValue: drag.move === 'next-part' ? -area : area,
        duration: SETTLE_MS,
        useNativeDriver: false,
      }).start();
      waiting.current = setTimeout(putAway, WAIT_MS);
    },
    [dx, putAway],
  );

  return {
    dx,
    side,
    past,
    width,
    onDrag,
    onAreaLayout: (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
  };
}
