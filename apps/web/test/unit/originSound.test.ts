import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUES, HEARTBEATS, noiseSamples, OriginSound, scheduleScore, seededRandom } from '../../src/cosmos/originSound.ts';
import { CORES, frameAt, HANDOFF_START, ORIGIN_DURATION } from '../../src/cosmos/timeline.ts';

/**
 * jsdom has no Web Audio, so these tests run the score against a minimal recording stand-in: every
 * source start/stop and every AudioParam automation is kept with its context time, which is all the
 * score's timing contract needs. What the score sounds like is measured separately, by rendering it
 * offline in Chromium (scripts/render-origin-score.mjs).
 */
type Event = { kind: string; time: number; values?: Float32Array; value?: number };

class FakeParam {
  value: number;
  readonly events: Event[] = [];
  constructor(value = 0, readonly name = '') {
    this.value = value;
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'set', time, value });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'linear', time, value });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    if (value <= 0) throw new RangeError('exponential ramp to a non-positive value');
    this.events.push({ kind: 'exponential', time, value });
    return this;
  }
  setTargetAtTime(value: number, time: number) {
    this.events.push({ kind: 'target', time, value });
    return this;
  }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number) {
    if (values.length < 2 || !(duration > 0)) throw new RangeError('bad curve');
    this.events.push({ kind: 'curve', time, values });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.events.push({ kind: 'cancel', time });
    return this;
  }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  constructor(readonly ctx: FakeContext) {}
  connect<T>(target: T): T {
    this.outputs.push(target);
    return target;
  }
  disconnect() {}
}

class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  start(when = 0) {
    this.started = when;
  }
  stop(when = 0) {
    this.stopped = when;
  }
}

class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number) {
    return this.data[channel]!;
  }
}

class FakeContext {
  static instances: FakeContext[] = [];
  static initialState: 'running' | 'suspended' = 'running';
  currentTime = 5;
  readonly sampleRate = 3000;
  state: string = FakeContext.initialState;
  readonly destination = new FakeNode(this);
  readonly params: FakeParam[] = [];
  readonly sources: FakeSource[] = [];
  readonly calls: string[] = [];

