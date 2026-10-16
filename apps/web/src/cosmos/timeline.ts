/**
 * The origin opening as a pure function of time. `frameAt(t)` returns everything a renderer needs
 * for one frame, so the sequence is deterministic, seekable and testable, and a still for reduced
 * motion is just a frame at a chosen time. Timescales are compressed artistically: about 28 s for
 * emptiness → expansion → clouds → first stars → one star's lifecycle → released material → a disk
 * where new worlds condense → the reader's own Universe (ADR-0049 §5).
 *
 * Physical notes the drawing respects: the central star is sun-like, so it swells and sheds its
 * envelope as a shell (a planetary nebula) and leaves a small hot remnant — it does not explode;
 * the released, enriched material joins a new cloud that collapses into a rotating disk, and the
 * worlds in that disk grow gradually inside its gaps rather than appearing finished.
 */
import type { Vec3 } from './gl/glkit.ts';

export const ORIGIN_DURATION = 28.4;

/** Act boundaries, used for the reduced-motion stills, tests and the preview scrubber. */
export const ACTS = [
  { id: 'before', label: 'Before form', start: 0, end: 3.6 },
  { id: 'expansion', label: 'Expansion', start: 3.6, end: 8.6 },
  { id: 'first-stars', label: 'The first stars', start: 8.6, end: 13.6 },
  { id: 'transformation', label: 'Transformation', start: 13.6, end: 19.6 },
  { id: 'new-worlds', label: 'New worlds', start: 19.6, end: 25.2 },
  { id: 'enter', label: 'Your universe', start: 25.2, end: ORIGIN_DURATION },
] as const;

export type ActId = (typeof ACTS)[number]['id'];

export const CAPTIONS = [
  { id: 'began', text: 'Your world began before you knew it.', start: 21.3, end: 23.9 },
  { id: 'shape', text: 'Every idea can change its shape.', start: 23.9, end: 26.4 },
] as const;

/** The overlay starts dissolving into the live Universe here and is gone at the end. */
export const HANDOFF_START = 26.2;

/** Times the reduced-motion version holds as stills, one per act, with the captions where they fall. */
export const STILLS: { act: ActId; t: number; caption: string | null }[] = [
  { act: 'before', t: 3.1, caption: null },
  { act: 'expansion', t: 6.4, caption: null },
  { act: 'first-stars', t: 12.9, caption: null },
  { act: 'transformation', t: 18.6, caption: null },
  { act: 'new-worlds', t: 22.6, caption: 'Your world began before you knew it.' },
  { act: 'new-worlds', t: 24.6, caption: 'Every idea can change its shape.' },
];

const ORIGIN: Vec3 = [0, 0, 0];
export const CORES: Vec3[] = [
  [0, 0, 0],
  [-1.55, 0.62, -1.25],
  [1.72, -0.42, -1.8],
  [-0.85, -1.15, -2.6],
  [1.05, 1.22, -2.25],
];
const STAR: Vec3 = CORES[0]!;
export const DISK: Vec3 = [2.7, -0.75, -2.1];
const DISK_TILT = 0.42;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return 1 - (1 - t) ** 3;
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

interface CameraKey {
  t: number;
  eye: Vec3;
  target: Vec3;
}

const CAMERA: CameraKey[] = [
  { t: 0, eye: [0, 0, 2.7], target: ORIGIN },
  { t: 3.6, eye: [0, 0, 2.35], target: ORIGIN },
  { t: 8.6, eye: [0.35, 0.22, 8.6], target: ORIGIN },
  { t: 12.4, eye: [0.25, 0.3, 3.7], target: STAR },
  { t: 15.4, eye: [0.06, 0.08, 1.2], target: STAR },
  { t: 17.6, eye: [0.02, 0.1, 1.55], target: STAR },
  { t: 19.6, eye: [0.2, 0.32, 3.4], target: [0.12, -0.02, -0.1] },
  { t: 21.8, eye: add3(DISK, [-0.45, 0.62, 2.5]), target: mix3(STAR, DISK, 0.82) },
  { t: 24.8, eye: add3(DISK, [0.0, 0.78, 2.05]), target: DISK },
  { t: ORIGIN_DURATION, eye: add3(DISK, [0.0, 0.18, 5.2]), target: DISK },
];

