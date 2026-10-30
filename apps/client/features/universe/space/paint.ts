/**
 * Small deterministic helpers for painting the space views: a seeded random stream, colour ramps
 * and low-frequency noise. They are the design's own (`new-universe.html`, "Space views") without
 * a DOM, so the same seed paints the same pixels on the web and on Hermes.
 *
 * `Math.sin` and `Math.cos` are used only for decoration here. Anything that must be identical
 * across engines (planet globes, region borders) is generated in `packages/scene-core` with
 * pinned maths instead.
 */

export type Rgb = readonly [number, number, number];

export const TAU = Math.PI * 2;

export const clamp = (value: number, low = 0, high = 1): number => (value < low ? low : value > high ? high : value);
export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/** Hermite smoothstep between two edges (either order). */
export function smooth(edgeA: number, edgeB: number, value: number): number {
  const x = clamp((value - edgeA) / (edgeB - edgeA));
  return x * x * (3 - 2 * x);
}

export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [lerp(from[0], to[0], amount), lerp(from[1], to[1], amount), lerp(from[2], to[2], amount)];
}

/** A stream of numbers in [0, 1) that depends only on `seed` (FNV-1a hash into mulberry32). */
export function seededRandom(seed: string): () => number {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return () => {
    hash += 0x6d2b79f5;
    let mixed = hash;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** HSL (degrees, percent, percent) to 0..255 RGB. */
export function hsl(hue: number, saturation: number, lightness: number): Rgb {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const channel = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}

/** `#rrggbb` to 0..1 floats. */
export function hexToUnit(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** A smooth walk along colour stops, `amount` in 0..1. */
export function ramp(stops: readonly Rgb[], amount: number): Rgb {
  const last = stops.length - 1;
  const position = clamp(amount) * last;
  const index = Math.min(last - 1, Math.floor(position));
  const local = position - index;
  return mixRgb(stops[index]!, stops[index + 1]!, local * local * (3 - 2 * local));
}

const permutation = (() => {
  const order = Array.from({ length: 256 }, (_, index) => index);
  const random = seededRandom('knowscroll');
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return Uint8Array.from({ length: 512 }, (_, index) => order[index & 255]!);
})();

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

/** Classic 3D gradient noise, roughly in -1..1. */
export function noise(px: number, py: number, pz: number): number {
  const cellX = Math.floor(px);
  const cellY = Math.floor(py);
  const cellZ = Math.floor(pz);
  const x = px - cellX;
  const y = py - cellY;
  const z = pz - cellZ;
  const X = cellX & 255;
  const Y = cellY & 255;
  const Z = cellZ & 255;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const p = permutation;
  const A = p[X]! + Y;
  const AA = p[A]! + Z;
  const AB = p[A + 1]! + Z;
  const B = p[X + 1]! + Y;
  const BA = p[B]! + Z;
  const BB = p[B + 1]! + Z;
  return lerp(
    lerp(
      lerp(gradient(p[AA]!, x, y, z), gradient(p[BA]!, x - 1, y, z), u),
      lerp(gradient(p[AB]!, x, y - 1, z), gradient(p[BB]!, x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(gradient(p[AA + 1]!, x, y, z - 1), gradient(p[BA + 1]!, x - 1, y, z - 1), u),
      lerp(gradient(p[AB + 1]!, x, y - 1, z - 1), gradient(p[BB + 1]!, x - 1, y - 1, z - 1), u),
      v,
    ),
    w,
  );
}

/** Fractal noise: `octaves` layers of {@link noise}. */
export function fbm(x: number, y: number, z: number, octaves = 3): number {
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * noise(x * frequency, y * frequency, z * frequency);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return sum;
}
