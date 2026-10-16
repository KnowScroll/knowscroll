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
  /** Lens and film treatment for this moment (the cinematic grade). */
  post: {
    bloom: number;
    streak: number;
    rays: number;
    /** World point the light shafts come from, when there are any. */
    rayFrom: Vec3 | null;
    shock: number;
    shockRadius: number;
    chroma: number;
    grain: number;
    vignette: number;
    /** 1 while the story is framed in cinema bars; 0 once it opens into the Universe. */
    letterbox: number;
    grade: number;
  };
  /** Depth of field: focal distance (world units) and aperture (0 = everything sharp). */
  dof: { focus: number; aperture: number };
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

/** A slow, gentle sway, as if the camera were held, plus a short decaying shake at the expansion.
 * Built from fixed sines, so it is part of the deterministic timeline. */
function cameraLife(time: number, eye: Vec3, target: Vec3): { eye: Vec3; target: Vec3 } {
  const distance = Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]);
  const sway = distance * (0.0045 + 0.004 * smooth(13.6, 15.4, time) * (1 - smooth(19.6, 21.6, time))) * (1 - smooth(25.6, 27.6, time));
  const hand: Vec3 = [
    Math.sin(time * 0.71) * 0.6 + Math.sin(time * 1.37 + 1.3) * 0.4,
    Math.sin(time * 0.53 + 2.1) * 0.6 + Math.sin(time * 1.11) * 0.4,
    Math.sin(time * 0.37 + 0.7),
  ];
  const kick = time >= 3.6 ? Math.exp(-(time - 3.6) / 0.32) * distance * 0.022 : 0;
  const shake: Vec3 = [Math.sin(time * 37.0) * kick, Math.sin(time * 41.0 + 1.0) * kick, 0];
  return {
    eye: [eye[0] + hand[0] * sway + shake[0], eye[1] + hand[1] * sway + shake[1], eye[2] + hand[2] * sway],
    target: [target[0] + hand[0] * sway * 0.4 + shake[0] * 0.6, target[1] + hand[1] * sway * 0.4 + shake[1] * 0.6, target[2]],
  };
}

const bump = (centre: number, width: number, x: number) => Math.exp(-(((x - centre) / width) ** 2));

export function frameAt(t: number): OriginFrame {
  const time = Math.max(0, Math.min(ORIGIN_DURATION, t));
  const path = cameraAt(time);
  const camera = { ...cameraLife(time, path.eye, path.target), fovY: (58 * Math.PI) / 180 };
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
      intensity: (centralOn + flash(0)) * mix(1.1, 0.62, swell) * mix(1, 1.6, shed) * remnantFade,
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
  if (bangGlow > 0.001) gas.push({ kind: 'bang', pos: ORIGIN, radius: mix(0.15, 2.1, smooth(bang, bang + 3.0, time)), color: [1.0, 0.78, 0.52], density: bangGlow * 0.5, a: 0, b: 0 });
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
  const subject = Math.hypot(path.eye[0] - path.target[0], path.eye[1] - path.target[1], path.eye[2] - path.target[2]);
  const release = smooth(17.1, 17.6, time) * (1 - smooth(18.6, 21.0, time));
  const ignitionGlow = smooth(11.4, 12.0, time) * (1 - smooth(13.2, 14.6, time));
  const post: OriginFrame['post'] = {
    bloom: 0.38 + 0.32 * bump(bang + 0.35, 0.7, time) + 0.3 * ignitionGlow + 0.25 * smooth(15.4, 17.2, time) * (1 - smooth(19.6, 21.0, time)) + 0.12 * release + 0.15 * smooth(21.5, 23.5, time) * (1 - smooth(25.4, 27.4, time)),
    streak: 0.08 + 0.1 * bump(bang + 0.3, 0.5, time) + 0.13 * ignitionGlow + 0.06 * release,
    rays: 0.32 * bump(bang + 0.45, 0.6, time) + 0.36 * smooth(15.6, 16.9, time) * (1 - smooth(17.1, 17.8, time)) + 0.12 * smooth(18.2, 19.0, time) * (1 - smooth(19.6, 21.0, time)),
    rayFrom: time < 9 ? ORIGIN : time < 21.5 ? STAR : DISK,
    shock: time >= bang ? Math.exp(-(time - bang) / 0.55) * smooth(bang, bang + 0.05, time) : 0,
    shockRadius: Math.max(0, time - bang) * 0.85,
    chroma: 0.0016 + 0.006 * bump(bang + 0.15, 0.45, time) + 0.0018 * release,
    grain: 0.034 * (1 - 0.6 * smooth(25.4, 27.8, time)),
    vignette: 0.62 * (1 - smooth(25.2, 27.8, time)) + 0.08,
    letterbox: 1 - smooth(25.2, 27.4, time),
    grade: 1 - 0.85 * smooth(25.6, 28.0, time),
  };
  // Focus follows the subject; the aperture opens for close, intimate shots and as matter streams
  // past, and closes as the scene settles into the (sharp) Universe.
  const aperture = 0.014 + 0.03 * smooth(bang + 0.4, 5.0, time) * (1 - smooth(7.6, 9.4, time))
    + 0.03 * smooth(13.6, 15.2, time) * (1 - smooth(19.4, 21.0, time))
    + 0.022 * smooth(21.0, 22.6, time) * (1 - smooth(24.8, 26.4, time));
  const exposure = 1 + 0.32 * bump(bang + 0.1, 0.18, time) - 0.3 * bump(bang + 0.75, 0.55, time) - 0.18 * release;
  return {
    t: time,
    act: actAt(time),
    camera,
    black: 1 - smooth(0, 0.9, time),
    exposure,
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
    post,
    dof: { focus: Math.max(0.4, subject), aperture: aperture * (1 - smooth(25.4, 27.2, time)) },
    farStars: 0.32 * smooth(9.0, 12.5, time) * (1 - 0.6 * smooth(14, 16, time)) + smooth(24.2, 27.4, time),
    caption: text,
    captionOpacity: opacity,
    overlay: 1 - smooth(HANDOFF_START, ORIGIN_DURATION, time),
  };
}
