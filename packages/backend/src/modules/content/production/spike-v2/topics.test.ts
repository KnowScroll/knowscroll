import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scrollV3PlanOf, TOPICS, type ScrollTopic } from '../topics.js';
import { FORMER_V2_PLANS, formerV2PlanOf } from './former-v2-plans.js';
import {
  parseSpikeBlocks,
  parseSpikeTopics,
  SEASONS_SPIKE_TOPICS_V2,
  BLOCK_SPIKE_BLOCKS_V2,
  BLOCK_SPIKE_TOPICS_V2,
  BODY_SPIKE_TOPICS_V2,
  SKY_SPIKE_TOPICS_V2,
  SPACE_SPIKE_TOPICS_V2,
  SPIKE_TOPICS_V2,
  spikeRecipeV2,
} from './topics.js';

/** The kit a spike draws a recipe with: its own, or the one it had before it became a document v3 recipe (#787). */
const kitOf = (topic: ScrollTopic) => TOPICS[topic].stageKit ?? formerV2PlanOf(topic)?.kit;
/** The v2 plan a spike runs a recipe with: the library's, or the one a document v3 recipe had before (#787). */
const planOf = (topic: ScrollTopic) => TOPICS[topic].scrollV2 ?? formerV2PlanOf(topic)?.plan;

