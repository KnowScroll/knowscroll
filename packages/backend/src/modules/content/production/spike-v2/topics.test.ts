import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOPICS, type ScrollTopic } from '../topics.js';
import { parseSpikeTopics, SEASONS_SPIKE_TOPICS_V2, SPIKE_TOPICS_V2, spikeRecipeV2 } from './topics.js';

describe('the twenty topics of the writer spike', () => {
  it('are twenty distinct library recipes, the three Seasons parts first', () => {
    expect(SPIKE_TOPICS_V2).toHaveLength(20);
    expect(new Set(SPIKE_TOPICS_V2).size).toBe(20);
    expect(SPIKE_TOPICS_V2.slice(0, 3)).toEqual(['seasons', 'seasons-hemispheres', 'seasons-limits']);
    for (const topic of SPIKE_TOPICS_V2) expect(Object.hasOwn(TOPICS, topic)).toBe(true);
  });

  it('spread over Earth & sky and Space, the human body, and computing, ML and history', () => {
    const systemOf = (topic: ScrollTopic) => TOPICS[topic].systemId;
    const sky = SPIKE_TOPICS_V2.filter((topic) => ['earth', 'space'].includes(systemOf(topic)));
    expect(sky).toHaveLength(9);
    const body = SPIKE_TOPICS_V2.filter((topic) => systemOf(topic) === 'human-body');
    expect(body.length).toBeGreaterThanOrEqual(4);
    const rest = SPIKE_TOPICS_V2.filter((topic) => !['earth', 'space', 'human-body'].includes(systemOf(topic)));
    expect(new Set(rest.map(systemOf))).toEqual(new Set(['computing', 'machine-learning', 'history']));
  });

  it('give a stage only to the recipes a kit draws: the Seasons parts, never tides, stars, exoplanets or the greenhouse', () => {
    const stage = SPIKE_TOPICS_V2.filter((topic) => spikeRecipeV2(topic).variant === 'stage');
    expect(stage).toEqual(['seasons', 'seasons-hemispheres', 'seasons-limits']);
    for (const topic of SPIKE_TOPICS_V2)
      expect(spikeRecipeV2(topic).variant === 'stage', topic).toBe(TOPICS[topic].stageKit !== undefined);
    for (const topic of [
      'tides',
      'tides-spring-neap',
      'stars-fusion',
      'exoplanet-habitable-zone',
      'greenhouse-radiation',
      'greenhouse-balance',
    ] as const)
      expect(spikeRecipeV2(topic).variant, topic).toBe('plain');
  });

  it('measure the three Seasons stages and the plain "Seasons elsewhere" with one command line, the one the runbook prints', () => {
    expect(SEASONS_SPIKE_TOPICS_V2).toEqual(['seasons', 'seasons-hemispheres', 'seasons-limits', 'seasons-elsewhere']);
    expect(parseSpikeTopics(SEASONS_SPIKE_TOPICS_V2.join(','))).toEqual(SEASONS_SPIKE_TOPICS_V2);
    for (const topic of SEASONS_SPIKE_TOPICS_V2) {
      const recipe = spikeRecipeV2(topic);
      // The kit draws only Earth, so the other worlds of "Seasons elsewhere" are told in words and calls.
      expect(recipe.variant, topic).toBe(topic === 'seasons-elsewhere' ? 'plain' : 'stage');
      expect(recipe.defaulted, topic).toBe(false);
    }
    const runbook = readFileSync(
      new URL('../../../../../../../docs/v2/operations/scroll-production.md', import.meta.url),
      'utf8',
    );
    expect(runbook).toContain(`--topics ${SEASONS_SPIKE_TOPICS_V2.join(',')}`);
  });

  it('each decide a misconception, and only the Seasons myth has a reviewed source', () => {
    const reviewed: string[] = [];
    for (const topic of SPIKE_TOPICS_V2) {
      const recipe = spikeRecipeV2(topic);
      expect(recipe.defaulted).toBe(false);
      if (recipe.misconception.kind === 'myth' && recipe.misconception.source.reviewed) reviewed.push(topic);
    }
    expect(reviewed).toEqual(['seasons']);
    // The recipes the plan decides (D-137, D-199) give no myth: the Seasons parts with none, and every
    // recipe of the first waves. Only the recipes the plan has not marked keep the spike’s own table.
    expect(SPIKE_TOPICS_V2.filter((topic) => spikeRecipeV2(topic).misconception.kind === 'none')).toEqual(
      SPIKE_TOPICS_V2.filter((topic) => topic !== 'seasons' && TOPICS[topic].scrollV2 !== undefined),
    );
    expect(SPIKE_TOPICS_V2.filter((topic) => TOPICS[topic].scrollV2 === undefined)).toEqual([
      'tides',
      'tides-spring-neap',
      'greenhouse-radiation',
      'greenhouse-balance',
      'stars-fusion',
      'exoplanet-habitable-zone',
    ]);
  });

  it('spike a recipe the plan marks v2 exactly as the library will produce it', () => {
    for (const topic of SPIKE_TOPICS_V2) {
      const planned = TOPICS[topic].scrollV2;
      if (planned === undefined) continue;
      expect(spikeRecipeV2(topic), topic).toEqual({ ...planned, defaulted: false });
    }
    expect(spikeRecipeV2('seasons-elsewhere')).toEqual({
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sideways-giant', name: 'The Sideways Giant' },
      defaulted: false,
    });
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
