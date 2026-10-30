import type { Misconception, SourceLabel } from '@knowscroll/scroll-model';
import type { RecipeDataV2 } from '@knowscroll/scroll-model/producer';
import { parseScrollTopic, type ScrollTopic } from '../topics.js';

/**
 * What the writer spike decides for a library recipe before the model starts: whether the Scroll has
 * the Earth & sky stage, and the misconception its first call tests. In the product these become
 * recipe fields (S-6); the spike keeps them here so the library plan and its tests are untouched.
 *
 * A misconception is a claim a person decided, with a source label a person has checked
 * (`reviewed: true`). Only the seasons myth has one, taken from the V3 design. Every other label is
 * a placeholder marked `reviewed: false`: a document that carries one is a spike result, never
 * a Scroll the library may admit.
 */
export interface SpikeRecipeV2 extends RecipeDataV2 {
  /** True for a recipe this table does not list: plain, with no misconception. */
  readonly defaulted: boolean;
}

const PENDING: SourceLabel = { label: 'A common idea; its source is still to be named', reviewed: false };
const myth = (claim: string, source: SourceLabel = PENDING): Misconception => ({ kind: 'myth', claim, source });
const stage = (misconception: Misconception): RecipeDataV2 => ({ variant: 'stage', misconception });
const plain = (misconception: Misconception): RecipeDataV2 => ({ variant: 'plain', misconception });

/** The seasons myth is the V3 design's own example, with the source it names (design pages 3 and 6). */
const SEASONS_SOURCE: SourceLabel = { label: 'A Private Universe (1987 documentary)', reviewed: true };

const SPIKE_RECIPES: Readonly<Partial<Record<ScrollTopic, RecipeDataV2>>> = {
  // Earth & sky and Space: the stage candidates.
  seasons: stage(
    myth('Earth has seasons because it is closer to the Sun in summer and farther away in winter.', SEASONS_SOURCE),
  ),
  'seasons-hemispheres': stage(myth('Summer comes to the whole Earth at the same time.')),
  'seasons-limits': stage(myth('Every place on Earth has the same four seasons of equal length.')),
  tides: stage(myth('The Moon makes one bulge of water, on the side of Earth that faces it.')),
  'tides-spring-neap': stage(myth('Spring tides happen in the spring.')),
  'greenhouse-radiation': stage(myth('The atmosphere traps heat like a lid that stops warm air from rising away.')),
  'greenhouse-balance': stage(myth('Heat trapped by the atmosphere means energy only goes in and never leaves.')),
  'stars-fusion': stage(myth('The Sun shines because it burns, the way a fire burns.')),
  'exoplanet-habitable-zone': stage(myth('A planet inside the habitable zone is a planet with life on it.')),
  // Human body: calls, no stage.
  'cardiac-cycle': plain(myth('The heart squeezes all four of its chambers at once in a single beat.')),
  'blood-pressure': plain(myth('Blood pressure is set by how fast the heart beats and nothing else.')),
  'reflex-arc': plain(myth('A reflex is a decision the brain makes very quickly.')),
  'immune-memory': plain(myth('The immune system forgets an infection as soon as it is over.')),
  // Computing, machine learning and history: calls, no stage.
  'dns-lookup': plain(myth('DNS is one giant list that a single server holds for the whole internet.')),
  'hash-tables': plain(myth('A hash table finds an item in the same instant however full it gets.')),
  'event-loop': plain(myth('JavaScript runs many things at the very same moment on many threads.')),
  'gradient-descent': plain(myth('Walking downhill always finds the best possible answer.')),
  'attention-mechanism': plain(
    myth('Attention in a model works like a person paying attention: one word in focus, the rest ignored.'),
  ),
  overfitting: plain(myth('A model that scores perfectly on its training data must be a perfect model.')),
  'industrial-causes': plain({ kind: 'none' }),
};

/**
 * The twenty recipes of the spike, in the order they run: the three Seasons parts first, then nine
 * Earth & sky and Space recipes in all (stage candidates), four of the human body, and seven of
 * computing, machine learning and history (calls, no stage).
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

/** The spike's decisions for a recipe; a recipe the table does not list runs plain, with no misconception. */
export function spikeRecipeV2(topic: ScrollTopic): SpikeRecipeV2 {
  const listed = SPIKE_RECIPES[topic];
  return listed === undefined
    ? { variant: 'plain', misconception: { kind: 'none' }, defaulted: true }
    : { ...listed, defaulted: false };
}

/** Recipe keys from `--topics a,b,c`; `undefined` when any name is not a library recipe. Repeats are dropped. */
export function parseSpikeTopics(raw: string): readonly ScrollTopic[] | undefined {
  const keys = raw.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}
