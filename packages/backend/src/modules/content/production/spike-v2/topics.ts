import type { Misconception, SourceLabel } from '@knowscroll/scroll-model';
import type { RecipeDataV2 } from '@knowscroll/scroll-model/producer';
import { parseScrollTopic, TOPICS, type ScrollTopic } from '../topics.js';

/**
 * What the writer spike decides for a library recipe before the model starts: whether the Scroll has
 * a pinned picture, and the misconception its first call tests.
 *
 * A recipe the library plan marks `scrollV2` is spiked exactly as it is produced: the plan's variant
 * and misconception (D-137), so a spike measures what the library will publish. For every other
 * recipe whether there is a picture is recipe data (`stageKit`, D-125), and the misconception is the
 * spike's own table below. It is a claim a person decided, with a source label a person has checked
 * (`reviewed: true`). No label in this table is checked: each is a placeholder marked
 * `reviewed: false`, so a document that carries one is a spike result, never a Scroll the library
 * may admit.
 */
export interface SpikeRecipeV2 extends RecipeDataV2 {
  /** True for a recipe this table does not list: plain, with no misconception. */
  readonly defaulted: boolean;
}

const PENDING: SourceLabel = { label: 'A common idea; its source is still to be named', reviewed: false };
const myth = (claim: string, source: SourceLabel = PENDING): Misconception => ({ kind: 'myth', claim, source });

const SPIKE_MYTHS: Readonly<Partial<Record<ScrollTopic, Misconception>>> = {
  // Earth & sky. The four Seasons recipes are decided by the library plan (D-137), not by this table.
  tides: myth('The Moon makes one bulge of water, on the side of Earth that faces it.'),
  'tides-spring-neap': myth('Spring tides happen in the spring.'),
  'greenhouse-radiation': myth('The atmosphere traps heat like a lid that stops warm air from rising away.'),
  'greenhouse-balance': myth('Heat trapped by the atmosphere means energy only goes in and never leaves.'),
  'stars-fusion': myth('The Sun shines because it burns, the way a fire burns.'),
  'stars-lifecycle': myth('The Sun will end its life by exploding as a supernova.'),
  'exoplanet-transit': myth('Astronomers find planets around other stars by photographing them.'),
  greenhouse: { kind: 'none' },
  'exoplanet-habitable-zone': myth('A planet inside the habitable zone is a planet with life on it.'),
  'stars-colour-brightness': myth('A star’s colour tells you how old it is.'),
  'black-hole-formation': myth('The Sun will one day become a black hole.'),
  'black-hole-horizon': myth('A black hole sucks in everything around it like a cosmic vacuum cleaner.'),
  'black-hole-evidence': myth('Nobody has any evidence that black holes exist, because they cannot be seen.'),
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
 * machine learning and history. A recipe gets a stage only where its library entry names a kit
 * (`stageKit`), so the stage recipes among them are the three Seasons parts and the ones a kit of
 * D-194 draws; the rest are plain Scrolls with calls. `seasons-elsewhere` is not one of the twenty: name
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

/**
 * The Seasons trio, which the Earth & sky kit draws (a stage), and "Seasons elsewhere" (a plain
 * Scroll: the kit draws no other world), to measure the stage and the Mars and Uranus sources again.
 */
export const SEASONS_SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
  'seasons',
  'seasons-hemispheres',
  'seasons-limits',
  'seasons-elsewhere',
];

/**
 * The eight Earth & sky and Space recipes the drawing kits of D-194 give a picture, to measure with the
 * v17 prompt: tides, the greenhouse effect, stars and exoplanet transits. The plan marks them `scrollV2`
 * (D-217), so each runs as the library produces it: a stage Scroll with the recipe's own kit and the plan's
 * misconception (none).
 */
export const SKY_SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
  'tides',
  'tides-spring-neap',
  'greenhouse',
  'greenhouse-radiation',
  'greenhouse-balance',
  'stars-fusion',
  'stars-lifecycle',
  'exoplanet-transit',
];

/**
 * The six Human body recipes the drawing kits of D-201 give a picture, to measure with the v18 prompt before the
 * first wave of them: the heart and the blood with `circulation.v1`, the nerves with `nerve.v1`. Each
 * runs as the library produces it (D-199, D-201): a stage Scroll drawn with its recipe's kit, with the plan's
 * misconception (none).
 */
export const BODY_SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
  'cardiac-cycle',
  'blood-pressure',
  'oxygen-transport',
  'action-potential',
  'synapse-signalling',
  'reflex-arc',
];

/**
 * The five Space recipes the drawing kits of D-204 give a picture, to measure with the v19 prompt: colour and brightness
 * and the habitable zone with `starlight.v1`, and the formation, the horizon and the
 * evidence of black holes with `black-hole.v1`. The plan marks them `scrollV2` (D-217), so each runs as the
 * library produces it: a stage Scroll with the recipe's own kit and the plan's misconception (none).
 */
export const SPACE_SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
  'stars-colour-brightness',
  'exoplanet-habitable-zone',
  'black-hole-formation',
  'black-hole-horizon',
  'black-hole-evidence',
];

/**
 * The spike's decisions for a recipe. The picture and its kit come from the recipe's own `stageKit`;
 * a recipe the misconception table does not list has no misconception, and the line says so.
 */
export function spikeRecipeV2(topic: ScrollTopic): SpikeRecipeV2 {
  const { scrollV2: planned, stageKit } = TOPICS[topic];
  const kit = stageKit === undefined ? {} : { kit: stageKit };
  if (planned !== undefined) return { ...planned, ...kit, defaulted: false };
  const variant = stageKit === undefined ? 'plain' : 'stage';
  const listed = SPIKE_MYTHS[topic];
  return listed === undefined
    ? { variant, ...kit, misconception: { kind: 'none' }, defaulted: true }
    : { variant, ...kit, misconception: listed, defaulted: false };
}

/** Recipe keys from `--topics a,b,c`; `undefined` when any name is not a library recipe. Repeats are dropped. */
export function parseSpikeTopics(raw: string): readonly ScrollTopic[] | undefined {
  const keys = raw.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}
