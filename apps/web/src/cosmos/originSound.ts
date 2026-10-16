/**
 * The origin opening's score: optional sound, synthesised with Web Audio so there is no media file
 * to fetch or fail. Off by default; it starts only from the reader's own tap on the sound control
 * (browsers require that gesture anyway).
 *
 * Like the picture (timeline.ts), the score is a function of the opening's clock. Sustained layers
 * are envelopes of opening time sampled into AudioParam curves, and every hit is pinned to the
 * picture event it accompanies, so turning sound on mid-way joins the score where the picture is:
 * cues already passed are skipped and sustained layers start at their current level. The builder
 * targets any BaseAudioContext, so the same score can be rendered offline and measured
 * (`renderOriginScore`, scripts/render-origin-score.mjs).
 *
 * One master bus (gain → glue compressor → limiter → trim), a reverb bus on a generated stereo
 * impulse response, a chorus bus for the pads and a saturation bus that lets the sub hits speak on
 * small speakers. All noise is seeded, so the score is identical on every play.
 */
import { HANDOFF_START, ORIGIN_DURATION } from './timeline.ts';

/** The central star's visible pulse is sin(8.5·t) (timeline.ts); the heartbeat lands on its peaks. */
const PULSE_RATE = 8.5;

/** Picture events the score hits, in opening seconds. They mirror `frameAt` in timeline.ts, and
 * test/unit/originSound.test.ts checks that the picture still changes at each of them. */
export const CUES = {
  /** Before form: the riser starts building into the expansion. */
  riser: 1.8,
  /** The expansion (timeline `bang`). */
  expansion: 3.6,
  firstStars: 8.6,
  /** The five first stars ignite (timeline `flash(i)` peaks). */
  ignitions: [0, 1, 2, 3, 4].map(i => 11.75 + 0.34 * i),
  transformation: 13.6,
  /** The central star starts to swell; its pulse is visible from 16.2 s. */
  heartbeat: 15.4,
  /** The star sheds its envelope (timeline `eject` starts). */
  release: 17.2,
  newWorlds: 19.6,
  /** Each world starts to condense in the disk (timeline `WORLD_ORBITS` growth). */
  worlds: [0, 1, 2, 3].map(i => 22.0 + 0.45 * i),
  /** Fragments glint in the disk (timeline `fragments`). */
  sparkle: [22.4, 23.4] as const,
  enter: 25.2,
  handoff: HANDOFF_START,
  end: ORIGIN_DURATION,
} as const;

/** Heartbeats: the peaks of the star's pulse between the start of the swell and the release. */
export const HEARTBEATS: readonly number[] = (() => {
  const beats: number[] = [];
  for (let k = 0; ; k++) {
    const t = (Math.PI / 2 + 2 * Math.PI * k) / PULSE_RATE;
    if (t >= CUES.release - 0.1) return beats;
    if (t >= CUES.heartbeat) beats.push(t);
  }
})();

/** The score runs on past the picture so the last tail can ring out; it is silent by here. */
export const SCORE_END = 30;

/** Context-time headroom so the first events of a live start are never in the past. */
const LEAD = 0.03;
/** Joining mid-way fades the whole score in over this long, so no sustained layer clicks on. */
const JOIN_FADE = 0.35;
/** A reader's "Sound off" (or Skip) fades out this fast; the natural end lets the tail ring. */
const STOP_FADE = 0.3;
const END_FADE = 1.4;
/** Levels set by measurement (render-origin-score.mjs): about -18 LUFS integrated, peaks < -1 dBTP. */
const MIX_LEVEL = 0.9;
const REVERB_RETURN = 0.85;
const OUTPUT_TRIM = 0.77;

// Envelope shapes, all functions of opening time.
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ramp = (a: number, b: number, x: number) => clamp01((x - a) / (b - a));
const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);
const TAU = 2 * Math.PI;