  constructor() {
    FakeContext.instances.push(this);
  }
  private param(value: number, name = '') {
    const param = new FakeParam(value, name);
    this.params.push(param);
    return param;
  }
  private node<T extends object>(extra: T): FakeNode & T {
    return Object.assign(new FakeNode(this), extra);
  }
  private source<T extends object>(extra: T): FakeSource & T {
    const source = Object.assign(new FakeSource(this), extra);
    this.sources.push(source);
    return source;
  }
  createGain() {
    return this.node({ gain: this.param(1, 'gain') });
  }
  createOscillator() {
    return this.source({ type: 'sine', frequency: this.param(440), detune: this.param(0) });
  }
  createBufferSource() {
    return this.source({ buffer: null as FakeBuffer | null, loop: false, playbackRate: this.param(1) });
  }
  createBiquadFilter() {
    return this.node({ type: 'lowpass', frequency: this.param(350), Q: this.param(1), gain: this.param(0) });
  }
  createStereoPanner() {
    return this.node({ pan: this.param(0) });
  }
  createDelay() {
    return this.node({ delayTime: this.param(0) });
  }
  createConvolver() {
    return this.node({ buffer: null as FakeBuffer | null, normalize: true });
  }
  createWaveShaper() {
    return this.node({ curve: null as Float32Array | null, oversample: 'none' });
  }
  createDynamicsCompressor() {
    return this.node({ threshold: this.param(-24), knee: this.param(30), ratio: this.param(12), attack: this.param(0.003), release: this.param(0.25) });
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume() {
    this.calls.push('resume');
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.calls.push('suspend');
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.calls.push('close');
    this.state = 'closed';
    return Promise.resolve();
  }
}

const asContext = (ctx: FakeContext) => ctx as unknown as BaseAudioContext;
const scoreOn = (from: number) => {
  const ctx = new FakeContext();
  const score = scheduleScore(asContext(ctx), ctx.destination as unknown as AudioNode, { from, when: ctx.currentTime + 0.03 });
  return { ctx, score, when: ctx.currentTime + 0.03 };
};
const eventTimes = (ctx: FakeContext) => ctx.params.flatMap(param => param.events.map(event => event.time));

describe('origin sound: the live control', () => {
  const scope = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  let saved: unknown;

  beforeEach(() => {
    saved = scope.AudioContext;
    FakeContext.instances = [];
    FakeContext.initialState = 'running';
  });
  afterEach(() => {
    if (saved === undefined) delete scope.AudioContext;
    else scope.AudioContext = saved;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start returns false and stays off without Web Audio', () => {
    delete scope.AudioContext;
    delete scope.webkitAudioContext;
    const sound = new OriginSound();
    expect(sound.start(0)).toBe(false);
    expect(sound.running).toBe(false);
    expect(() => sound.stop()).not.toThrow();
  });

  it('start returns false when the context cannot be created', () => {
    scope.AudioContext = class {
      constructor() {
        throw new Error('no audio device');
      }
    };
    const sound = new OriginSound();
    expect(sound.start(3)).toBe(false);
    expect(sound.running).toBe(false);
  });

  it('a tap creates exactly one context, and the score is scheduled on it at once', () => {
    scope.AudioContext = FakeContext;
    const sound = new OriginSound();
    expect(sound.start(0)).toBe(true);
    expect(sound.start(0)).toBe(true);
    expect(sound.running).toBe(true);
    expect(FakeContext.instances).toHaveLength(1);
    expect(FakeContext.instances[0]!.sources.length).toBeGreaterThan(50);
  });

  it('waits for a suspended context to run before joining, and never schedules in its past', async () => {
    FakeContext.initialState = 'suspended';
    scope.AudioContext = FakeContext;
    const sound = new OriginSound();
    expect(sound.start(12)).toBe(true);
    const ctx = FakeContext.instances[0]!;
    expect(ctx.sources).toHaveLength(0);
    ctx.currentTime = 7;
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.calls).toContain('resume');
    expect(ctx.sources.length).toBeGreaterThan(0);
    for (const source of ctx.sources) expect(source.started!).toBeGreaterThanOrEqual(7);
    for (const time of eventTimes(ctx)) expect(time).toBeGreaterThanOrEqual(7);
    sound.stop();
  });

  it('stop fades out in about 0.3 s, then closes the context', () => {
    vi.useFakeTimers();
    scope.AudioContext = FakeContext;
    const sound = new OriginSound();
    sound.start(6);
    const ctx = FakeContext.instances[0]!;
    ctx.currentTime = 9;
    sound.stop();
    expect(sound.running).toBe(false);
    const fade = ctx.params.find(param => param.events.some(event => event.kind === 'cancel'));
    const last = fade!.events.at(-1)!;
    expect(last).toMatchObject({ kind: 'linear', value: 0 });
    expect(last.time - 9).toBeCloseTo(0.3, 5);
    expect(ctx.state).toBe('running');
    vi.advanceTimersByTime(400);
    expect(ctx.state).toBe('closed');
    // A second stop, or a stop after the end, is harmless.
    expect(() => sound.stop()).not.toThrow();
  });

  it('lets the last tail ring out when the opening ends naturally', () => {
    vi.useFakeTimers();
    scope.AudioContext = FakeContext;
    const sound = new OriginSound();
    sound.start(27);
    const ctx = FakeContext.instances[0]!;
    ctx.currentTime += ORIGIN_DURATION - 27;
    sound.stop();
    const fade = ctx.params.find(param => param.events.some(event => event.kind === 'cancel'))!;
    expect(fade.events.at(-1)!.time - ctx.currentTime).toBeGreaterThan(1);
    vi.advanceTimersByTime(400);
    expect(ctx.state).toBe('running');
    vi.advanceTimersByTime(2000);
    expect(ctx.state).toBe('closed');
  });

  it('pauses with the opening while the tab is hidden and resumes with it', () => {
    scope.AudioContext = FakeContext;
    const sound = new OriginSound();
    sound.start(2);
    const ctx = FakeContext.instances[0]!;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ctx.calls.at(-1)).toBe('suspend');
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ctx.calls.at(-1)).toBe('resume');
    sound.stop();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ctx.calls.at(-1)).toBe('resume');
  });

  it('never calls Math.random', () => {
    scope.AudioContext = FakeContext;
    const random = vi.spyOn(Math, 'random');
    const sound = new OriginSound();
    sound.start(0);
    sound.stop();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('origin sound: the score against the opening clock', () => {
  it('schedules nothing in the past and no cue before the join, from any point of the opening', () => {
    for (const from of [0, 1.9, 3.59, 3.61, 9, 12.1, 14, 16.5, 17.21, 22.2, 26, 28.3]) {
      const { ctx, score, when } = scoreOn(from);
      for (const source of ctx.sources) {
        expect(source.started!).toBeGreaterThanOrEqual(when - 1e-9);
        expect(source.stopped!).toBeGreaterThan(source.started!);
      }
      for (const time of eventTimes(ctx)) expect(time).toBeGreaterThanOrEqual(ctx.currentTime);
      for (const cue of score.stats.cues) expect(cue.t).toBeGreaterThanOrEqual(from);
      for (const layer of score.stats.layers) expect(layer.from).toBeGreaterThanOrEqual(from);
    }
  });

  it('start(14) skips every earlier hit and joins the layers already sounding at their current level', () => {
    const { ctx, score, when } = scoreOn(14);
    const names = score.stats.cues.map(cue => cue.name);
    expect(names).not.toContain('expansion');
    expect(names.some(name => name.startsWith('bell-'))).toBe(false);
    expect(names).toContain('release');
    expect(names[0]).toBe('heartbeat-0');
    const joined = score.stats.layers.filter(layer => layer.from === 14).map(layer => layer.name);
    expect(joined).toEqual(expect.arrayContaining(['tension-drone', 'pad-c7sus4', 'cluster']));
    // Sources for those layers start at the join itself, and their gain curves start above zero.
    expect(ctx.sources.filter(source => source.started === when).length).toBeGreaterThan(5);
    const joinCurves = ctx.params.flatMap(param => param.events).filter(event => event.kind === 'curve' && event.time === when);
    expect(joinCurves.some(event => event.values![0]! > 0.005)).toBe(true);
  });

  it('a full play hits every cue of the sheet, once, at its picture time', () => {
    const { score } = scoreOn(0);
    const at = (name: string) => score.stats.cues.filter(cue => cue.name === name).map(cue => cue.t);
    expect(at('expansion')).toEqual([3.6]);
    expect(at('release')).toEqual([17.2]);
    CUES.ignitions.forEach((t, i) => expect(at(`bell-${i}`)).toEqual([t]));
    CUES.worlds.forEach((t, i) => expect(at(`world-${i}`)).toEqual([t]));
    HEARTBEATS.forEach((t, k) => expect(at(`heartbeat-${k}`)).toEqual([t]));
    const sparkles = score.stats.cues.filter(cue => cue.name.startsWith('sparkle-'));
    expect(sparkles.length).toBeGreaterThan(5);
    for (const spark of sparkles) {
      expect(spark.t).toBeGreaterThanOrEqual(CUES.sparkle[0]);
      expect(spark.t).toBeLessThanOrEqual(CUES.sparkle[1]);
    }
  });

  it('stays inside its node budget', () => {
    const { score } = scoreOn(0);
    expect(score.stats.oscillators).toBeLessThan(150);
    expect(score.stats.peakSources).toBeLessThan(60);
    expect(score.stats.nodes).toBeLessThan(600);
  });

  it('every level curve ends silent before its sources stop (no click at a layer end)', () => {
    const { ctx } = scoreOn(0);
    // Gain curves that carry a signal level (modulation depths, in cents, are larger than 1).
    const levels = ctx.params
      .filter(param => param.name === 'gain')
      .flatMap(param => param.events.filter(event => event.kind === 'curve').map(event => event.values!))
      .filter(values => Math.max(...values) <= 1);
    expect(levels.length).toBeGreaterThan(20);
    for (const values of levels) {
      expect(values[0]!).toBeLessThan(1e-3);
      expect(values.at(-1)!).toBeLessThan(1e-3);
    }
  });

  it('is deterministic: the same opening time always builds the same score', () => {
    const a = scoreOn(0).ctx;
    const b = scoreOn(0).ctx;
    expect(a.params.map(param => param.events)).toEqual(b.params.map(param => param.events));
    expect(a.sources.map(source => [source.started, source.stopped])).toEqual(b.sources.map(source => [source.started, source.stopped]));
  });
});

describe('origin sound: deterministic noise', () => {
  it('the same seed gives the same noise, a different seed different noise, all within [-1, 1)', () => {
    const a = noiseSamples(4096, 12345);
    expect(noiseSamples(4096, 12345)).toEqual(a);
    expect(noiseSamples(4096, 54321)).not.toEqual(a);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThan(1);
    }
    const mean = a.reduce((sum, value) => sum + value, 0) / a.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    const random = seededRandom(7);
    const again = seededRandom(7);
    for (let i = 0; i < 10; i++) expect(random()).toBe(again());
  });
});

describe('origin sound: the cue sheet still matches the picture', () => {
  const scan = (from: number, to: number, step: number, fn: (t: number) => number) => {
    const out: [number, number][] = [];
    for (let t = from; t <= to + 1e-9; t += step) out.push([t, fn(t)]);
    return out;
  };
  const argmax = (samples: [number, number][]) => samples.reduce((best, sample) => (sample[1] > best[1] ? sample : best))[0];

  it('the expansion starts at the boom', () => {
    const first = scan(3.4, 3.8, 0.001, t => frameAt(t).matter.scale).find(([, scale]) => scale > 0.0016)!;
    expect(first[0]).toBeCloseTo(CUES.expansion, 2);
  });

  it('each first star flashes at its bell', () => {
    CUES.ignitions.forEach((bell, i) => {
      const core = CORES[i]!;
      const brightness = (t: number) => {
        const match = frameAt(t).billboards.filter(b => b.mode === 0 && b.pos.every((v, k) => v === core[k]));
        return match.length ? Math.max(...match.map(b => b.intensity)) : 0;
      };
      expect(Math.abs(argmax(scan(bell - 0.3, bell + 0.3, 0.002, brightness)) - bell)).toBeLessThan(0.06);
    });
  });

  it('the heartbeat lands on the peaks of the star pulse', () => {
    // The pulse rides on a steady swell, so it is read as the radius minus its mean half a period
    // either side; that residual peaks with the pulse (a little late, as the pulse is still growing).
    // A change of the picture's rate or phase would move it by up to half a period (0.37 s).
    const half = (HEARTBEATS[1]! - HEARTBEATS[0]!) / 2;
    const radius = (t: number) => frameAt(t).matter.envR;
    for (const beat of HEARTBEATS.filter(t => t > 16.2)) {
      const residual = (t: number) => radius(t) - (radius(t - half) + radius(t + half)) / 2;
      expect(Math.abs(argmax(scan(beat - 0.2, beat + 0.2, 0.002, residual)) - beat)).toBeLessThan(0.1);
    }
    expect(HEARTBEATS.length).toBeGreaterThanOrEqual(2);
  });

  it('the release lands on the star shedding its envelope', () => {
    const first = scan(17.0, 17.4, 0.001, t => frameAt(t).matter.eject).find(([, eject]) => eject > 0)!;
    expect(first[0]).toBeCloseTo(CUES.release, 2);
  });

  it('each pluck lands as a world starts to condense', () => {
    const worlds = (t: number) => frameAt(t).billboards.filter(b => b.mode === 1).length;
    CUES.worlds.forEach((t, i) => {
      expect(worlds(t - 0.01)).toBe(i);
      expect(worlds(t + 0.08)).toBe(i + 1);
    });
  });

  it('the score fades with the overlay and is silent by the end of its render', () => {
    expect(CUES.handoff).toBe(HANDOFF_START);
    expect(CUES.end).toBe(ORIGIN_DURATION);
    const { ctx } = scoreOn(0);
    for (const source of ctx.sources) expect(source.stopped! - ctx.currentTime - 0.03).toBeLessThanOrEqual(30);
  });
});
