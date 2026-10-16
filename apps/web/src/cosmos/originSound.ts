/**
 * Optional sound for the origin opening, synthesised with Web Audio so there is no media file to
 * fetch or fail. Off by default; it starts only from the reader's own tap on the sound control
 * (browsers require that gesture anyway). Every cue is scheduled against the opening's own clock,
 * so turning sound on mid-way joins the score where the picture is.
 */
import { ORIGIN_DURATION } from './timeline.ts';

type Ctx = AudioContext;

export class OriginSound {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  get running(): boolean {
    return this.ctx !== null;
  }

  /** Starts the score as if the opening were at time `t`. Safe to call only from a user gesture. */
  start(t: number): boolean {
    if (this.ctx) return true;
    const Constructor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!Constructor) return false;
    let ctx: AudioContext;
    try {
      ctx = new Constructor();
    } catch {
      return false;
    }
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 0.6);
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    this.master = master;
    const length = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = (seed / 2147483647) * 2 - 1;
    }
    this.schedule(t);
    return true;
  }

  stop(): void {
    const ctx = this.ctx;
    const master = this.master;
    this.ctx = null;
    this.master = null;
    if (!ctx) return;
    try {
      master?.gain.cancelScheduledValues(ctx.currentTime);
      master?.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
    } catch {
      // A closed context has nothing left to fade.
    }
    setTimeout(() => { void ctx.close().catch(() => undefined); }, 500);
  }

  /** Converts opening time to context time; cues already in the past are skipped or joined. */
  private schedule(t0: number): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const now = ctx.currentTime;
    const at = (t: number) => now + Math.max(0, t - t0);
    const end = at(ORIGIN_DURATION);

    // A low drone that opens up as the universe does.
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.setValueAtTime(t0 < 3.6 ? 140 : 600, now);
    droneFilter.frequency.linearRampToValueAtTime(900, at(8.6));
    droneFilter.frequency.linearRampToValueAtTime(380, at(14));
    droneFilter.frequency.linearRampToValueAtTime(700, at(22));
    droneFilter.frequency.linearRampToValueAtTime(260, end);
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, now);
    droneGain.gain.linearRampToValueAtTime(0.22, at(Math.max(t0, 3.4)) + 0.4);
    droneGain.gain.linearRampToValueAtTime(0.14, at(13));
    droneGain.gain.linearRampToValueAtTime(0.0001, end);
    droneFilter.connect(droneGain).connect(out);
    for (const [freq, type] of [[55, 'sine'], [82.41, 'sine'], [110.3, 'triangle']] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(droneFilter);
      osc.start(now);
      osc.stop(end + 0.2);
    }

    // Expansion: a soft, falling breath of noise rather than a bang.
    if (t0 < 5) this.breath(at(3.55), 3.2, 3800, 180, 0.32, out);
    // Ignition of the first stars: five quiet bells.
    const bells = [440, 554.37, 659.25, 880, 987.77];
    bells.forEach((freq, i) => {
      const time = 11.75 + i * 0.34;
      if (time >= t0) this.bell(at(time), freq, 0.085, out);
    });
    // The star swells and pulses, then sheds its envelope.
    if (t0 < 17.2) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(41.2, at(15.2));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 260;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.setValueAtTime(0.0001, at(15.2));
      g.gain.linearRampToValueAtTime(0.12, at(16.8));
      g.gain.linearRampToValueAtTime(0.0001, at(18.4));
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1.35;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.05;
      lfo.connect(lfoGain).connect(g.gain);
      osc.connect(lp).connect(g).connect(out);
      osc.start(at(15.2));
      osc.stop(at(18.6));
      lfo.start(at(15.2));
      lfo.stop(at(18.6));
    }
    if (t0 < 19) this.breath(at(Math.max(17.2, t0)), 2.8, 300, 2600, 0.16, out);
    // New worlds: a warm chord that settles into one tone as the Universe appears.
    const chord = [146.83, 185.0, 220.0, 329.63];
    chord.forEach((freq, i) => {
      const start = at(Math.max(20.8 + i * 0.5, t0));
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = (i - 1.5) * 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(0.05, start + 2.2);
      g.gain.linearRampToValueAtTime(i === 2 ? 0.05 : 0.0001, at(26.6));
      g.gain.linearRampToValueAtTime(0.0001, end + 1.2);
      osc.connect(g).connect(out);
      osc.start(start);
      osc.stop(end + 1.4);
    });
  }

  private bell(time: number, freq: number, level: number, out: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [mult, amp] of [[1, 1], [2.76, 0.32], [5.4, 0.12]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(level * amp, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 2.6 / mult);
      osc.connect(g).connect(out);
      osc.start(time);
      osc.stop(time + 2.8);
    }
  }

  private breath(time: number, duration: number, from: number, to: number, level: number, out: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(from, time);
    filter.frequency.exponentialRampToValueAtTime(to, time + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(level, time + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    src.connect(filter).connect(g).connect(out);
    src.start(time);
    src.stop(time + duration + 0.1);
  }
}
