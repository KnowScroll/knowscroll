import { describe, expect, it } from 'vitest';
import { landmarkTopicOf } from './landmark-topic.js';

describe('the topic a landmark belongs to', () => {
  it('is the primary topic, whatever the weights', () => {
    expect(
      landmarkTopicOf([
        { topicId: 'heavy', role: 'supporting', weight: 0.7 },
        { topicId: 'main', role: 'primary', weight: 0.3 },
      ]),
    ).toBe('main');
  });

  it('is the heaviest topic when none is primary, ties broken by name', () => {
    expect(
      landmarkTopicOf([
        { topicId: 'b', role: 'supporting', weight: 0.5 },
        { topicId: 'a', role: 'incidental', weight: 0.5 },
      ]),
    ).toBe('a');
  });

  it('is nothing for a Scroll with no topic', () => {
    expect(landmarkTopicOf([])).toBeUndefined();
  });
});
