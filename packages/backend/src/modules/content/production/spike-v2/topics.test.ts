import { describe, expect, it } from 'vitest';
import { TOPICS, type ScrollTopic } from '../topics.js';
import { parseSpikeTopics, SPIKE_TOPICS_V2, spikeRecipeV2 } from './topics.js';

describe('the twenty topics of the writer spike', () => {
  it('are twenty distinct library recipes, the three Seasons parts first', () => {
    expect(SPIKE_TOPICS_V2).toHaveLength(20);
    expect(new Set(SPIKE_TOPICS_V2).size).toBe(20);
    expect(SPIKE_TOPICS_V2.slice(0, 3)).toEqual(['seasons', 'seasons-hemispheres', 'seasons-limits']);
    for (const topic of SPIKE_TOPICS_V2) expect(Object.hasOwn(TOPICS, topic)).toBe(true);
  });

  it('spread over Earth & sky and Space (stage candidates), the human body, and computing, ML and history', () => {
    const systemOf = (topic: ScrollTopic) => TOPICS[topic].systemId;
    const stage = SPIKE_TOPICS_V2.filter((topic) => spikeRecipeV2(topic).variant === 'stage');
    expect(stage.length).toBeGreaterThanOrEqual(8);
    expect(new Set(stage.map(systemOf))).toEqual(new Set(['earth', 'space']));
    const body = SPIKE_TOPICS_V2.filter((topic) => systemOf(topic) === 'human-body');
    expect(body.length).toBeGreaterThanOrEqual(4);
    const rest = SPIKE_TOPICS_V2.filter((topic) => !['earth', 'space', 'human-body'].includes(systemOf(topic)));
    expect(new Set(rest.map(systemOf))).toEqual(new Set(['computing', 'machine-learning', 'history']));
    for (const topic of [...body, ...rest]) expect(spikeRecipeV2(topic).variant).toBe('plain');
  });

  it('each decide a misconception, and only the Seasons myth has a reviewed source', () => {
    const reviewed: string[] = [];
    for (const topic of SPIKE_TOPICS_V2) {
      const recipe = spikeRecipeV2(topic);
      expect(recipe.defaulted).toBe(false);
      if (recipe.misconception.kind === 'myth' && recipe.misconception.source.reviewed) reviewed.push(topic);
    }
    expect(reviewed).toEqual(['seasons']);
    expect(SPIKE_TOPICS_V2.filter((topic) => spikeRecipeV2(topic).misconception.kind === 'none')).toEqual([
      'industrial-causes',
    ]);
  });

  it('default to a plain Scroll with no misconception for a recipe the table does not list, and say so', () => {
    expect(spikeRecipeV2('tides-coasts')).toEqual({
      variant: 'plain',
      misconception: { kind: 'none' },
      defaulted: true,
    });
  });

  it('parse from a comma list and refuse a name that is not a recipe', () => {
    expect(parseSpikeTopics('seasons, tides ,seasons')).toEqual(['seasons', 'tides']);
    expect(parseSpikeTopics('seasons,nope')).toBeUndefined();
    expect(parseSpikeTopics('')).toBeUndefined();
  });
});
