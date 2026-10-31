import { smoothstep } from './easing';
import { chromeAt as planetChrome } from './enter-planet';
import { chromeAt as systemChrome } from './enter-system';
import { enterWorldFrame } from './enter-world';
import type { Rising } from './animated';
import type { StepAnimation } from './use-universe-animation';

/**
 * When each piece of the Universe's chrome leaves and arrives during a step down (design: "The tab bar
 * never moves. Everything else fades out in about 0.3 s at the start", "Destination chrome rises in
 * last"). A piece with no entry is not part of that animation: it stays as it is. Each is a pure
 * function of `t`; the tab bar is not drawn by this screen and is never touched.
 */
export interface StepChrome {
  /** The header of the screen being left fades; the destination's rises. */
  readonly headerOut?: (t: number) => Rising;
  readonly headerIn?: (t: number) => Rising;
  /** The title and hint on the globe (U03). */
  readonly captionOut?: (t: number) => Rising;
  readonly captionIn?: (t: number) => Rising;
  /** The chips along the bottom. */
  readonly chipsOut?: (t: number) => Rising;
  readonly chipsIn?: (t: number) => Rising;
}

const fade =
  (opacity: (t: number) => number) =>
  (t: number): Rising => ({ opacity: opacity(t), offset: 0 });

export function stepChrome(kind: StepAnimation['kind'], size: { width: number; height: number }): StepChrome {
  if (kind === 'enter-system')
    return {
      headerOut: fade((t) => systemChrome(t).overviewOpacity),
      headerIn: (t) => systemChrome(t).back,
      chipsOut: fade((t) => systemChrome(t).overviewOpacity),
      chipsIn: (t) => systemChrome(t).bottom,
    };
  if (kind === 'enter-world') {
    const scene = { screen: size, globe: { x: size.width / 2, y: size.height * 0.44, radius: 146 } };
    return {
      headerOut: fade((t) => 1 - enterWorldFrame(t, scene).leaving),
      captionOut: fade((t) => 1 - enterWorldFrame(t, scene).leaving),
      headerIn: fade((t) => smoothstep(2.45, 2.9, t)),
    };
  }
  return {
    headerOut: fade((t) => planetChrome(t).systemOpacity),
    headerIn: (t) => planetChrome(t).back,
    captionIn: (t) => planetChrome(t).title,
    chipsOut: fade((t) => planetChrome(t).systemOpacity),
    chipsIn: (t) => planetChrome(t).chips,
  };
}
