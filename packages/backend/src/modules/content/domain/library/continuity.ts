import type { RecipeKey } from './index.js';

/**
 * An ordered run of library Scrolls inside one planet, where each part builds on the one before it.
 * Declared by recipe key; the admission command resolves each key to the Scroll revision currently
 * admitted for it. Only declare an order a recipe's brief supports.
 */
export interface LibrarySeries {
  /** Stable series identity (`content.series_units.series_id`). Never reused for another run. */
  readonly id: string;
  /** Part 1 first. Two to four parts, all on one planet, no recipe in two series. */
  readonly parts: readonly RecipeKey[];
}

/** A "related perspective" move: another explanation, not the next part. One per source recipe. */
export interface LibraryRelatedLink {
  readonly from: RecipeKey;
  readonly to: RecipeKey;
  /** The move in a few words, as the person would name it. */
  readonly label: string;
}

/**
 * The series of the library. Each comment names what in the briefs supports the order.
 */
export const LIBRARY_SERIES: readonly LibrarySeries[] = [
  // The tilt comes first; the hemispheres and the limits of the picture both start from it.
  { id: 'library.earth.seasons', parts: ['seasons', 'seasons-hemispheres', 'seasons-limits'] },
  // Forcing first; alignment and coastlines each change what the same forcing does.
  { id: 'library.earth.tides', parts: ['tides', 'tides-spring-neap', 'tides-coasts'] },
  // The briefs say it themselves: balance keeps radiation paths "to brief context", and the analogy
  // audit is "not a retelling of the radiation path or a second balance tutorial".
  {
    id: 'library.earth.greenhouse-effect',
    parts: ['greenhouse-radiation', 'greenhouse-balance', 'greenhouse-limits'],
  },
  // Fusion holds a star steady; the lifecycle is what happens when that fuel runs out.
  { id: 'library.space.stars', parts: ['stars-fusion', 'stars-lifecycle'] },
  // The mechanism, a worked case of it, then what its weights do not show.
  {
    id: 'library.machine-learning.attention',
    parts: ['attention-mechanism', 'attention-example', 'attention-limits'],
  },
  // Learning from examples, how the numbers are adjusted, then why fitting the examples is not enough.
  {
    id: 'library.machine-learning.training',
    parts: ['training-by-example', 'gradient-descent', 'overfitting'],
  },
  // A neuron's signal, then the step from one neuron to the next.
  { id: 'library.human-body.nervous-system', parts: ['action-potential', 'synapse-signalling'] },
  // The first response, the learned response, then the memory that makes a second exposure faster.
  {
    id: 'library.human-body.immune-system',
    parts: ['innate-immunity', 'adaptive-immunity', 'immune-memory'],
  },
  // A browser looks the name up before it opens the private connection.
  { id: 'library.computing.web-requests', parts: ['dns-lookup', 'https-handshake'] },
  // How work grows comes first; the hash table brief leans on "constant time".
  { id: 'library.computing.algorithms', parts: ['big-o-growth', 'hash-tables'] },
  // Farm workers freed by productivity (causes), the factory they went to, the towns they moved into.
  {
    id: 'library.history.industrial-revolution',
    parts: ['industrial-causes', 'factory-system', 'industrial-towns'],
  },
];

/**
 * Related perspectives: a different facet of the same planet, or a planet the brief itself leans on.
 * The model has one related slot per source revision, so a recipe appears as `from` at most once.
 */
export const LIBRARY_RELATED: readonly LibraryRelatedLink[] = [
  { from: 'greenhouse', to: 'greenhouse-limits', label: 'Where the blanket picture breaks down' },
  { from: 'stars-colour-brightness', to: 'stars-lifecycle', label: 'How stars age and end' },
  { from: 'stars-lifecycle', to: 'black-hole-formation', label: 'How the heaviest stars end' },
  { from: 'black-hole-formation', to: 'stars-lifecycle', label: 'How stars age and end' },
  { from: 'black-hole-horizon', to: 'black-hole-evidence', label: 'How we know they exist' },
  { from: 'black-hole-evidence', to: 'black-hole-horizon', label: 'What the edge of a black hole is' },
  { from: 'exoplanet-transit', to: 'exoplanet-habitable-zone', label: 'Where liquid water could exist' },
  { from: 'exoplanet-habitable-zone', to: 'exoplanet-transit', label: 'How such planets are found' },
  { from: 'exoplanet-kinds', to: 'exoplanet-habitable-zone', label: 'What habitable does and does not mean' },
  { from: 'attention-limits', to: 'long-input-cost', label: 'Why long inputs cost so much' },
  { from: 'long-input-cost', to: 'attention-mechanism', label: 'How attention scores are made' },
  { from: 'transformer-architecture', to: 'attention-mechanism', label: 'The attention step inside it' },
  { from: 'mixture-of-experts', to: 'long-input-cost', label: 'Another way to keep models affordable' },
  { from: 'token-embeddings', to: 'subword-tokens', label: 'How text is cut into tokens' },
  { from: 'subword-tokens', to: 'token-embeddings', label: 'How tokens become numbers' },
  { from: 'cardiac-cycle', to: 'blood-pressure', label: 'What sets the pressure in the vessels' },
  { from: 'blood-pressure', to: 'cardiac-cycle', label: 'How each beat pushes blood' },
  { from: 'oxygen-transport', to: 'cardiac-cycle', label: 'The pump that moves it' },
  { from: 'reflex-arc', to: 'action-potential', label: 'The signal along a nerve' },
  { from: 'rendering-pipeline', to: 'event-loop', label: 'Why a busy script freezes a page' },
  { from: 'event-loop', to: 'rendering-pipeline', label: 'From text to pixels' },
  { from: 'hybrid-sorting', to: 'big-o-growth', label: 'How algorithms are compared' },
  { from: 'steam-power', to: 'factory-system', label: 'How factories changed the way goods were made' },
  { from: 'industrial-causes', to: 'industrial-debate', label: 'Why Europe pulled ahead' },
  { from: 'industrial-debate', to: 'industrial-causes', label: 'Why industrialisation began where it did' },
];
