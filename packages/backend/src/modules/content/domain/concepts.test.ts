import { describe, expect, it } from 'vitest';
import { CONCEPTS, siblingTopicIds, systemOfTopic, topicSystemPairs } from './concepts.js';

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

describe('the strata and siblings of retrieval lanes (D-420)', () => {
  it('pairs every concept with its system, in two parallel arrays', () => {
    const { topicIds, systemIds } = topicSystemPairs();
    expect(topicIds).toHaveLength(CONCEPTS.length);
    expect(systemIds).toHaveLength(CONCEPTS.length);
    topicIds.forEach((id, index) => expect(systemIds[index]).toBe(systemOfTopic(id)));
  });

  it('lists the other topics of the same system and never the topics asked about or a system itself', () => {
    const siblings = siblingTopicIds(['earth.seasons']);
    expect(siblings).toContain('earth.tides');
    expect(siblings).toContain('earth.greenhouse-effect');
    expect(siblings).not.toContain('earth.seasons');
    expect(siblings).not.toContain('earth');
    expect(siblings.every((id) => systemOfTopic(id) === 'earth')).toBe(true);
  });

  it('takes the siblings of every system the topics belong to, and none for an id the catalogue does not hold', () => {
    const siblings = siblingTopicIds(['earth.seasons', 'space.stars']);
    expect(siblings).toContain('earth.tides');
    expect(siblings).toContain('space.exoplanets');
    expect(siblingTopicIds(['ci.newcontent.topic'])).toEqual([]);
    expect(siblingTopicIds([])).toEqual([]);
  });

  it('does not list a topic asked about when a whole system is asked about, and honours the bound', () => {
    expect(siblingTopicIds(['earth.seasons', 'earth.tides', 'earth.greenhouse-effect'])).toEqual([]);
    expect(siblingTopicIds(['space.stars'], 1)).toHaveLength(1);
  });
});
