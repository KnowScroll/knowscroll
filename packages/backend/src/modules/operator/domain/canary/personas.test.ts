import { describe, expect, it } from 'vitest';
import {
  FASTEST_HONEST_SHARE,
  PERSONA_IDS,
  REEL_WATCH_FLOOR,
  canaryAddressFor,
  canaryAddressShape,
  parsePersonas,
  parseSpeed,
  personaPlan,
  readShareFor,
  watchShareFor,
} from './personas.js';

describe('canary personas', () => {
  it('names every persona once, and a persona plan carries its own summary', () => {
    expect(PERSONA_IDS).toEqual(['cold-start', 'deep-reader', 'topic-switcher', 'reel-watcher', 'many-reads']);
    for (const id of PERSONA_IDS) expect(personaPlan(id).summary.length).toBeGreaterThan(20);
  });

  it('parses a persona list in order without repeats, and refuses an unknown or empty one', () => {
    expect(parsePersonas(undefined)).toEqual(PERSONA_IDS);
    expect(parsePersonas('deep-reader, cold-start,deep-reader')).toEqual(['deep-reader', 'cold-start']);
    expect(parsePersonas('cold-start,nobody')).toBeUndefined();
    expect(parsePersonas('')).toBeUndefined();
  });

  it('lets --many change only the reader of many Scrolls', () => {
    expect(personaPlan('many-reads', { manyReads: 7 }).encounters).toBe(7);
    expect(personaPlan('cold-start', { manyReads: 7 }).encounters).toBe(2);
  });

  it('parses a speed of 1 to 60 or max, and refuses anything else', () => {
    expect(parseSpeed(undefined)).toEqual({ kind: 'persona' });
    expect(parseSpeed('max')).toEqual({ kind: 'max' });
    expect(parseSpeed('1')).toEqual({ kind: 'factor', value: 1 });
    expect(parseSpeed('60')).toEqual({ kind: 'factor', value: 60 });
    for (const bad of ['0', '61', '-3', '2.5', 'fast', '', '007']) expect(parseSpeed(bad)).toBeUndefined();
  });

  it('never reads below what an honest reader needs, however fast the speed', () => {
    for (const speed of [{ kind: 'max' }, { kind: 'factor', value: 60 }] as const) {
      for (const id of PERSONA_IDS) {
        const plan = personaPlan(id);
        expect(readShareFor(plan.readShare, speed)).toBe(FASTEST_HONEST_SHARE);
        expect(watchShareFor(plan.readShare, speed)).toBe(REEL_WATCH_FLOOR);
      }
    }
    // The qualification policy counts a stop as read after 40% of the time its words take.
    expect(FASTEST_HONEST_SHARE).toBeGreaterThan(0.4);
    // A Reel needs 60% of its length.
    expect(REEL_WATCH_FLOOR).toBeGreaterThan(0.6);
  });

  it('reads at the persona pace without a speed, and divides it by a factor', () => {
    expect(readShareFor(1, { kind: 'persona' })).toBe(1);
    expect(readShareFor(0.8, { kind: 'persona' })).toBe(0.8);
    expect(readShareFor(1, { kind: 'factor', value: 1 })).toBe(1);
    expect(readShareFor(1, { kind: 'factor', value: 4 })).toBeCloseTo(0.5);
    expect(readShareFor(1, { kind: 'factor', value: 1.5 })).toBeCloseTo(1 / 1.5);
  });

  it('builds a unique address inside the operator pattern, or none without a single wildcard', () => {
    expect(canaryAddressFor('*@test.knowscroll.space', 'ab12cd34', 'deep-reader')).toBe(
      'canary-ab12cd34-deep-reader@test.knowscroll.space',
    );
    expect(canaryAddressFor('qa+*@Test.Example', 'ab12cd34', 'cold-start')).toBe(
      'qa+canary-ab12cd34-cold-start@test.example',
    );
    expect(canaryAddressFor('fixed@test.example', 'ab12cd34', 'cold-start')).toBeUndefined();
    expect(canaryAddressFor('*a*@test.example', 'ab12cd34', 'cold-start')).toBeUndefined();
    expect(canaryAddressFor('no-at-sign', 'ab12cd34', 'cold-start')).toBeUndefined();
  });

  it('recognises exactly the addresses the canary makes, to find a run again', () => {
    const shape = canaryAddressShape('*@test.knowscroll.space')!;
    expect(shape.localPrefix).toBe('canary-');
    expect(shape.domain).toBe('test.knowscroll.space');
    for (const persona of PERSONA_IDS) {
      const address = canaryAddressFor('*@test.knowscroll.space', 'ab12cd34', persona)!;
      expect(shape.runOf(address)).toBe('ab12cd34');
    }
    // Nothing else is ever taken for the canary's: not a person's, not a look-alike, not another domain.
    for (const other of [
      'alice@test.knowscroll.space',
      'canary-ab12cd34-cold-start@evil.example',
      'canary-ab12cd34-cold-start@test.knowscroll.space.evil.example',
      'canary-AB12CD34-cold-start@test.knowscroll.space',
      'canary-ab12cd3-cold-start@test.knowscroll.space',
      'canary-ab12cd34-somebody@test.knowscroll.space',
      'xcanary-ab12cd34-cold-start@test.knowscroll.space',
      'canary-ab12cd34-cold-start@test.knowscroll.space\n@x',
      'canary-ab12cd34-cold-start+x@test.knowscroll.space',
    ])
      expect(shape.runOf(other), other).toBeUndefined();
  });

  it('keeps a pattern prefix and suffix in the shape, and refuses a pattern that cannot make unique addresses', () => {
    const shape = canaryAddressShape('qa+*.x@Test.Example')!;
    expect(shape.localPrefix).toBe('qa+canary-');
    expect(shape.runOf(canaryAddressFor('qa+*.x@Test.Example', '00ff00ff', 'deep-reader')!)).toBe('00ff00ff');
    expect(shape.runOf('canary-00ff00ff-deep-reader@test.example')).toBeUndefined();
    expect(canaryAddressShape('fixed@test.example')).toBeUndefined();
    expect(canaryAddressShape('*a*@test.example')).toBeUndefined();
  });
});
