import type { RecipeDataV2 } from '@knowscroll/scroll-model/producer';
import { parseScrollTopic, TOPICS, type ScrollTopic } from '../topics.js';

/**
 * What the writer spike decides for a library recipe before the model starts: whether the Scroll has
 * a pinned picture, and the misconception its first call tests.
 *
 * A recipe the library plan marks `scrollV2` is spiked exactly as it is produced: the plan's variant
 * and misconception (D-137), so a spike measures what the library will publish. For a recipe the plan
 * has not marked, whether there is a picture is recipe data (`stageKit`, D-125) and there is no
 * misconception.
 */
export interface SpikeRecipeV2 extends RecipeDataV2 {
  /** True for a recipe the plan has not marked: decided by its kit alone, with no misconception. */
  readonly defaulted: boolean;
}

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
 * a recipe the plan has not marked has no misconception, and the line says so.
 */
export function spikeRecipeV2(topic: ScrollTopic): SpikeRecipeV2 {
  const { scrollV2: planned, stageKit } = TOPICS[topic];
  const kit = stageKit === undefined ? {} : { kit: stageKit };
  if (planned !== undefined) return { ...planned, ...kit, defaulted: false };
  const variant = stageKit === undefined ? 'plain' : 'stage';
  return { variant, ...kit, misconception: { kind: 'none' }, defaulted: true };
}

/** Recipe keys from `--topics a,b,c`; `undefined` when any name is not a library recipe. Repeats are dropped. */
export function parseSpikeTopics(raw: string): readonly ScrollTopic[] | undefined {
  const keys = raw.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}