/** A small, fast, seeded PRNG (mulberry32): the score never calls Math.random. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded white noise in [-1, 1). */
export function noiseSamples(length: number, seed: number) {
  const random = seededRandom(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

/**
 * A stereo hall: a short pre-delay, a few early reflections that differ left and right, then
 * decaying seeded noise whose high frequencies die first (RT60 ≈ 3.3 s, 4 s long, faded at the end).
 */
export function impulseResponse(sampleRate: number, seconds = 4, seed = 7) {
  const length = Math.round(seconds * sampleRate);
  const preDelay = Math.round(0.024 * sampleRate);
  const decay = Math.exp(-6.91 / (3.3 * sampleRate));
  const reflections = [
    [[0.011, 0.5], [0.019, -0.32], [0.031, 0.22], [0.047, -0.16]],
    [[0.013, 0.45], [0.023, -0.3], [0.037, 0.2], [0.053, -0.14]],
  ] as const;
  const channels = [0, 1].map(channel => {
    const random = seededRandom(seed * 31 + channel * 977);
    const data = new Float32Array(length);
    let low = 0;
    let env = 1;
    for (let i = preDelay; i < length; i++) {
      const age = (i - preDelay) / sampleRate;
      const cutoff = 11000 * Math.exp(-age * 0.9) + 900;
      const k = Math.exp((-TAU * cutoff) / sampleRate);
      low = (1 - k) * (random() * 2 - 1) + k * low;
      // Keep the broadband level on the decay curve while the colour darkens.
      data[i] = (low / Math.sqrt((1 - k) / (1 + k))) * env * Math.min(1, age / 0.012) * 0.6;
      env *= decay;
    }
    for (const [time, gain] of reflections[channel]!) {
      const i = preDelay + Math.round(time * sampleRate);
      if (i < length) data[i] = (data[i] ?? 0) + gain;
    }
    const fade = Math.min(length, Math.round(0.06 * sampleRate));
    for (let i = 0; i < fade; i++) data[length - 1 - i] = (data[length - 1 - i] ?? 0) * (i / fade);
    return data;
  });
  return [channels[0]!, channels[1]!] as const;
}

/** A soft-clip curve for the saturation bus (odd harmonics, so a 36 Hz sub is heard at 108 Hz). */
function saturationCurve(drive = 2.6, size = 1025) {
  const curve = new Float32Array(size);
  const norm = Math.tanh(drive);
  for (let i = 0; i < size; i++) curve[i] = Math.tanh(drive * ((i / (size - 1)) * 2 - 1)) / norm;
  return curve;
}

/** Fragments glinting in the young disk: deterministic times, notes (F major pentatonic, high) and pans. */
const SPARKLES = (() => {
  const random = seededRandom(2203);
  const notes = [96, 98, 101, 103, 105];
  return Array.from({ length: 12 }, () => ({
    t: CUES.sparkle[0] + random() * (CUES.sparkle[1] - CUES.sparkle[0]),
    note: notes[Math.floor(random() * notes.length)] ?? 96,
    pan: random() * 1.6 - 0.8,
    level: 0.016 + random() * 0.018,
  })).sort((a, b) => a.t - b.t);
})();

type Envelope = (t: number) => number;
interface Send {
  /** A fixed position or a path across the field over the layer's life. */
  pan?: number | Envelope;
  /** Send level into the reverb. */
  wet?: number;
  /** Send level into the saturation bus. */
  sat?: number;
}

export interface ScoreStats {
  oscillators: number;
  noiseSources: number;
  /** Every node the score created, sources included. */
  nodes: number;
  /** The most sources (oscillators and noise) running at once. */
  peakSources: number;
  /** Hits actually scheduled, in opening time. */
  cues: { name: string; t: number }[];
  /** Sustained layers actually scheduled, from the opening time they join (or start) to their end. */
  layers: { name: string; from: number; to: number }[];
}

export interface Score {
  /** The master fade: the only gain a live stop needs to touch. */
  master: GainNode;
  stats: ScoreStats;
}

export interface ScoreOptions {
  /** The opening time the score starts from. */
  from: number;
  /** The context time that `from` maps to (default: the context's current time). */
  when?: number;
  /** Fade-in of the whole score, in seconds. */
  fadeIn?: number;
}

/** Builds the whole score on `ctx`, starting at opening time `from`, into `destination`. */
export function scheduleScore(ctx: BaseAudioContext, destination: AudioNode, options: ScoreOptions): Score {
  const builder = new ScoreBuilder(ctx, destination, options.from, options.when ?? ctx.currentTime, options.fadeIn ?? JOIN_FADE);
  builder.compose();
  return { master: builder.master, stats: builder.finish() };
}

/** Dev-only: renders opening time `from`..SCORE_END offline (for measurement; nothing ships it). */
export async function renderOriginScore(sampleRate = 48000, from = 0): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil((SCORE_END - from) * sampleRate), sampleRate);
  scheduleScore(ctx, ctx.destination, { from, when: 0, fadeIn: from > 0 ? JOIN_FADE : 0.01 });
  return ctx.startRendering();
}

