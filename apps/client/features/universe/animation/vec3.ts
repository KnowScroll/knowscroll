/** The few vector operations the animation paths need. Plain tuples, no three.js, so they run anywhere. */
export type Vec3 = readonly [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function normalize(a: Vec3): Vec3 {
  const size = length(a);
  return size < 1e-9 ? [0, 0, 0] : scale(a, 1 / size);
}
export const mix = (a: Vec3, b: Vec3, amount: number): Vec3 => [
  a[0] + (b[0] - a[0]) * amount,
  a[1] + (b[1] - a[1]) * amount,
  a[2] + (b[2] - a[2]) * amount,
];

/** A cubic Bezier through four points at `s` in 0..1. */
export function bezier(a: Vec3, b: Vec3, c: Vec3, d: Vec3, s: number): Vec3 {
  const u = 1 - s;
  return add(add(scale(a, u * u * u), scale(b, 3 * u * u * s)), add(scale(c, 3 * u * s * s), scale(d, s * s * s)));
}

/** The camera's right, up and backward axes for a camera at `position` looking at `target` with world up +Y. */
export function cameraBasis(position: Vec3, target: Vec3): { right: Vec3; up: Vec3; back: Vec3 } {
  const back = normalize(sub(position, target));
  const right = normalize(cross([0, 1, 0], back));
  return { right, up: cross(back, right), back };
}
