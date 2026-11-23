import type { ScrollV3Plan } from '../../domain/library/plan.js';
import type { ScrollTopic } from '../topics.js';

/**
 * The ten recipes of the document v3 writer spike (#771). The spike carries its own plan for each, so a spike run is the same
 * whatever the library plan says: the kind of essay, what each of its three sections is for and, for a recipe a drawing kit once
 * pictured, the pictures that replace the kit. A recipe with no `pictures` leaves the choice of kinds to the writer.
 * Every plan names no misconception. Five of the ten (`seasons`, `tides-spring-neap`, `greenhouse-radiation`, `cardiac-cycle`,
 * `black-hole-formation`) are document v3 recipes in the library since #787, with a plan of their own written from their pages;
 * the spike's plan for them is the measurement's, not the library's.
 */
export const SPIKE_PLANS_V3 = {
  seasons: {
    shape: 'argument',
    sections: [
      'Why distance is the wrong answer',
      'The lean and what it does to sunlight',
      'What distance still does, and other skies',
    ],
    pictures: [
      { kind: 'statement', purpose: "the size of Earth's lean, as one number" },
      {
        kind: 'grid',
        purpose: 'the two hemispheres in June and in December: which leans toward the Sun and which season each has',
      },
    ],
    misconception: { kind: 'none' },
  },
  'tides-spring-neap': {
    shape: 'mechanism',
    sections: [
      'When the Sun and Moon pull together',
      'A week later, at right angles',
      'What the names do and do not mean',
    ],
    pictures: [
      {
        kind: 'cycle',
        purpose: "the Moon's phases through the month, with the spring and neap tides at their alignments",
      },
    ],
    misconception: { kind: 'none' },
  },
  'greenhouse-radiation': {
    shape: 'mechanism',
    sections: ['Sunlight on the way in', 'Heat on the way out', 'What the air sends back'],
    pictures: [
      {
        kind: 'flow',
        purpose: 'where incoming sunlight goes: reflected, absorbed by the air, absorbed by the surface',
      },
      {
        kind: 'flow',
        purpose: "where the surface's heat goes: absorbed by the air, sent on to space and sent back down",
      },
    ],
    misconception: { kind: 'none' },
  },
  'cardiac-cycle': {
    shape: 'mechanism',
    sections: ['Relax and fill', 'Squeeze and pump', 'Two pumps side by side'],
    pictures: [
      { kind: 'cycle', purpose: 'the stages of one heartbeat, from filling to pumping and back' },
      {
        kind: 'grid',
        purpose: 'the right and left sides of the heart: where each receives blood from and where it sends it',
      },
    ],
    misconception: { kind: 'none' },
  },
  'black-hole-formation': {
    shape: 'story',
    sections: ['A heavy star runs out of fuel', 'Collapse and explosion', 'The giants nobody can yet explain'],
    pictures: [
      { kind: 'flow', purpose: 'from a heavy star to a stellar-mass black hole, step by step' },
      {
        kind: 'grid',
        purpose: 'stellar-mass and supermassive black holes: where each is found and what is known of how it forms',
      },
    ],
    misconception: { kind: 'none' },
  },
  'gradient-descent': {
    shape: 'mechanism',
    sections: ['Feeling the slope in the fog', 'How big a step', 'What the valley is not'],
    misconception: { kind: 'none' },
  },
  'dns-lookup': {
    shape: 'mechanism',
    sections: ['A name is a path through a tree', 'Following the tree down', 'What the lookup does not do'],
    misconception: { kind: 'none' },
  },
  'industrial-causes': {
    shape: 'argument',
    sections: ['Why there and why then', 'What freed the people and the power', 'What historians still argue about'],
    misconception: { kind: 'none' },
  },
  'immune-memory': {
    shape: 'mechanism',
    sections: ['The first meeting', 'What stays behind', 'Practising on a harmless form'],
    misconception: { kind: 'none' },
  },
  'exoplanet-kinds': {
    shape: 'argument',
    sections: [
      'A planet the Solar System lacks',
      'What the name says, and what it does not',
      'Measured against our own planets',
    ],
    misconception: { kind: 'none' },
  },
} as const satisfies Readonly<Record<string, ScrollV3Plan>>;

/** A key of the table that is also a library recipe (a test keeps the two in step). */
export type SpikeTopicV3 = Extract<ScrollTopic, keyof typeof SPIKE_PLANS_V3>;

function isSpikeTopic(key: string): key is SpikeTopicV3 {
  return Object.hasOwn(SPIKE_PLANS_V3, key);
}

/** The ten recipes, in the order of the table. */
export const SPIKE_TOPICS_V3: readonly SpikeTopicV3[] = Object.keys(SPIKE_PLANS_V3).filter(isSpikeTopic);

/** The plan of one spike recipe, as the writer's instructions read it. */
export const spikePlanV3 = (key: SpikeTopicV3): ScrollV3Plan => SPIKE_PLANS_V3[key];

/**
 * Recipe keys from `--topics a,b,c`: only the ten of the spike's table, repeats dropped. `undefined` when any name is not
 * one of them. Each is a library recipe, so its brief and pages are the recipe's own.
 */
export function parseSpikeTopicsV3(raw: string): readonly SpikeTopicV3[] | undefined {
  const keys = raw.split(',').map((key) => key.trim());
  return keys.every(isSpikeTopic) ? [...new Set(keys)] : undefined;
}

/** The two arms: `a` writes the whole Scroll in one reply, `b` writes the prose and then stages it. */
export const SPIKE_ARMS = ['a', 'b'] as const;
export type SpikeArm = (typeof SPIKE_ARMS)[number];

/** Arms from `--arms a,b`; `undefined` when a name is not an arm. Repeats are dropped. */
export function parseSpikeArms(raw: string): readonly SpikeArm[] | undefined {
  const arms = raw.split(',').map((arm) => arm.trim());
  return arms.length > 0 && arms.every((arm): arm is SpikeArm => (SPIKE_ARMS as readonly string[]).includes(arm))
    ? [...new Set(arms)]
    : undefined;
}