/** Smooth keyframe interpolation: each segment eases in and out, so the camera never jolts. */
function cameraAt(t: number): { eye: Vec3; target: Vec3 } {
  const last = CAMERA[CAMERA.length - 1]!;
  if (t >= last.t) return { eye: last.eye, target: last.target };
  for (let i = 0; i < CAMERA.length - 1; i++) {
    const a = CAMERA[i]!;
    const b = CAMERA[i + 1]!;
    if (t >= a.t && t < b.t) {
      const k = smooth(a.t, b.t, t);
      return { eye: mix3(a.eye, b.eye, k), target: mix3(a.target, b.target, k) };
    }
  }
  return { eye: CAMERA[0]!.eye, target: CAMERA[0]!.target };
}

export interface Billboard {
  pos: Vec3;
  radius: number;
  color: Vec3;
  intensity: number;
  granulation: number;
  tension: number;
  mode: 0 | 1 | 2;
  seed: number;
}

export type GasKind = 'cloud' | 'bang' | 'shell' | 'disk' | 'seed';
export interface GasBlob {
  kind: GasKind;
  /** World-space centre, projected by the renderer; `screen` overrides it (the handoff). */
  pos: Vec3;
  /** World-space radius (or CSS px when `screen` is set). */
  radius: number;
  color: Vec3;
  density: number;
  /** cloud: density bias; shell: ring radius; disk: density. */
  a: number;
  /** shell: ellipticity; disk: tilt ratio. */
  b: number;
  screen?: 'seed-target';
}

export interface OriginFrame {
  t: number;
  act: ActId;
  camera: { eye: Vec3; target: Vec3; fovY: number };
  black: number;
  exposure: number;
  gain: number;
  ground: Vec3;
  matter: {
    scale: number;
    heat: number;
    web: number;
    gather: number;
    compress: number;
    consume: number;
    envR: number;
    eject: number;
    matFade: number;
    stream: number;
    diskForm: number;
    diskSpin: number;
    diskFade: number;
    fragments: number;
  };
  billboards: Billboard[];
  gas: GasBlob[];
  ambient: number;
  farStars: number;
  caption: string | null;
  captionOpacity: number;
  /** 1 while the opening covers the Universe, falling to 0 as the live interface takes over. */
  overlay: number;
}

const YOUNG: Vec3 = [1.0, 0.84, 0.58];
const GIANT: Vec3 = [1.0, 0.42, 0.2];
const REMNANT: Vec3 = [0.7, 0.84, 1.0];
const FIRST_STAR: Vec3[] = [YOUNG, [0.78, 0.86, 1.0], [1.0, 0.92, 0.75], [0.62, 0.9, 1.0], [1.0, 0.76, 0.52]];
/** World colours borrow the app's own palette: teal, cobalt, cream-gold and pink. */
const WORLD_COLORS: Vec3[] = [[0.2, 0.85, 0.72], [0.28, 0.4, 0.98], [1.0, 0.86, 0.55], [0.93, 0.53, 0.7]];
const WORLD_ORBITS = [0.25, 0.38, 0.62, 0.86];
const WORLD_SIZES = [0.026, 0.04, 0.052, 0.034];

function rotX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
}

export function actAt(t: number): ActId {
  for (const act of ACTS) if (t < act.end) return act.id;
  return 'enter';
}

export function captionAt(t: number): { text: string | null; opacity: number } {
  for (const caption of CAPTIONS) {
    if (t >= caption.start && t < caption.end) {
      const opacity = Math.min(smooth(caption.start, caption.start + 0.7, t), 1 - smooth(caption.end - 0.6, caption.end, t));
      return { text: caption.text, opacity };
    }
  }
  return { text: null, opacity: 0 };
}

/** Elapsed disk rotation, integrated so seeking to any time gives the same angle. */
function diskSpinAt(t: number): number {
  return Math.max(0, t - 20.6) * 1.0;
}

