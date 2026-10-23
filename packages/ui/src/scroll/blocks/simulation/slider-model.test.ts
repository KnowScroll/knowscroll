import type { SimulationParam } from '@knowscroll/scroll-model';
import { parseTyped, ratioOf, stepped, valueAt, valueForKey } from './slider-model';

const length: SimulationParam = {
  key: 'length',
  label: 'String length',
  unit: 'm',
  min: 0.25,
  max: 4,
  step: 0.25,
  default: 1,
  control: 'slider',
  format: { decimals: 2, grouping: false, approximate: false },
};

const words: SimulationParam = { ...length, key: 'words', min: 512, max: 4096, step: 512, default: 2048 };

describe('slider values', () => {
  it('places a value along the range and back, always on the grid', () => {
    expect(ratioOf(length, 0.25)).toBe(0);
    expect(ratioOf(length, 4)).toBe(1);
    expect(valueAt(length, 0)).toBe(0.25);
    expect(valueAt(length, 1)).toBe(4);
    expect(valueAt(length, 0.5)).toBe(2.25);
    // Between grid positions: the nearest.
    expect(valueAt(length, 0.4)).toBe(1.75);
    // A position outside the track is the end, and a non-number is the start (never NaN).
    expect(valueAt(length, -3)).toBe(0.25);
    expect(valueAt(length, 7)).toBe(4);
    expect(valueAt(length, Number.NaN)).toBe(0.25);
  });

  it('steps by the grid and stays inside the range', () => {
    expect(stepped(length, 1, 1)).toBe(1.25);
    expect(stepped(length, 1, -2)).toBe(0.5);
    expect(stepped(length, 4, 1)).toBe(4);
    expect(stepped(length, 0.25, -1)).toBe(0.25);
  });
});

describe('slider keys (the WAI-ARIA slider pattern)', () => {
  it('moves by one step on the arrows, in either direction', () => {
    expect(valueForKey(words, 2048, 'ArrowRight')).toBe(2560);
    expect(valueForKey(words, 2048, 'ArrowUp')).toBe(2560);
    expect(valueForKey(words, 2048, 'ArrowLeft')).toBe(1536);
    expect(valueForKey(words, 2048, 'ArrowDown')).toBe(1536);
  });

  it('jumps to the ends on Home and End', () => {
    expect(valueForKey(words, 2048, 'Home')).toBe(512);
    expect(valueForKey(words, 2048, 'End')).toBe(4096);
  });

  it('moves a tenth of the range on Page Up and Page Down, at least one step', () => {
    // 7 positions: a tenth is under one step, so it is one step.
    expect(valueForKey(words, 2048, 'PageUp')).toBe(2560);
    // 15 positions: a tenth rounds to 2 steps.
    expect(valueForKey(length, 1, 'PageUp')).toBe(1.5);
    expect(valueForKey(length, 1, 'PageDown')).toBe(0.5);
  });

  it('ignores every other key', () => {
    expect(valueForKey(words, 2048, 'a')).toBeNull();
    expect(valueForKey(words, 2048, 'Tab')).toBeNull();
    expect(valueForKey(words, 2048, 'Enter')).toBeNull();
  });
});

describe('typed numbers', () => {
  it('reads a number the way a reader writes it', () => {
    expect(parseTyped('60')).toBe(60);
    expect(parseTyped('60 kg')).toBe(60);
    expect(parseTyped('4,096')).toBe(4096);
    expect(parseTyped('  1.25 m ')).toBe(1.25);
    expect(parseTyped('−3')).toBe(-3);
    expect(parseTyped('.5')).toBe(0.5);
  });

  it('gives null where there is no number', () => {
    expect(parseTyped('')).toBeNull();
    expect(parseTyped('kg')).toBeNull();
    expect(parseTyped('--')).toBeNull();
  });
});
