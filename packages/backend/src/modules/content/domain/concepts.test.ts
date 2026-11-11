import { describe, expect, it } from 'vitest';
import { CONCEPTS, systemOfTopic } from './concepts.js';

describe('the system of a catalogue topic', () => {
  it('is the system the plan puts the topic under, and a system belongs to itself', () => {
    expect(systemOfTopic('earth.seasons')).toBe('earth');
    expect(systemOfTopic('earth.tides')).toBe('earth');
    expect(systemOfTopic('earth')).toBe('earth');
  });

  it('names a different system for a topic of another system', () => {
    expect(systemOfTopic('space.stars')).not.toBe(systemOfTopic('earth.seasons'));
  });

  it('is undefined for an id the catalogue does not hold: no prefix or lookalike admits a relationship', () => {
    expect(systemOfTopic('earth.not-a-topic')).toBeUndefined();
    expect(systemOfTopic('ci.newcontent.topic')).toBeUndefined();
    expect(systemOfTopic('')).toBeUndefined();
  });

  it('holds exactly one answer for every concept of the catalogue', () => {
    for (const concept of CONCEPTS) expect(systemOfTopic(concept.id)).toBe(concept.parent ?? concept.id);
  });
});