class ScoreBuilder {
  readonly master: GainNode;
  private readonly stats: ScoreStats = { oscillators: 0, noiseSources: 0, nodes: 0, peakSources: 0, cues: [], layers: [] };
  private readonly windows: [number, number][] = [];
  private readonly mix: GainNode;
  private readonly reverb: GainNode;
  private readonly sat: GainNode;
  private readonly pads: GainNode;
  private readonly noise: AudioBuffer;
  private noiseOffset = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    private readonly from: number,
    private readonly when: number,
    fadeIn: number,
  ) {
    // Master: sum → fade → glue compression → limiter → trim → out.
    this.mix = this.gain(MIX_LEVEL);
    this.master = this.gain();
    this.master.gain.setValueAtTime(0, when);
    this.master.gain.linearRampToValueAtTime(1, when + Math.max(0.005, fadeIn));
    const glue = this.track(ctx.createDynamicsCompressor());
    glue.threshold.value = -12;
    glue.knee.value = 8;
    glue.ratio.value = 2;
    glue.attack.value = 0.03;
    glue.release.value = 0.4;
    const limiter = this.track(ctx.createDynamicsCompressor());
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    this.mix.connect(this.master).connect(glue).connect(limiter).connect(this.gain(OUTPUT_TRIM)).connect(destination);

    // Reverb: sends → low cut (the sub stays dry) → convolver → return.
    this.reverb = this.gain(1);
    const convolver = this.track(ctx.createConvolver());
    const [left, right] = impulseResponse(ctx.sampleRate);
    const ir = ctx.createBuffer(2, left.length, ctx.sampleRate);
    ir.getChannelData(0).set(left);
    ir.getChannelData(1).set(right);
    convolver.buffer = ir;
    this.reverb.connect(this.filter('highpass', 0.5, 170)).connect(convolver).connect(this.gain(REVERB_RETURN)).connect(this.mix);

    // Saturation: harmonics of the sub hits, kept low.
    this.sat = this.gain(1);
    const shaper = this.track(ctx.createWaveShaper());
    shaper.curve = saturationCurve();
    shaper.oversample = '2x';
    this.sat.connect(shaper).connect(this.filter('lowpass', 0.7, 420)).connect(this.gain(0.5)).connect(this.mix);

    // Pads: a stereo chorus (two slowly modulated delays, one each side) and a generous reverb send.
    this.pads = this.gain(1);
    this.pads.connect(this.gain(0.75)).connect(this.mix);
    const span = this.span(0, SCORE_END - 1);
    if (span) {
      for (const [delay, rate, pan] of [[0.017, 0.23, -0.85], [0.023, 0.31, 0.85]] as const) {
        const line = this.track(ctx.createDelay(0.05));
        line.delayTime.value = delay;
        const depth = this.gain(0.0028);
        this.osc('sine', rate, span[0], span[1]).connect(depth).connect(line.delayTime);
        this.pads.connect(line).connect(this.gain(0.55)).connect(this.panner(pan)).connect(this.mix);
      }
    }
    this.pads.connect(this.gain(0.42)).connect(this.reverb);

    this.noise = ctx.createBuffer(1, Math.round(4 * ctx.sampleRate), ctx.sampleRate);
    this.noise.getChannelData(0).set(noiseSamples(this.noise.length, 12345));
  }

  compose(): void {
    this.beforeForm();
    this.expansion();
    this.firstStars();
    this.transformation();
    this.release();
    this.newWorlds();
  }

  finish(): ScoreStats {
    const edges = this.windows.flatMap(([a, b]) => [[a, 1], [b, -1]] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let live = 0;
    for (const [, step] of edges) {
      live += step;
      this.stats.peakSources = Math.max(this.stats.peakSources, live);
    }
    return this.stats;
  }

  // ── Before form (0–3.6): near silence, a sub breathing with the presence, a riser into the bang.
  private beforeForm(): void {
    const drone = this.layer('sub-drone', 1.0, 9.2);
    if (drone) {
      const [a, b] = drone;
      // The presence's own breath (timeline: 0.85 + 0.2·sin 1.7t, brightening into the bang).
      const breath: Envelope = t => smooth(1.0, 3.4, t) ** 2 * (0.85 + 0.2 * Math.sin(1.7 * t)) * (1 + 0.7 * smooth(2.6, 3.55, t)) * (1 - 0.5 * smooth(3.6, 4.6, t)) * (1 - smooth(6.8, 9.2, t));
      const level = this.gain();
      this.curve(level.gain, t => 0.12 * breath(t), a, b);
      level.connect(this.out({ wet: 0.1, sat: 0.35 }, a, b));
      this.osc('sine', midi(26), a, b).connect(level);
      this.osc('triangle', midi(38), a, b).connect(this.gain(0.35)).connect(level);
    }

    const riser = this.layer('riser', CUES.riser, CUES.expansion);
    if (riser) {
      const [a, b] = riser;
      const p: Envelope = t => ramp(CUES.riser, CUES.expansion, t);
      // Everything stops dead on the frame of the bang.
      const cut: Envelope = t => 1 - ramp(CUES.expansion - 0.018, CUES.expansion, t);
      const pitch: Envelope = t => midi(38 + 26 * p(t) ** 1.7);
      const tone = this.gain();
      this.curve(tone.gain, t => 0.035 * p(t) ** 2.8 * cut(t), a, b);
      const lowpass = this.filter('lowpass', 1.2);
      this.curve(lowpass.frequency, t => pitch(t) * 2.5 + 150, a, b);
      lowpass.connect(tone).connect(this.out({ wet: 0.45 }, a, b));
      for (const detune of [-10, 10]) this.osc('sawtooth', pitch, a, b, detune).connect(lowpass);
      // A reverse swell of filtered noise, wide.
      for (const pan of [-0.55, 0.55]) {
        const band = this.filter('bandpass', 1.4);
        this.curve(band.frequency, t => 280 * 18 ** (p(t) ** 1.2), a, b);
        const level = this.gain();
        this.curve(level.gain, t => 0.1 * p(t) ** 4 * cut(t), a, b);
        this.noiseSource(a, b).connect(band).connect(level).connect(this.out({ pan, wet: 0.5 }, a, b));
      }
    }
  }

  // ── The expansion (3.6–8.6): the boom, a whoosh falling in brightness, D minor add9 opening out, air.
  private expansion(): void {
    const T = CUES.expansion;
    if (this.cue('expansion', T)) {
      const t = this.at(T);
      const boom = this.osc('sine', 75, T, T + 6);
      boom.frequency.setValueAtTime(75, t);
      boom.frequency.exponentialRampToValueAtTime(28, t + 1.6);
      const level = this.gain();
      this.hit(level.gain, t, 0.8, 0.008, [[0.22, 0.6], [0.0001, 5]]);
      boom.connect(level).connect(this.out({ wet: 0.12, sat: 0.9 }, T, T + 6));
      // The impact itself: a short, dark burst.
      const impact = this.gain();
      this.hit(impact.gain, t, 0.5, 0.002, [[0.0001, 0.35]]);
      this.noiseSource(T, T + 0.4).connect(this.filter('lowpass', 0.7, 2200)).connect(impact).connect(this.out({ wet: 0.35 }, T, T + 0.4));
      for (const pan of [-0.7, 0.7]) {
        const lowpass = this.filter('lowpass', 0.5, 9500);
        lowpass.frequency.setValueAtTime(9500, t);
        lowpass.frequency.exponentialRampToValueAtTime(280, t + 2.6);
        const whoosh = this.gain();
        this.hit(whoosh.gain, t, 0.26, 0.04, [[0.1, 1.0], [0.0001, 3.3]]);
        this.noiseSource(T, T + 3.4).connect(lowpass).connect(whoosh).connect(this.out({ pan, wet: 0.55 }, T, T + 3.4));
      }
    }

    // D minor add9, its filter opening all the way through the expansion.
    this.pad('pad-dm-add9', [50, 57, 65, 76], 3.6, 9.8, t => 0.032 * smooth(3.6, 6.4, t) * (1 - smooth(8.5, 9.8, t)), t => 220 * 11 ** smooth(3.6, 8.6, t));

    // Shimmer and air drifting across the field as matter streams past.
    const air = this.layer('shimmer-expansion', 3.8, 9.6);
    if (air) {
      const [a, b] = air;
      const env: Envelope = t => smooth(3.8, 5.6, t) * (1 - smooth(7.8, 9.6, t));
      this.shimmer([86, 88, 93], env, 0.012, a, b, 0);
      const band = this.filter('bandpass', 0.8, 6800);
      const level = this.gain();
      this.curve(level.gain, t => 0.05 * env(t), a, b);
      this.noiseSource(a, b).connect(band).connect(level).connect(this.out({ pan: t => -0.85 + 1.7 * smooth(3.8, 9.2, t), wet: 0.5 }, a, b));
    }
  }

  // ── The first stars (8.6–13.6): B♭maj7, and a glass bell as each star ignites.
  private firstStars(): void {
    this.pad('pad-bb-maj7', [46, 53, 62, 69], 8.3, 14.6, t => 0.042 * smooth(8.3, 9.6, t) * (1 - smooth(13.4, 14.6, t)), t => 800 + 900 * smooth(8.6, 10.8, t) - 1000 * smooth(11.2, 14.0, t), 0.5);
    const notes = [77, 81, 84, 86, 89];
    const pans = [-0.1, -0.6, 0.6, -0.3, 0.4];
    CUES.ignitions.forEach((T, i) => {
      if (!this.cue(`bell-${i}`, T)) return;
      this.bell(T, midi(notes[i] ?? 77), pans[i] ?? 0);
      this.thump(T, 88, 44, 0.2, (pans[i] ?? 0) * 0.5, 0.45, 0.5);
    });
  }

  // ── Transformation (13.6–17.2): a C pedal, a heartbeat locked to the star's pulse, a rising cluster.
  private transformation(): void {
    const heart: Envelope = t => smooth(CUES.heartbeat, CUES.release, t) * Math.max(0, Math.sin(PULSE_RATE * t)) ** 4;
    const drone = this.layer('tension-drone', 13.2, 17.6);
    if (drone) {
      const [a, b] = drone;
      const lowpass = this.filter('lowpass', 1.2);
      this.curve(lowpass.frequency, t => 130 + 380 * smooth(13.6, 17.15, t), a, b);
      const level = this.gain();
      this.curve(level.gain, t => 0.07 * smooth(13.2, 14.6, t) * (0.7 + 0.3 * smooth(15.2, 17.1, t)) * (1 + 0.8 * heart(t)) * (1 - ramp(17.2, 17.6, t)), a, b);
      lowpass.connect(level).connect(this.out({ wet: 0.15, sat: 0.4 }, a, b));
      this.osc('sawtooth', midi(36), a, b).connect(lowpass);
      this.osc('sine', midi(24), a, b).connect(this.gain(0.6)).connect(lowpass);
    }
    this.pad('pad-c7sus4', [48, 53, 55, 58], 13.2, 17.35, t => 0.034 * smooth(13.2, 14.8, t) * (1 - ramp(17.18, 17.32, t)), t => 400 + 900 * smooth(14, 17.1, t));

    HEARTBEATS.forEach((T, k) => {
      const grow = 0.55 + 0.45 * smooth(CUES.heartbeat, CUES.release, T);
      if (this.cue(`heartbeat-${k}`, T)) this.thump(T, 70, 42, 0.6 * grow, 0, 0.9, 0.35);
      if (this.cue(`heartbeat-${k}-dub`, T + 0.2)) this.thump(T + 0.2, 64, 40, 0.36 * grow, 0, 0.9, 0.3);
    });

    const cluster = this.layer('cluster', 14.0, CUES.release);
    if (cluster) {
      const [a, b] = cluster;
      const pans = [-0.5, 0.25, -0.2, 0.5];
      [67, 68, 70, 71].forEach((note, i) => {
        const level = this.gain();
        this.curve(level.gain, t => 0.018 * smooth(14.0, CUES.release, t) ** 2 * (1 + 0.35 * heart(t)) * (1 - ramp(CUES.release - 0.03, CUES.release, t)), a, b);
        this.osc('triangle', t => midi(note + 5 * ramp(14.0, CUES.release, t) ** 1.4), a, b).connect(level).connect(this.out({ pan: pans[i] ?? 0, wet: 0.5 }, a, b));
      });
    }

    const swell = this.layer('tension-riser', 15.6, CUES.release);
    if (swell) {
      const [a, b] = swell;
      for (const pan of [-0.6, 0.6]) {
        const band = this.filter('bandpass', 0.9);
        this.curve(band.frequency, t => 400 * 15 ** (ramp(15.6, CUES.release, t) ** 1.3), a, b);
        const level = this.gain();
        this.curve(level.gain, t => 0.11 * ramp(15.6, CUES.release, t) ** 3.5 * (1 - ramp(CUES.release - 0.015, CUES.release, t)), a, b);
        this.noiseSource(a, b).connect(band).connect(level).connect(this.out({ pan, wet: 0.55 }, a, b));
      }
    }
  }

  // ── The release (17.2): a great airy whoosh, a soft deep hit, and a choir opening on F add9.
  private release(): void {
    const T = CUES.release;
    if (this.cue('release', T)) {
      const t = this.at(T);
      for (const pan of [-0.8, 0.8]) {
        const band = this.filter('bandpass', 0.55, 600);
        band.frequency.setValueAtTime(600, t);
        band.frequency.exponentialRampToValueAtTime(5200, t + 0.8);
        band.frequency.exponentialRampToValueAtTime(1500, t + 4.2);
        const level = this.gain();
        this.hit(level.gain, t, 0.34, 0.22, [[0.12, 1.4], [0.0001, 4.5]]);
        this.noiseSource(T, T + 4.6).connect(band).connect(level).connect(this.out({ pan, wet: 0.8 }, T, T + 4.6));
      }
      const hit = this.osc('sine', 60, T, T + 3.9);
      hit.frequency.setValueAtTime(60, t);
      hit.frequency.exponentialRampToValueAtTime(midi(29), t + 0.9);
      const level = this.gain();
      this.hit(level.gain, t, 0.45, 0.01, [[0.2, 0.8], [0.0001, 3.8]]);
      hit.connect(level).connect(this.out({ wet: 0.2, sat: 0.7 }, T, T + 3.9));
    }

    this.choir();
    this.pad('pad-f-add9', [41, 48, 57, 67], 17.2, 21.4, t => 0.03 * smooth(17.2, 18.6, t) * (1 - smooth(20.5, 21.4, t)), t => 500 + 2600 * smooth(17.2, 18.6, t) - 800 * smooth(19.6, 21, t), 0.5);

    // High shimmer: a bloom at the release, low through the new worlds, back for the last chord, gone with the overlay.
    const shimmer = this.layer('shimmer-high', 17.3, CUES.end);
    if (shimmer) {
      const env: Envelope = t => (smooth(17.3, 18.6, t) * (1 - 0.55 * smooth(19.2, 21.0, t)) + 0.5 * smooth(24.6, 26.0, t)) * (1 - smooth(CUES.handoff, CUES.end, t));
      this.shimmer([84, 91, 93], env, 0.014, shimmer[0], shimmer[1], 1.7);
    }
  }

  /** Formant-filtered saws ("oo" opening to "ah"), F add9, with a vibrato that arrives late. */
  private choir(): void {
    const span = this.layer('choir', CUES.release, 21.8);
    if (!span) return;
    const [a, b] = span;
    const env: Envelope = t => smooth(CUES.release, 18.3, t) * (1 - smooth(19.6, 21.8, t));
    const open: Envelope = t => smooth(CUES.release, 18.6, t);
    const vibrato = [5.1, 5.7].map(rate => {
      const depth = this.gain();
      this.curve(depth.gain, t => 14 * smooth(17.5, 18.6, t), a, b);
      this.osc('sine', rate, a, b).connect(depth);
      return depth;
    });
    const formants: [number, number, number, number][] = [
      [350, 800, 4, 1.0],
      [700, 1150, 6, 0.7],
      [2600, 2900, 10, 0.35],
    ];
    [-0.4, 0.4].forEach((pan, half) => {
      const input = this.gain(1);
      const output = this.gain();
      this.curve(output.gain, t => 0.16 * env(t), a, b);
      for (const [oo, ah, q, weight] of formants) {
        const band = this.filter('bandpass', q);
        this.curve(band.frequency, t => oo + (ah - oo) * open(t), a, b, 30);
        input.connect(band).connect(this.gain(weight)).connect(output);
      }
      input.connect(this.filter('lowpass', 0.7, 1000)).connect(this.gain(0.35)).connect(output);
      output.connect(this.out({ pan, wet: 0.65 }, a, b));
      [53, 60, 67, 69, 72].forEach((note, i) => {
        if (i % 2 !== half) return;
        for (const detune of [-9, 9]) {
          const voice = this.osc('sawtooth', midi(note), a, b, detune);
          vibrato[(i + (detune > 0 ? 1 : 0)) % 2]!.connect(voice.detune);
          voice.connect(input);
        }
      });
    });
  }

  // ── New worlds (19.6–25.2) and your universe (25.2–28.4): F → C/E → Dm → B♭ → F add9, plucks, glints.
  private newWorlds(): void {
    this.pad('pad-c-over-e', [40, 55, 60, 64], 20.4, 22.5, t => 0.042 * smooth(20.4, 21.2, t) * (1 - smooth(21.8, 22.5, t)), () => 1300);
    this.pad('pad-dm', [38, 57, 62, 65], 21.8, 23.9, t => 0.042 * smooth(21.8, 22.4, t) * (1 - smooth(23.2, 23.9, t)), () => 1200, 0.4);
    this.pad('pad-bb', [34, 53, 62, 65], 23.2, 25.9, t => 0.042 * smooth(23.2, 23.8, t) * (1 - smooth(25.0, 25.9, t)), () => 1200, 0.4);
    this.pad('pad-final-f-add9', [41, 60, 67, 69], 25.0, 28.7, t => 0.046 * smooth(25.0, 25.9, t) * (1 - smooth(CUES.handoff + 0.1, 28.6, t)), t => 1500 - 700 * smooth(CUES.handoff, 28.6, t), 0.4);

    const notes = [69, 72, 74, 77];
    const pans = [-0.35, 0.3, -0.15, 0.45];
    CUES.worlds.forEach((T, i) => {
      if (this.cue(`world-${i}`, T)) this.pluck(T, midi(notes[i] ?? 69), pans[i] ?? 0);
    });
    SPARKLES.forEach((spark, i) => {
      if (!this.cue(`sparkle-${i}`, spark.t)) return;
      const t = this.at(spark.t);
      const level = this.gain();
      this.hit(level.gain, t, spark.level, 0.002, [[0.0001, 0.22]]);
      this.osc('sine', midi(spark.note), spark.t, spark.t + 0.25).connect(level).connect(this.out({ pan: spark.pan, wet: 0.7 }, spark.t, spark.t + 0.25));
    });
  }

  // ── Instruments ──

  /** Four saws (and an optional sub-octave triangle) through one lowpass into the chorus bus. */
  private pad(name: string, notes: number[], start: number, end: number, level: Envelope, cutoff: Envelope, bass = 0): void {
    const span = this.layer(name, start, end);
    if (!span) return;
    const [a, b] = span;
    const lowpass = this.filter('lowpass', 0.7);
    this.curve(lowpass.frequency, cutoff, a, b, 30);
    const gain = this.gain();
    this.curve(gain.gain, level, a, b);
    lowpass.connect(gain).connect(this.pads);
    notes.forEach((note, i) => this.osc('sawtooth', midi(note), a, b, (i % 2 ? 1 : -1) * (3 + i)).connect(lowpass));
    if (bass > 0 && notes[0] !== undefined) this.osc('triangle', midi(notes[0] - 12), a, b).connect(this.gain(bass)).connect(lowpass);
  }

  /** High sines with a slow tremolo, each drifting across the stereo field. */
  private shimmer(notes: number[], env: Envelope, level: number, a: number, b: number, phase: number): void {
    notes.forEach((note, i) => {
      const rate = [0.9, 1.3, 0.7][i] ?? 1;
      const drift = [5.1, 3.7, 6.3][i] ?? 5;
      const offset = phase + i * 2.1;
      const gain = this.gain();
      this.curve(gain.gain, t => level * env(t) * (0.3 + 0.7 * (0.5 + 0.5 * Math.sin(TAU * rate * t + offset)) ** 2), a, b);
      this.osc('sine', midi(note), a, b).connect(gain).connect(this.out({ pan: t => 0.75 * Math.sin((TAU * t) / drift + offset), wet: 0.75 }, a, b));
    });
  }

  /** A glass bell: FM (ratio 3.5, index decaying) plus a quickly fading inharmonic partial. */
  private bell(T: number, frequency: number, pan: number): void {
    const t = this.at(T);
    const out = this.out({ pan, wet: 0.6 }, T, T + 4.2);
    const level = this.gain();
    this.hit(level.gain, t, 0.16, 0.004, [[0.05, 0.3], [0.0001, 4.2]]);
    level.connect(out);
    const carrier = this.osc('sine', frequency, T, T + 4.2);
    carrier.connect(level);
    const index = this.gain();
    index.gain.setValueAtTime(frequency * 2.2, t);
    index.gain.exponentialRampToValueAtTime(frequency * 0.1, t + 1.8);
    this.osc('sine', frequency * 3.5, T, T + 4.2).connect(index).connect(carrier.frequency);
    const partial = this.gain();
    this.hit(partial.gain, t, 0.05, 0.003, [[0.0001, 0.45]]);
    this.osc('sine', frequency * 2.76, T, T + 1).connect(partial).connect(out);
  }

  /** A soft low thump: a sine falling in pitch, partly saturated so it is heard on small speakers. */
  private thump(T: number, high: number, low: number, peak: number, pan: number, sat: number, decay: number): void {
    const t = this.at(T);
    const body = this.osc('sine', high, T, T + decay + 0.1);
    body.frequency.setValueAtTime(high, t);
    body.frequency.exponentialRampToValueAtTime(low, t + 0.16);
    const level = this.gain();
    this.hit(level.gain, t, peak, 0.006, [[0.0001, decay]]);
    body.connect(level).connect(this.out({ pan, wet: 0.15, sat }, T, T + decay + 0.1));
  }

  /** A gentle pluck: triangle and octave sine through a closing lowpass. */
  private pluck(T: number, frequency: number, pan: number): void {
    const t = this.at(T);
    const lowpass = this.filter('lowpass', 0.9, 5500);
    lowpass.frequency.setValueAtTime(5500, t);
    lowpass.frequency.exponentialRampToValueAtTime(650, t + 0.4);
    const level = this.gain();
    this.hit(level.gain, t, 0.17, 0.003, [[0.045, 0.35], [0.0001, 2]]);
    lowpass.connect(level).connect(this.out({ pan, wet: 0.45 }, T, T + 2.05));
    this.osc('triangle', frequency, T, T + 2.05).connect(lowpass);
    this.osc('sine', frequency * 2, T, T + 2.05).connect(this.gain(0.3)).connect(lowpass);
  }

  // ── Plumbing ──

  /** Context time of opening time `t`. */
  private at(t: number): number {
    return this.when + (t - this.from);
  }

  /** A hit at opening time `t` is scheduled only if it has not already passed. */
  private cue(name: string, t: number): boolean {
    if (t < this.from) return false;
    this.stats.cues.push({ name, t });
    return true;
  }

  /** A sustained layer over [start, end], joined at `from` if it is already under way. */
  private layer(name: string, start: number, end: number): [number, number] | null {
    const span = this.span(start, end);
    if (span) this.stats.layers.push({ name, from: span[0], to: span[1] });
    return span;
  }

  private span(start: number, end: number): [number, number] | null {
    const a = Math.max(start, this.from);
    return end - a > 0.02 ? [a, end] : null;
  }

  /** Samples `fn` (a function of opening time) into one value curve over [a, b]. */
  private curve(param: AudioParam, fn: Envelope, a: number, b: number, rate = 60): void {
    const start = Math.max(a, this.from);
    if (b - start <= 0.001) return;
    const n = Math.max(2, Math.ceil((b - start) * rate) + 1);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = fn(start + ((b - start) * i) / (n - 1));
    param.setValueCurveAtTime(values, this.at(start), b - start);
  }

  /** A click-free hit envelope: 0 → peak (linear attack), then exponential steps [value, seconds after t]. */
  private hit(param: AudioParam, t: number, peak: number, attack: number, steps: [number, number][]): void {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
    for (const [value, after] of steps) param.exponentialRampToValueAtTime(value, t + after);
  }

  /** A voice's way out: optional pan (fixed or moving), dry to the mix, sends to reverb and saturation. */
  private out(send: Send, a: number, b: number): GainNode {
    const input = this.gain(1);
    let node: AudioNode = input;
    if (send.pan !== undefined) {
      const panner = typeof send.pan === 'number' ? this.panner(send.pan) : this.panner();
      if (typeof send.pan === 'function') this.curve(panner.pan, send.pan, a, b, 30);
      node = input.connect(panner);
    }
    node.connect(this.mix);
    if (send.wet) node.connect(this.gain(send.wet)).connect(this.reverb);
    if (send.sat) input.connect(this.gain(send.sat)).connect(this.sat);
    return input;
  }

  private osc(type: OscillatorType, frequency: number | Envelope, a: number, b: number, detune = 0): OscillatorNode {
    const osc = this.track(this.ctx.createOscillator());
    osc.type = type;
    if (typeof frequency === 'number') osc.frequency.value = frequency;
    else this.curve(osc.frequency, frequency, a, b, 60);
    if (detune) osc.detune.value = detune;
    this.source(osc, a, b);
    this.stats.oscillators++;
    return osc;
  }

  private noiseSource(a: number, b: number): AudioBufferSourceNode {
    const src = this.track(this.ctx.createBufferSource());
    src.buffer = this.noise;
    src.loop = true;
    // Each source reads the loop from its own place, so no two are correlated.
    this.noiseOffset = (this.noiseOffset + 1.37) % 4;
    this.source(src, a, b, this.noiseOffset);
    this.stats.noiseSources++;
    return src;
  }

  private source(node: AudioScheduledSourceNode, a: number, b: number, offset?: number): void {
    const start = this.at(a);
    const stop = this.at(b) + 0.05;
    if (offset === undefined) node.start(start);
    else (node as AudioBufferSourceNode).start(start, offset);
    node.stop(stop);
    this.windows.push([start, stop]);
  }

  private gain(value?: number): GainNode {
    const gain = this.track(this.ctx.createGain());
    if (value !== undefined) gain.gain.value = value;
    return gain;
  }

  private filter(type: BiquadFilterType, q: number, frequency?: number): BiquadFilterNode {
    const filter = this.track(this.ctx.createBiquadFilter());
    filter.type = type;
    filter.Q.value = q;
    if (frequency !== undefined) filter.frequency.value = frequency;
    return filter;
  }

  private panner(pan?: number): StereoPannerNode {
    const panner = this.track(this.ctx.createStereoPanner());
    if (pan !== undefined) panner.pan.value = pan;
    return panner;
  }

  private track<T extends AudioNode>(node: T): T {
    this.stats.nodes++;
    return node;
  }
}

function liveContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/** The live score: one AudioContext per play, started from the reader's gesture. */
export class OriginSound {
  private ctx: AudioContext | null = null;
  private score: Score | null = null;
  private clock: { from: number; when: number } | null = null;
  private onVisibility: (() => void) | null = null;

  get running(): boolean {
    return this.ctx !== null;
  }

  /** Starts the score as if the opening were at time `t`. Safe to call only from a user gesture. */
  start(t: number): boolean {
    if (this.ctx) return true;
    const Constructor = liveContextConstructor();
    if (!Constructor) return false;
    let ctx: AudioContext;
    try {
      ctx = new Constructor();
    } catch {
      return false;
    }
    this.ctx = ctx;
    const asked = typeof performance !== 'undefined' ? performance.now() : 0;
    // A context can take a moment to start running; the picture keeps moving meanwhile, so the
    // score joins at the picture's time when the context is actually ready.
    const begin = () => {
      if (this.ctx !== ctx || this.score) return;
      const elapsed = typeof performance !== 'undefined' ? Math.max(0, (performance.now() - asked) / 1000) : 0;
      const when = ctx.currentTime + LEAD;
      const from = t + elapsed + LEAD;
      this.clock = { from, when };
      try {
        this.score = scheduleScore(ctx, ctx.destination, { from, when, fadeIn: JOIN_FADE });
      } catch {
        this.stop();
      }
    };
    if (ctx.state === 'running') begin();
    else {
      Promise.resolve(ctx.resume?.())
        .then(begin)
        .catch(() => undefined);
    }
    // The opening pauses while its tab is hidden; so does the score, and both resume together.
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (this.ctx !== ctx) return;
        const change = document.hidden ? ctx.suspend?.() : ctx.resume?.();
        Promise.resolve(change).catch(() => undefined);
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.onVisibility = onVisibility;
    }
    return true;
  }

  stop(): void {
    const ctx = this.ctx;
    const score = this.score;
    const clock = this.clock;
    this.ctx = null;
    this.score = null;
    this.clock = null;
    if (this.onVisibility && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.onVisibility = null;
    if (!ctx) return;
    let fade = STOP_FADE;
    try {
      const now = ctx.currentTime;
      // At the natural end the last chord's tail is allowed to ring out instead of being cut.
      if (clock && clock.from + (now - clock.when) >= ORIGIN_DURATION - 0.25) fade = END_FADE;
      const gain = score?.master.gain;
      if (gain) {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(0, now + fade);
      }
    } catch {
      // A closed context has nothing left to fade.
    }
    setTimeout(() => {
      Promise.resolve(ctx.close?.()).catch(() => undefined);
    }, (fade + 0.08) * 1000);
  }
}
