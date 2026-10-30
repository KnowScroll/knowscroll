import type { Misconception, SourceLabel } from '@knowscroll/scroll-model';
import type { RecipeDataV2 } from '@knowscroll/scroll-model/producer';
import { parseScrollTopic, TOPICS, type ScrollTopic } from '../topics.js';

/**
 * What the writer spike decides for a library recipe before the model starts: whether the Scroll has
 * a pinned picture, and the misconception its first call tests.
 *
 * Whether there is a picture is recipe data: a recipe has one only where a drawing kit draws its
 * subject (`stageKit` in the library plan, D-125). The misconception is still the spike's own table
 * and becomes a recipe field in S-6. It is a claim a person decided, with a source label a person
 * has checked (`reviewed: true`). Only the seasons myth has one, taken from the V3 design. Every
 * other label is a placeholder marked `reviewed: false`: a document that carries one is a spike
 * result, never a Scroll the library may admit.
 */
export interface SpikeRecipeV2 extends RecipeDataV2 {
  /** True for a recipe this table does not list: plain, with no misconception. */
  readonly defaulted: boolean;
}

const PENDING: SourceLabel = { label: 'A common idea; its source is still to be named', reviewed: false };
const myth = (claim: string, source: SourceLabel = PENDING): Misconception => ({ kind: 'myth', claim, source });

/** The seasons myth is the V3 design's own example, with the source it names (design pages 3 and 6). */
const SEASONS_SOURCE: SourceLabel = { label: 'A Private Universe (1987 documentary)', reviewed: true };

const SPIKE_MYTHS: Readonly<Partial<Record<ScrollTopic, Misconception>>> = {
  // Earth & sky: the recipes a kit draws are the Seasons parts; the rest are plain Scrolls until a kit draws them.
  seasons: myth(
    'Earth has seasons because it is closer to the Sun in summer and farther away in winter.',
    SEASONS_SOURCE,
  ),
  'seasons-hemispheres': myth('Summer comes to the whole Earth at the same time.'),
  'seasons-limits': myth('Every place on Earth has the same four seasons of equal length.'),
  'seasons-elsewhere': myth('Every planet has four seasons that last about as long as Earth’s.'),
  tides: myth('The Moon makes one bulge of water, on the side of Earth that faces it.'),
  'tides-spring-neap': myth('Spring tides happen in the spring.'),
  'greenhouse-radiation': myth('The atmosphere traps heat like a lid that stops warm air from rising away.'),
  'greenhouse-balance': myth('Heat trapped by the atmosphere means energy only goes in and never leaves.'),
  'stars-fusion': myth('The Sun shines because it burns, the way a fire burns.'),
  'exoplanet-habitable-zone': myth('A planet inside the habitable zone is a planet with life on it.'),
  // Human body.
  'cardiac-cycle': myth('The heart squeezes all four of its chambers at once in a single beat.'),
  'blood-pressure': myth('Blood pressure is set by how fast the heart beats and nothing else.'),
  'reflex-arc': myth('A reflex is a decision the brain makes very quickly.'),
  'immune-memory': myth('The immune system forgets an infection as soon as it is over.'),
  // Computing, machine learning and history.
  'dns-lookup': myth('DNS is one giant list that a single server holds for the whole internet.'),
  'hash-tables': myth('A hash table finds an item in the same instant however full it gets.'),
  'event-loop': myth('JavaScript runs many things at the very same moment on many threads.'),
  'gradient-descent': myth('Walking downhill always finds the best possible answer.'),
  'attention-mechanism': myth(
    'Attention in a model works like a person paying attention: one word in focus, the rest ignored.',
  ),
  overfitting: myth('A model that scores perfectly on its training data must be a perfect model.'),
  'industrial-causes': { kind: 'none' },
};

/**
 * The twenty recipes of the first spike, in the order they ran: the three Seasons parts first, then
 * nine Earth & sky and Space recipes in all, four of the human body, and seven of computing,
 * machine learning and history. Only the Seasons parts are drawn by a kit, so only they get a
 * stage; the rest are plain Scrolls with calls. `seasons-elsewhere` is not one of the twenty: name
 * it with `--topics` (see `SEASONS_SPIKE_TOPICS_V2`).
 */
export const SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
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
  'immune-memory',
  'dns-lookup',
  'hash-tables',
  'event-loop',
  'gradient-descent',
  'attention-mechanism',
  'overfitting',
  'industrial-causes',
];

/** The Seasons trio and "Seasons elsewhere": the recipes the Earth & sky kit draws, for measuring the stage. */
export const SEASONS_SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
  'seasons',
  'seasons-hemispheres',
  'seasons-limits',
  'seasons-elsewhere',
];

/**
 * The spike's decisions for a recipe. The picture comes from the recipe's own `stageKit`; a recipe
 * the misconception table does not list has no misconception, and the line says so.
 */
export function spikeRecipeV2(topic: ScrollTopic): SpikeRecipeV2 {
  const variant = TOPICS[topic].stageKit === undefined ? 'plain' : 'stage';
  const listed = SPIKE_MYTHS[topic];
  return listed === undefined
    ? { variant, misconception: { kind: 'none' }, defaulted: true }
    : { variant, misconception: listed, defaulted: false };
}

/** Recipe keys from `--topics a,b,c`; `undefined` when any name is not a library recipe. Repeats are dropped. */
export function parseSpikeTopics(raw: string): readonly ScrollTopic[] | undefined {
  const keys = raw.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}
