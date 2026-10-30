import { useMemo, useRef } from 'react';
import { Animated, Platform, Vibration, type GestureResponderEvent } from 'react-native';

/** How far a bubble must be dragged right to count as a reply (T3 kit: 60 px, with a haptic tick). */
export const SWIPE_REPLY_DISTANCE = 60;
/** The bubble stops following the finger a little past the threshold. */
const SWIPE_LIMIT = 84;
/** A drag counts as a swipe only while it is clearly more across than down, so scrolling stays scrolling. */
const SWIPE_LOCK = 12;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The touch point of an event, on the web (a DOM TouchEvent) and on a phone alike. */
function pointOf(event: GestureResponderEvent): Point | undefined {
  const native = event.nativeEvent as unknown as {
    touches?: ArrayLike<{ pageX: number; pageY: number }>;
    pageX?: number;
    pageY?: number;
  };
  const touch = native.touches?.[0];
  if (touch !== undefined) return { x: touch.pageX, y: touch.pageY };
  return native.pageX === undefined || native.pageY === undefined ? undefined : { x: native.pageX, y: native.pageY };
}

/**
 * Swipe right to reply (T3 kit). It listens to touch events only, so a mouse never drags a bubble: a
 * desktop has the menu, the ⋯ button and the R key instead (D-053). The bubble follows the finger to
 * a limit, a reply arrow appears behind it, a tick marks 60 px, and letting go past that asks to
 * reply; either way the bubble returns. Under reduced motion nothing slides: the reply is asked for
 * when the finger lifts past 60 px.
 */
export function useSwipeToReply(options: {
  readonly enabled: boolean;
  readonly reducedMotion: boolean;
  readonly onReply: () => void;
}) {
  const { enabled, reducedMotion, onReply } = options;
  const shift = useRef(new Animated.Value(0)).current;
  const gesture = useRef<{ start: Point; swiping: boolean; ticked: boolean; across: number } | undefined>(undefined);
  const latest = useRef({ onReply, reducedMotion });
  latest.current = { onReply, reducedMotion };

  return useMemo(() => {
    const settle = () => {
      gesture.current = undefined;
      if (latest.current.reducedMotion) shift.setValue(0);
      else Animated.spring(shift, { toValue: 0, useNativeDriver: Platform.OS !== 'web', bounciness: 6 }).start();
    };
    const handlers = enabled
      ? {
          onTouchStart: (event: GestureResponderEvent) => {
            const start = pointOf(event);
            gesture.current = start === undefined ? undefined : { start, swiping: false, ticked: false, across: 0 };
          },
          onTouchMove: (event: GestureResponderEvent) => {
            const current = gesture.current;
            const point = pointOf(event);
            if (current === undefined || point === undefined) return;
            const across = point.x - current.start.x;
            const down = Math.abs(point.y - current.start.y);
            if (!current.swiping) {
              if (across > SWIPE_LOCK && across > down * 2) current.swiping = true;
              else if (down > SWIPE_LOCK) gesture.current = undefined;
              else return;
            }
            const moved = Math.min(Math.max(across, 0), SWIPE_LIMIT);
            current.across = moved;
            if (!latest.current.reducedMotion) shift.setValue(moved);
            if (moved >= SWIPE_REPLY_DISTANCE && !current.ticked) {
              current.ticked = true;
              if (Platform.OS !== 'web') Vibration.vibrate(8);
            }
          },
          onTouchEnd: () => {
            const current = gesture.current;
            // Where the finger lifted, not how far it once went: pulling back under 60 px cancels.
            const reached = current?.swiping === true && current.across >= SWIPE_REPLY_DISTANCE;
            settle();
            if (reached) latest.current.onReply();
          },
          onTouchCancel: settle,
        }
      : {};
    return {
      handlers,
      /** Spread into the style of the row that slides. */
      slide: { transform: [{ translateX: shift }] },
      /** 0 to 1 while the arrow shows. */
      arrow: shift.interpolate({ inputRange: [0, SWIPE_REPLY_DISTANCE], outputRange: [0, 1], extrapolate: 'clamp' }),
    };
  }, [enabled, shift]);
}
