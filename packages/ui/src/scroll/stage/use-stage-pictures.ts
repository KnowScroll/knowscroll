import { useEffect, useRef, useState } from 'react';
import { easing, motion } from '@knowscroll/design-tokens';
import { canTween, lerpScene, type EarthSkyScene } from '../kit';

/** How the picture last changed: not yet, drawn between the two states, faded from one to the other, or set at once. */
export type StageTransition = 'none' | 'tween' | 'crossfade';

/** What to draw this frame: one or two pictures, each with its opacity. */
export interface StagePictures {
  readonly layers: readonly { readonly key: string; readonly scene: EarthSkyScene; readonly opacity: number }[];
  readonly transition: StageTransition;
}

/** The standard deceleration curve of the motion tokens, as a function of progress (a cubic Bezier solved by bisection). */
function ease(t: number): number {
  const [x1, y1, x2, y2] = easing.standard;
  const axis = (p1: number, p2: number, at: number): number =>
    3 * (1 - at) * (1 - at) * at * p1 + 3 * (1 - at) * at * at * p2 + at * at * at;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    if (axis(x1, x2, middle) < t) low = middle;
    else high = middle;
  }
  return axis(y1, y2, (low + high) / 2);
}

interface Shown {
  readonly key: string;
  readonly scene: EarthSkyScene;
}

/**
 * The stage's picture over time (D-133). When the current state changes: the same view moves (Earth
 * glides along its orbit, the axis turns) over the subject motion token's 320 ms; a different view
 * fades from the old picture to the new one. Under reduced motion nothing moves in between: the two
 * pictures cross-fade over the token's reduced 160 ms. A new change while one is under way starts
 * from the picture on screen, so a quick run of dot taps never jumps.
 */
export function useStagePictures(target: Shown, reducedMotion: boolean): StagePictures {
  const [frame, setFrame] = useState<{ from: Shown; to: Shown; progress: number; transition: StageTransition }>({
    from: target,
    to: target,
    progress: 1,
    transition: 'none',
  });
  const onScreen = useRef<Shown>(target);
  const settled = useRef(target.key);
  const latest = useRef(target);
  useEffect(() => {
    latest.current = target;
  });
  useEffect(() => {
    if (settled.current === target.key) return;
    settled.current = target.key;
    const to = latest.current;
    const from = onScreen.current;
    const transition: StageTransition = !reducedMotion && canTween(from.scene, to.scene) ? 'tween' : 'crossfade';
    const duration = reducedMotion ? motion.subject.reduced.duration : motion.subject.duration;
    const startedAt = Date.now();
    let handle = 0;
    const step = (): void => {
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      onScreen.current =
        progress >= 1
          ? to
          : transition === 'tween'
            ? { key: to.key, scene: lerpScene(from.scene, to.scene, ease(progress)) }
            : from;
      setFrame({ from, to, progress, transition });
      if (progress < 1) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [target.key, reducedMotion]);
  if (frame.transition === 'none' || frame.progress >= 1) {
    return { layers: [{ key: frame.to.key, scene: frame.to.scene, opacity: 1 }], transition: frame.transition };
  }
  if (frame.transition === 'tween') {
    return {
      layers: [
        { key: frame.to.key, scene: lerpScene(frame.from.scene, frame.to.scene, ease(frame.progress)), opacity: 1 },
      ],
      transition: 'tween',
    };
  }
  return {
    layers: [
      { key: frame.from.key, scene: frame.from.scene, opacity: 1 - frame.progress },
      { key: frame.to.key, scene: frame.to.scene, opacity: frame.progress },
    ],
    transition: 'crossfade',
  };
}
