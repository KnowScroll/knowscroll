/**
 * The easing rules of the five Universe animations (design: "Rules for all of them"): smooth starts and
 * smooth stops only, no springs and no bounce. Pure maths, so a frame is the same on the web and on Hermes.
 */

export const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/** Hermite smoothstep between two edges (either order). */
export function smoothstep(edgeA: number, edgeB: number, value: number): number {
  const x = clamp01((value - edgeA) / (edgeB - edgeA));
  return x * x * (3 - 2 * x);
}

/** Ken Perlin's smootherstep, 6x^5 - 15x^4 + 10x^3, of a value already scaled to 0..1. */
export function smootherstep(value: number): number {
  const x = clamp01(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Ease-out cubic of a value scaled to 0..1: things that appear. */
export const easeOut = (value: number): number => 1 - Math.pow(1 - clamp01(value), 3);

/**
 * A distance that shrinks a lot moves on a log curve, d0 * (d1 / d0)^e, so speed feels even from far to
 * near. Both distances must be positive.
 */
export const logLerp = (from: number, to: number, amount: number): number => from * Math.pow(to / from, amount);

/** How far through `[start, end]` a time is, 0..1. */
export const progress = (time: number, start: number, end: number): number => clamp01((time - start) / (end - start));

/**
 * The rise of a piece of destination chrome (design: each 0.45 to 0.6 s, 0.1 s apart, rising 8 to 10 px):
 * its opacity and how far below its place it still is, in pixels.
 */
export function rise(time: number, start: number, end: number, distance: number): { opacity: number; offset: number } {
  const amount = smoothstep(start, end, time);
  return { opacity: amount, offset: (1 - amount) * distance + 0 };
}