export function frameAt(t: number): OriginFrame {
  const time = Math.max(0, Math.min(ORIGIN_DURATION, t));
  const camera = { ...cameraAt(time), fovY: (58 * Math.PI) / 180 };
  const bang = 3.6;

  const scale = time < bang ? 0.0015 : mix(0.0015, 1, 1 - Math.exp(-(time - bang) / 1.3)) * (1 + 0.05 * smooth(8.6, ORIGIN_DURATION, time));
  const heat = time < bang ? 1 : Math.exp(-(time - bang) / 1.15);
  const web = smooth(bang - 0.05, bang + 0.5, time) * (1 - 0.55 * smooth(13.4, 15.6, time)) * (1 - 0.7 * smooth(19.8, 23.5, time)) * (1 - smooth(25.4, 27.4, time));
  const gather = smooth(8.0, 12.4, time);
  const compress = smooth(10.4, 13.1, time);

  // The central star: young, then swelling with energy building, then shedding its envelope.
  const swell = smooth(15.4, 17.3, time);
  const shed = smooth(17.15, 18.5, time);
  const pulse = smooth(16.2, 17.2, time) * (1 - shed);
  let starRadius = mix(0.055, 0.16, swell) * (1 + 0.045 * Math.sin(time * 8.5) * pulse);
  starRadius = mix(starRadius, 0.018, shed);
  const starColor = shed > 0 ? mix3(GIANT, REMNANT, shed) : mix3(YOUNG, GIANT, swell);
  const ignition = (i: number) => smooth(11.3 + i * 0.34, 11.8 + i * 0.34, time);
  const flash = (i: number) => Math.exp(-(((time - (11.75 + i * 0.34)) / 0.28) ** 2)) * 1.6;

  const billboards: Billboard[] = [];
  // Before form: one concentrated presence, breathing.
  const presence = smooth(0.5, 3.3, time) * (1 - smooth(bang, bang + 0.35, time));
  if (presence > 0.001) {
    billboards.push({ pos: ORIGIN, radius: 0.016 + 0.003 * Math.sin(time * 1.7), color: [1.0, 0.93, 0.8], intensity: presence * (0.85 + 0.2 * Math.sin(time * 1.7)) * (1 + 1.4 * smooth(2.6, 3.55, time)), granulation: 0, tension: 0, mode: 0, seed: 0.1 });
  }
  for (let i = 1; i < CORES.length; i++) {
    const on = ignition(i);
    if (on <= 0.001) continue;
    billboards.push({ pos: CORES[i]!, radius: 0.045 + 0.01 * i, color: FIRST_STAR[i]!, intensity: (on + flash(i)) * (1 - 0.5 * smooth(19.5, 23, time)) * (1 - smooth(25.6, 27.4, time)), granulation: 0.4, tension: 0, mode: 0, seed: i * 0.13 });
  }
  const centralOn = ignition(0);
  if (centralOn > 0.001) {
    const remnantFade = 1 - 0.6 * smooth(21.5, 24.5, time) - 0.4 * smooth(25.4, 27.2, time);
    billboards.push({
      pos: STAR,
      radius: starRadius,
      color: starColor,
      intensity: (centralOn + flash(0)) * mix(1.1, 0.62, swell) * mix(1, 3.2, shed) * remnantFade,
      granulation: mix(0.55, 1, swell) * (1 - shed),
      tension: pulse * 0.85,
      mode: 0,
      seed: 0.37,
    });
  }
  // The new system: a young star at the disk's centre and worlds that grow inside the gaps.
  const diskForm = smooth(20.8, 24.0, time);
  const diskFade = 1 - smooth(25.3, 27.3, time);
  const youngOn = smooth(21.6, 23.2, time) * diskFade;
  if (youngOn > 0.001) {
    billboards.push({ pos: DISK, radius: 0.036, color: [1.0, 0.9, 0.7], intensity: youngOn * 1.3, granulation: 0.5, tension: 0, mode: 0, seed: 0.71 });
  }
  const spin = diskSpinAt(time);
  WORLD_ORBITS.forEach((orbit, i) => {
    const grow = smooth(22.0 + i * 0.45, 24.2 + i * 0.4, time) * diskFade;
    if (grow <= 0.001) return;
    const angle = i * 1.9 + 0.6 + spin * 0.32 * orbit ** -1.5;
    const local: Vec3 = [Math.cos(angle) * orbit, 0, Math.sin(angle) * orbit];
    const pos = add3(DISK, rotX(local, DISK_TILT));
    billboards.push({ pos, radius: WORLD_SIZES[i]! * (0.35 + 0.65 * grow), color: WORLD_COLORS[i]!, intensity: grow, granulation: 0, tension: 0, mode: 1, seed: 0.2 + i * 0.17 });
  });

  const gas: GasBlob[] = [];
  const bangGlow = smooth(bang - 0.1, bang + 0.15, time) * (1 - smooth(bang + 0.4, bang + 3.2, time));
  if (presence > 0.001) gas.push({ kind: 'bang', pos: ORIGIN, radius: 0.13 + 0.05 * smooth(2.4, 3.5, time), color: [0.42, 0.36, 0.3], density: presence * (0.3 + 0.35 * smooth(2.4, 3.5, time)), a: 0, b: 0 });
  if (bangGlow > 0.001) gas.push({ kind: 'bang', pos: ORIGIN, radius: mix(0.15, 2.6, smooth(bang, bang + 3.0, time)), color: [1.0, 0.8, 0.55], density: bangGlow * 0.9, a: 0, b: 0 });
  const cloudOn = smooth(8.4, 11.0, time) * (1 - 0.6 * smooth(12.0, 14.5, time)) * (1 - smooth(19.0, 21.5, time));
  if (cloudOn > 0.001) {
    CORES.forEach((core, i) => {
      gas.push({ kind: 'cloud', pos: core, radius: mix(1.1, 0.45, compress), color: i === 0 ? [0.32, 0.36, 0.62] : [0.2, 0.42, 0.55], density: cloudOn * (i === 0 ? 0.55 : 0.4), a: mix(-0.1, 0.2, compress), b: 0 });
    });
  }
  const shellOn = smooth(17.4, 18.6, time) * (1 - smooth(21.0, 23.6, time));
  if (shellOn > 0.001) {
    gas.push({ kind: 'shell', pos: STAR, radius: 1.05, color: [0.6, 0.6, 0.7], density: shellOn * 0.75, a: mix(0.18, 0.62, easeOut(17.3, 21.5, time)), b: 0.35 });
  }
  if (diskForm > 0.001 && diskFade > 0.001) {
    gas.push({ kind: 'disk', pos: DISK, radius: 1.05, color: [0.95, 0.78, 0.5], density: diskForm * diskFade * 0.55, a: 1, b: 0.4 });
    gas.push({ kind: 'cloud', pos: DISK, radius: 1.5, color: [0.25, 0.35, 0.6], density: (1 - diskForm) * smooth(19.8, 21.0, time) * 0.45, a: 0.05, b: 0 });
  }
  const seed = smooth(25.0, 27.6, time);
  if (seed > 0.001) {
    gas.push({ kind: 'seed', pos: DISK, radius: 1, color: [0.3, 0.55, 0.62], density: seed * 0.8, a: 0.15, b: 0, screen: 'seed-target' });
  }

  const { text, opacity } = captionAt(time);
  return {
    t: time,
    act: actAt(time),
    camera,
    black: 1 - smooth(0, 0.9, time),
    exposure: 1.0,
    gain: mix(0.18, 1, smooth(bang + 0.2, bang + 2.4, time)),
    ground: mix3([0.004, 0.008, 0.016], [0.0118, 0.0627, 0.102], smooth(8.0, ORIGIN_DURATION, time)),
    matter: {
      scale,
      heat,
      web,
      gather,
      compress,
      consume: smooth(11.9, 13.8, time),
      envR: starRadius,
      eject: easeOut(17.2, 20.6, time),
      matFade: smooth(17.0, 17.6, time),
      stream: smooth(19.2, 22.0, time),
      diskForm,
      diskSpin: spin,
      diskFade,
      fragments: smooth(22.4, 23.4, time),
    },
    billboards,
    gas,
    ambient: smooth(24.8, 27.6, time),
    farStars: 0.32 * smooth(9.0, 12.5, time) * (1 - 0.6 * smooth(14, 16, time)) + smooth(24.2, 27.4, time),
    caption: text,
    captionOpacity: opacity,
    overlay: 1 - smooth(HANDOFF_START, ORIGIN_DURATION, time),
  };
}
