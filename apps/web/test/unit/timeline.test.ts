import { describe, expect, it } from 'vitest';
import { ACTS, actAt, CAPTIONS, captionAt, frameAt, HANDOFF_START, ORIGIN_DURATION, STILLS } from '../../src/cosmos/timeline.ts';

/** Every 50 ms of the opening, plus each boundary the timeline names. */
const SAMPLES = [
  ...Array.from({ length: Math.ceil(ORIGIN_DURATION / 0.05) + 1 }, (_, i) => Math.min(ORIGIN_DURATION, i * 0.05)),
  ...ACTS.flatMap(act => [act.start, act.end]),
  ...CAPTIONS.flatMap(caption => [caption.start, caption.end]),
  HANDOFF_START,
];

const inside = (t: number, window: { start: number; end: number }) => t >= window.start && t < window.end;

describe('origin timeline (ADR-0049 §5)', () => {
  it('is a pure function of time: the same t always gives the same frame, and seeking is clamped', () => {
    for (const t of [0, 1.7, 3.6, 11.75, 17.2, 22.6, HANDOFF_START, ORIGIN_DURATION]) {
      expect(frameAt(t)).toEqual(frameAt(t));
    }
    // Seeking backwards and forwards lands on the same picture as playing straight through.
    const forward = SAMPLES.map(t => frameAt(t));
    const backward = [...SAMPLES].reverse().map(t => frameAt(t)).reverse();
    expect(backward).toEqual(forward);
    expect(frameAt(-4)).toEqual(frameAt(0));
    expect(frameAt(ORIGIN_DURATION + 30)).toEqual(frameAt(ORIGIN_DURATION));
  });

  it('acts are contiguous, ordered and cover exactly 0..duration', () => {
    expect(ACTS[0]!.start).toBe(0);
    expect(ACTS[ACTS.length - 1]!.end).toBe(ORIGIN_DURATION);
    ACTS.forEach((act, i) => {
      expect(act.end).toBeGreaterThan(act.start);
      if (i > 0) expect(act.start).toBe(ACTS[i - 1]!.end);
    });
    for (const t of SAMPLES) {
      const expected = ACTS.find(act => inside(t, act))?.id ?? 'enter';
      expect(actAt(t)).toBe(expected);
      expect(frameAt(t).act).toBe(expected);
    }
    expect(new Set(ACTS.map(act => act.id)).size).toBe(ACTS.length);
  });

  it('shows captions only inside their own windows, which fall inside the acts after new worlds form', () => {
    const newWorlds = ACTS.find(act => act.id === 'new-worlds')!;
    CAPTIONS.forEach((caption, i) => {
      expect(caption.start).toBeGreaterThanOrEqual(newWorlds.start);
      expect(caption.end).toBeLessThanOrEqual(ORIGIN_DURATION);
      expect(caption.end).toBeGreaterThan(caption.start);
      if (i > 0) expect(caption.start).toBeGreaterThanOrEqual(CAPTIONS[i - 1]!.end);
    });
    for (const t of SAMPLES) {
      const window = CAPTIONS.find(caption => inside(t, caption));
      const frame = frameAt(t);
      expect(frame.caption).toBe(window?.text ?? null);
      expect(captionAt(t).text).toBe(window?.text ?? null);
      expect(frame.captionOpacity).toBeGreaterThanOrEqual(0);
      expect(frame.captionOpacity).toBeLessThanOrEqual(1);
      if (!window) expect(frame.captionOpacity).toBe(0);
      if (window) expect(['new-worlds', 'enter']).toContain(frame.act);
    }
  });

  it('covers the Universe fully until the handoff, then dissolves to nothing by the end', () => {
    let previous = 1;
    for (const t of [...SAMPLES].sort((a, b) => a - b)) {
      const { overlay } = frameAt(t);
      if (t <= HANDOFF_START) expect(overlay).toBe(1);
      expect(overlay).toBeLessThanOrEqual(previous);
      previous = overlay;
    }
    expect(HANDOFF_START).toBeLessThan(ORIGIN_DURATION);
    expect(frameAt(ORIGIN_DURATION).overlay).toBe(0);
    expect(frameAt((HANDOFF_START + ORIGIN_DURATION) / 2).overlay).toBeGreaterThan(0);
  });

  it('keeps every matter fraction in [0, 1], the scale bounded and the disk spin integrated', () => {
    const fractions = ['heat', 'web', 'gather', 'compress', 'consume', 'eject', 'matFade', 'stream', 'diskForm', 'diskFade', 'fragments'] as const;
    let spin = 0;
    for (const t of [...SAMPLES].sort((a, b) => a - b)) {
      const frame = frameAt(t);
      for (const key of fractions) {
        expect(frame.matter[key], `${key} at ${t}`).toBeGreaterThanOrEqual(0);
        expect(frame.matter[key], `${key} at ${t}`).toBeLessThanOrEqual(1);
      }
      expect(frame.matter.scale).toBeGreaterThan(0);
      expect(frame.matter.scale).toBeLessThanOrEqual(1.05 + 1e-9);
      expect(frame.matter.envR).toBeGreaterThan(0);
      expect(frame.matter.diskSpin).toBeGreaterThanOrEqual(spin);
      spin = frame.matter.diskSpin;
      for (const value of [frame.black, frame.ambient, frame.overlay]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(frame.farStars).toBeGreaterThanOrEqual(0);
      for (const body of frame.billboards) expect(body.radius).toBeGreaterThan(0);
      for (const blob of frame.gas) {
        expect(blob.density).toBeGreaterThanOrEqual(0);
        expect(blob.density).toBeLessThanOrEqual(1);
      }
    }
  });

  it('holds each reduced-motion still inside its own act, before the handoff, with the caption that falls there', () => {
    let previous = -1;
    for (const still of STILLS) {
      const act = ACTS.find(item => item.id === still.act)!;
      expect(still.t).toBeGreaterThanOrEqual(act.start);
      expect(still.t).toBeLessThan(act.end);
      expect(actAt(still.t)).toBe(still.act);
      expect(still.t).toBeLessThan(HANDOFF_START);
      expect(still.t).toBeGreaterThan(previous);
      previous = still.t;
      expect(still.caption).toBe(captionAt(still.t).text);
    }
    // Every caption is read in the still sequence too, and every act before the Universe has a still.
    expect(STILLS.map(still => still.caption).filter(Boolean)).toEqual(CAPTIONS.map(caption => caption.text));
    expect(new Set(STILLS.map(still => still.act))).toEqual(new Set(ACTS.filter(act => act.id !== 'enter').map(act => act.id)));
  });
});