describe('the v2 plans of the recipes that became document v3 recipes (#787, #790)', () => {
  it('hold every recipe but "exoplanet-kinds", each now a v3 recipe with no kit and no v2 plan in the library', () => {
    const held = Object.keys(FORMER_V2_PLANS) as ScrollTopic[];
    expect(held).toHaveLength(54);
    expect(held).not.toContain('exoplanet-kinds');
    expect(Object.keys(TOPICS).filter((topic) => !held.includes(topic as ScrollTopic))).toEqual(['exoplanet-kinds']);
    for (const topic of held) {
      expect(scrollV3PlanOf(topic), topic).toBeDefined();
      expect(TOPICS[topic].stageKit, topic).toBeUndefined();
      expect(TOPICS[topic].scrollV2, topic).toBeUndefined();
    }
  });

  it('keep the drawing kit of the 22 recipes that had one, as a stage plan, and a plain plan with a landmark for the other 32', () => {
    const drawn = Object.entries(FORMER_V2_PLANS).filter(([, former]) => 'kit' in former);
    expect(drawn).toHaveLength(22);
    for (const [topic, former] of Object.entries(FORMER_V2_PLANS)) {
      expect(former.plan.variant, topic).toBe('kit' in former ? 'stage' : 'plain');
      if (!('kit' in former)) expect(former.plan.landmark, topic).toBeDefined();
    }
  });

  it('hold nothing for a recipe that was never a v2 recipe', () => {
    expect(formerV2PlanOf('exoplanet-kinds')).toBeUndefined();
  });
});

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

  it('give a stage only to the recipes a kit draws: the Seasons parts, the Earth & sky and Space recipes of D-194 and the heart and nerve recipes of D-201, never a recipe without a kit', () => {
    const stage = SPIKE_TOPICS_V2.filter((topic) => spikeRecipeV2(topic).variant === 'stage');
    expect(stage).toEqual([
      'seasons',
      'seasons-hemispheres',
      'seasons-limits',
      'tides',
      'tides-spring-neap',
      'greenhouse-radiation',
      'greenhouse-balance',
      'stars-fusion',
      'exoplanet-habitable-zone',
      'cardiac-cycle',
      'blood-pressure',
      'reflex-arc',
    ]);
    for (const topic of SPIKE_TOPICS_V2)
      expect(spikeRecipeV2(topic).variant === 'stage', topic).toBe(kitOf(topic) !== undefined);
    // The habitable zone is drawn by the starlight kit (D-204); kinds of planet have no kit and stay plain.
    expect(spikeRecipeV2('exoplanet-habitable-zone')).toMatchObject({ variant: 'stage', kit: 'starlight.v1' });
    expect(spikeRecipeV2('exoplanet-kinds').variant).toBe('plain');
    expect(spikeRecipeV2('exoplanet-kinds')).not.toHaveProperty('kit');
  });

  it('draw every stage recipe with the kit its library entry names', () => {
    for (const topic of Object.keys(TOPICS) as ScrollTopic[]) {
      const recipe = spikeRecipeV2(topic);
      expect(recipe.kit, topic).toBe(kitOf(topic));
    }
  });

  it('measure the eight recipes the drawing kits of D-194 give a picture, with one command line, the one the runbook prints', () => {
    expect(SKY_SPIKE_TOPICS_V2).toHaveLength(8);
    expect(new Set(SKY_SPIKE_TOPICS_V2).size).toBe(8);
    expect(parseSpikeTopics(SKY_SPIKE_TOPICS_V2.join(','))).toEqual(SKY_SPIKE_TOPICS_V2);
    const kits = new Map<string, string[]>();
    for (const topic of SKY_SPIKE_TOPICS_V2) {
      const recipe = spikeRecipeV2(topic);
      expect(recipe.variant, topic).toBe('stage');
      expect(['earth', 'space']).toContain(TOPICS[topic].systemId);
      kits.set(recipe.kit ?? '', [...(kits.get(recipe.kit ?? '') ?? []), topic]);
    }
    expect([...kits.keys()].sort()).toEqual(['greenhouse.v1', 'star.v1', 'tides.v1', 'transit.v1']);
    const runbook = readFileSync(
      new URL('../../../../../../../docs/v2/operations/scroll-production.md', import.meta.url),
      'utf8',
    );
    expect(runbook).toContain(`--topics ${SKY_SPIKE_TOPICS_V2.join(',')}`);
  });

  it('measure the six Human body recipes the drawing kits of D-201 give a picture, with one command line, the one the runbook prints', () => {
    expect(BODY_SPIKE_TOPICS_V2).toHaveLength(6);
    expect(new Set(BODY_SPIKE_TOPICS_V2).size).toBe(6);
    expect(parseSpikeTopics(BODY_SPIKE_TOPICS_V2.join(','))).toEqual(BODY_SPIKE_TOPICS_V2);
    const kits = new Map<string, string[]>();
    for (const topic of BODY_SPIKE_TOPICS_V2) {
      const recipe = spikeRecipeV2(topic);
      expect(recipe.variant, topic).toBe('stage');
      expect(TOPICS[topic].systemId).toBe('human-body');
      kits.set(recipe.kit ?? '', [...(kits.get(recipe.kit ?? '') ?? []), topic]);
    }
    expect(Object.fromEntries(kits)).toEqual({
      'circulation.v1': ['cardiac-cycle', 'blood-pressure', 'oxygen-transport'],
      'nerve.v1': ['action-potential', 'synapse-signalling', 'reflex-arc'],
    });
    const runbook = readFileSync(
      new URL('../../../../../../../docs/v2/operations/scroll-production.md', import.meta.url),
      'utf8',
    );
    expect(runbook).toContain(`--topics ${BODY_SPIKE_TOPICS_V2.join(',')}`);
    expect(runbook).toContain('--spike-id body-kits-v18');
  });

  it('measure the five Space recipes the drawing kits of D-204 give a picture, with one command line, the one the runbook prints', () => {
    expect(SPACE_SPIKE_TOPICS_V2).toEqual([
      'stars-colour-brightness',
      'exoplanet-habitable-zone',
      'black-hole-formation',
      'black-hole-horizon',
      'black-hole-evidence',
    ]);
    expect(parseSpikeTopics(SPACE_SPIKE_TOPICS_V2.join(','))).toEqual(SPACE_SPIKE_TOPICS_V2);
    const kits = new Map<string, string[]>();
    for (const topic of SPACE_SPIKE_TOPICS_V2) {
      const recipe = spikeRecipeV2(topic);
      expect(recipe.variant, topic).toBe('stage');
      expect(recipe.defaulted, topic).toBe(false);
      // The plan decides these since D-217: no page of theirs states a common wrong belief.
      expect(recipe.misconception.kind, topic).toBe('none');
      expect(TOPICS[topic].systemId).toBe('space');
      kits.set(recipe.kit ?? '', [...(kits.get(recipe.kit ?? '') ?? []), topic]);
    }
    expect([...kits.keys()].sort()).toEqual(['black-hole.v1', 'starlight.v1']);
    const runbook = readFileSync(
      new URL('../../../../../../../docs/v2/operations/scroll-production.md', import.meta.url),
      'utf8',
    );
    expect(runbook).toContain(`--topics ${SPACE_SPIKE_TOPICS_V2.join(',')}`);
    expect(runbook).toContain('--spike-id space-kits-v19');
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
    // recipe of the first waves and the kit waves.
    expect(SPIKE_TOPICS_V2.filter((topic) => spikeRecipeV2(topic).misconception.kind === 'none')).toEqual(
      SPIKE_TOPICS_V2.filter((topic) => topic !== 'seasons' && planOf(topic) !== undefined),
    );
    expect(SPIKE_TOPICS_V2.filter((topic) => planOf(topic) === undefined)).toEqual([]);
  });

  it('spike a recipe the plan marks v2 exactly as the library will produce it, and a recipe that became document v3 as it was a v2 recipe with its kit', () => {
    for (const topic of SPIKE_TOPICS_V2) {
      const planned = planOf(topic);
      if (planned === undefined) continue;
      expect(spikeRecipeV2(topic), topic).toEqual({
        ...planned,
        ...(kitOf(topic) === undefined ? {} : { kit: kitOf(topic) }),
        defaulted: false,
      });
    }
    expect(spikeRecipeV2('seasons-elsewhere')).toEqual({
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sideways-giant', name: 'The Sideways Giant' },
      defaulted: false,
    });
  });

  it('default to a plain Scroll with no misconception for a recipe the plan has not marked (`exoplanet-kinds`), and say so', () => {
    expect(spikeRecipeV2('exoplanet-kinds')).toEqual({
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

describe('--blocks: the play blocks a spike asks for before a recipe is marked (D-207)', () => {
  it('reads a recipe with blocks and a guide, and puts them in the recipe the spike runs', () => {
    const parsed = parseSpikeBlocks('hybrid-sorting=sort+ray,big-o-growth=chart');
    expect(parsed?.get('hybrid-sorting')).toEqual({ blocks: ['sort'], guide: 'ray' });
    expect(parsed?.get('big-o-growth')).toEqual({ blocks: ['chart'] });
    const recipe = spikeRecipeV2('hybrid-sorting', parsed?.get('hybrid-sorting'));
    expect(recipe).toMatchObject({ variant: 'plain', blocks: ['sort'], guide: 'ray' });
    expect(spikeRecipeV2('hybrid-sorting')).not.toHaveProperty('blocks');
  });

  it('refuses a recipe that is not in the library, an unknown word, a repeat, and more blocks than a Scroll may have', () => {
    expect(parseSpikeBlocks('no-such-recipe=sort')).toBeUndefined();
    expect(parseSpikeBlocks('hybrid-sorting=sorting')).toBeUndefined();
    expect(parseSpikeBlocks('hybrid-sorting=sort,hybrid-sorting=chart')).toBeUndefined();
    expect(parseSpikeBlocks('hybrid-sorting=sort+sort')).toBeUndefined();
    expect(parseSpikeBlocks('hybrid-sorting=sort+fork+chart')).toBeUndefined();
    expect(parseSpikeBlocks('hybrid-sorting')).toBeUndefined();
  });
});

describe('the four recipes of the play-block spike (D-207, D-210)', () => {
  it('are library recipes, one block each (the fork with Ray), and ask for the blocks they are named with', () => {
    expect(BLOCK_SPIKE_TOPICS_V2).toHaveLength(4);
    const parsed = parseSpikeBlocks(BLOCK_SPIKE_BLOCKS_V2);
    expect([...(parsed?.keys() ?? [])]).toEqual([...BLOCK_SPIKE_TOPICS_V2]);
    expect([...(parsed?.values() ?? [])].map((asked) => asked.blocks)).toEqual([
      ['sort'],
      ['chart'],
      ['scale'],
      ['fork'],
    ]);
    expect(parsed?.get('seasons-elsewhere')?.guide).toBe('ray');
    for (const topic of BLOCK_SPIKE_TOPICS_V2) expect(Object.hasOwn(TOPICS, topic)).toBe(true);
  });

  it('are marked by nobody: the plan still names no block and no guide on any recipe', () => {
    for (const topic of BLOCK_SPIKE_TOPICS_V2) {
      const plan = TOPICS[topic].scrollV2 as { blocks?: unknown; guide?: unknown } | undefined;
      expect(plan?.blocks).toBeUndefined();
      expect(plan?.guide).toBeUndefined();
    }
  });
});
