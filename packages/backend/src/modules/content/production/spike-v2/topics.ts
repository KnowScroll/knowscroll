import { LIMITS_V2 } from '@knowscroll/scroll-model';
import type { RecipeDataV2 } from '@knowscroll/scroll-model/producer';
import {
  GUIDE_CHARACTER_IDS,
  PLAY_BLOCK_KINDS,
  type GuideCharacterId,
  type PlayBlockKind,
} from '../../domain/library/plan.js';
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
 * The play blocks and the guide a spike asks the writer for on a recipe, before a person marks the recipe
 * (D-207). The library plan carries them once the recipe is marked; until then `--blocks` supplies them, so a
 * spike can measure a block on a recipe without changing the plan.
 */
export interface SpikeBlocks {
  readonly blocks: readonly PlayBlockKind[];
  readonly guide?: GuideCharacterId;
}

/**
 * `--blocks <recipe>=<word>[+<word>…],…`: for each recipe the blocks to ask for (`sort`, `fork`, `scale`,
 * `chart`) and, as `ray`, the guide. `undefined` when a recipe is not in the library, a word is unknown, a recipe
 * is named twice, or a recipe asks for more blocks than a Scroll may have.
 */
export function parseSpikeBlocks(raw: string): ReadonlyMap<ScrollTopic, SpikeBlocks> | undefined {
  const found = new Map<ScrollTopic, SpikeBlocks>();
  for (const entry of raw.split(',')) {
    const [name, words, ...rest] = entry.trim().split('=');
    const topic = parseScrollTopic(name?.trim());
    if (topic === undefined || words === undefined || rest.length > 0 || found.has(topic)) return undefined;
    const parts = words.split('+').map((word) => word.trim());
    const blocks = parts.filter((word): word is PlayBlockKind =>
      (PLAY_BLOCK_KINDS as readonly string[]).includes(word),
    );
    const guides = parts.filter((word): word is GuideCharacterId =>
      (GUIDE_CHARACTER_IDS as readonly string[]).includes(word),
    );
    if (blocks.length + guides.length !== parts.length || new Set(blocks).size !== blocks.length || guides.length > 1)
      return undefined;
    if (blocks.length > LIMITS_V2.otherInteractives) return undefined;
    found.set(topic, { blocks, ...(guides[0] === undefined ? {} : { guide: guides[0] }) });
  }
  return found;
}

/**
 * The spike's decisions for a recipe. The picture and its kit come from the recipe's own `stageKit`;
 * a recipe the plan has not marked has no misconception, and the line says so.
 */
export function spikeRecipeV2(topic: ScrollTopic, asked?: SpikeBlocks): SpikeRecipeV2 {
  const { scrollV2: planned, stageKit } = TOPICS[topic];
  const kit = stageKit === undefined ? {} : { kit: stageKit };
  // What the operator asks for wins over what the plan holds: the spike is how a recipe's blocks are measured before it is marked.
  const extra =
    asked === undefined ? {} : { blocks: asked.blocks, ...(asked.guide === undefined ? {} : { guide: asked.guide }) };
  if (planned !== undefined) return { ...planned, ...kit, ...extra, defaulted: false };
  const variant = stageKit === undefined ? 'plain' : 'stage';
  return { variant, ...kit, ...extra, misconception: { kind: 'none' }, defaulted: true };
}

/** Recipe keys from `--topics a,b,c`; `undefined` when any name is not a library recipe. Repeats are dropped. */
export function parseSpikeTopics(raw: string): readonly ScrollTopic[] | undefined {
  const keys = raw.split(',').map((key) => parseScrollTopic(key.trim()));
  return keys.length > 0 && keys.every((key): key is ScrollTopic => key !== undefined) ? [...new Set(keys)] : undefined;
}

/**
 * The four recipes whose pages support one play block each, to measure with the v20 writer before any is
 * marked (D-207, D-210): a sort of Timsort's steps, a growing chart of the population figures of the
 * Industrial Revolution page, a scale of black-hole masses (stellar, intermediate, Sagittarius A*, the largest
 * known) and a fork between Mars and Uranus with Ray as the guide. Run them with `BLOCK_SPIKE_BLOCKS_V2` as
 * `--blocks`; the plan marks nothing, and a person marks a recipe's blocks after reading the spike.
 */
export const BLOCK_SPIKE_TOPICS_V2: readonly ScrollTopic[] = [
  'hybrid-sorting',
  'industrial-causes',
  'black-hole-formation',
  'seasons-elsewhere',
];
export const BLOCK_SPIKE_BLOCKS_V2 =
  'hybrid-sorting=sort,industrial-causes=chart,black-hole-formation=scale,seasons-elsewhere=fork+ray';
