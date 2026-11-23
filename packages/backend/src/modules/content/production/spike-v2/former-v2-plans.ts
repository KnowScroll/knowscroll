import type { ScrollTopic } from '../topics.js';
import type { ScrollV2Plan, StageKitId } from '../../domain/library/plan.js';

/**
 * What every library recipe but one was, as a `scroll-document.v2` recipe, before the library plan made it a document v3 recipe:
 * the v2 plan it had and, for the 22 recipes a drawing kit drew, the kit (#787, #790). The library plan holds neither, because a
 * v3 recipe has no kit and no v2 plan, and no job reads them from it. The v2 writer spike (`content writer-spike`), the v2 writer's
 * tests and the integration tests of the v2 path still run these recipes as v2 recipes, with their kit where they had one, until
 * the v2 code is deleted (Phase 6); the entries of a kit leave this table with it. The spike measures and publishes nothing, so a
 * recipe listed here is never produced as a v2 Scroll by the library. `exoplanet-kinds` was never a v2 recipe and is not listed.
 */
/** A recipe's former v2 plan, and the drawing kit that drew it when it had one (the 22 recipes of #787). */
export interface FormerV2Plan {
  readonly kit?: StageKitId;
  readonly plan: ScrollV2Plan;
}

export const FORMER_V2_PLANS = {
  seasons: {
    kit: 'earth-sky.v1',
    plan: {
      variant: 'stage',
      misconception: {
        kind: 'myth',
        claim: 'Earth has seasons because it is closer to the Sun in summer and farther away in winter.',
        source: { label: 'A Private Universe (1987 documentary)', reviewed: true },
      },
      landmark: { key: 'the-leaning-axis', name: 'The Leaning Axis' },
      finalCall: { kind: 'tilt' },
      // The recap of the journey needs Earth on its orbit at two months at least (D-368); the first call turns the picture to the true
      // one when the guess is wrong (D-383); the distances and the daylight are shown only where a cited passage states them (D-382).
      stagePlan: {
        orbitMonths: 2,
        figures: ['nearest', 'farthest', 'june-daylight', 'december-daylight'],
        reveal: true,
      },
    },
  },
  'seasons-hemispheres': {
    kit: 'earth-sky.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-turning-halves', name: 'The Turning Halves' },
    },
  },
  'seasons-limits': {
    kit: 'earth-sky.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-near-january', name: 'The Near January' },
    },
  },
  tides: {
    // The Moon's pull, the two bulges and spring and neap alignment are the subject, and the kit draws exactly
    // those. Coasts are left to the text and the limits aside.
    kit: 'tides.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-two-bulges', name: 'The Two Bulges' },
    },
  },
  'tides-spring-neap': {
    // Spring and neap are the Sun and Moon lining up or standing at right angles, which the kit derives from
    // the phase and draws as added or partly cancelled bulges and as bars for the four phases.
    kit: 'tides.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-added-pulls', name: 'The Added Pulls' },
    },
  },
  greenhouse: {
    // Sunlight in, infrared out, a layer that returns some and the ground warming until in and out match are
    // the subject; the kit draws them with one layer and makes no energy.
    kit: 'greenhouse.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-warm-layer', name: 'The Warm Layer' },
    },
  },
  'greenhouse-radiation': {
    // The radiation paths are what the kit draws: reflected sunlight, the ground's infrared, and the layer
    // sending some up and some back down. It does not say all sunlight passes through or all infrared is
    // blocked.
    kit: 'greenhouse.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-returning-glow', name: 'The Returning Glow' },
    },
  },
  'greenhouse-balance': {
    // Balance and imbalance are the energy-balance view: two bars, equal once settled and unequal just after
    // the layer thickens, with the ground warming until they match.
    kit: 'greenhouse.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-even-ledger', name: 'The Even Ledger' },
    },
  },
  'stars-fusion': {
    // Fusion in the core, gravity against pressure and how mass sets how long a star shines are the three
    // views the kit has.
    kit: 'star.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-steady-core', name: 'The Steady Core' },
    },
  },
  'stars-lifecycle': {
    // The stages of a low-mass star and of a high-mass star, in order and without years, are the life view;
    // code draws the end that fits the mass.
    kit: 'star.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-ageing-star', name: 'The Ageing Star' },
    },
  },
  'stars-colour-brightness': {
    // Colour from surface temperature, output from size and temperature together, dimming with distance and the
    // chart of temperature against output with its main sequence, giants and white dwarfs are the views the kit has.
    kit: 'starlight.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-colour-chart', name: 'The Colour Chart' },
    },
  },
  'exoplanet-transit': {
    // The transit method is the subject: a planet crossing its star and the dip it makes, small against large.
    // The wobble method is told in words only.
    kit: 'transit.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-small-dip', name: 'The Small Dip' },
    },
  },
  'exoplanet-habitable-zone': {
    // The zones of three stars of different output, and a planet's orbit across them, are the view the kit has.
    // It draws where liquid water could be possible and never that a planet has water or life.
    kit: 'starlight.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-temperate-band', name: 'The Temperate Band' },
    },
  },
  'black-hole-formation': {
    // A massive star's core collapsing when its fuel is gone, beside a star like the Sun that leaves a white dwarf,
    // is the formation view. Supermassive black holes are told in words only.
    kit: 'black-hole.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-collapsing-core', name: 'The Collapsing Core' },
    },
  },
  'black-hole-horizon': {
    // Two black holes to scale with their horizons, the light near an edge and the same pull from far away are the
    // horizon and pull views. Spaghettification is told in words only.
    kit: 'black-hole.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-one-way-edge', name: 'The One-Way Edge' },
    },
  },
  'black-hole-evidence': {
    // Stars orbiting an unseen mass, a glowing disc, the ripples of a merger and the shadow are the four clue views.
    kit: 'black-hole.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-unseen-weight', name: 'The Unseen Weight' },
    },
  },
  'cardiac-cycle': {
    // The beat in order (the atria, then the ventricles), the four valves opening and shutting with the pressure
    // behind them, and the right side serving the lungs and the left the body are what the kit draws (D-201).
    kit: 'circulation.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-beating-pump', name: 'The Beating Pump' },
    },
  },
  'blood-pressure': {
    // Pressure falling along the loop, the fall across a stretch as flow times resistance, and narrower or wider
    // arterioles are the pressure view, with relative pressures and no figure (D-201).
    kit: 'circulation.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-narrowing-pipe', name: 'The Narrowing Pipe' },
    },
  },
  'oxygen-transport': {
    // The S-shaped curve, haemoglobin loading in the lungs and giving some oxygen up in resting and in working
    // tissue, are the oxygen view; the effects of acidity and warmth are left out and the picture says so (D-201).
    kit: 'circulation.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-oxygen-handoff', name: 'The Oxygen Handoff' },
    },
  },
  'action-potential': {
    // Rest, threshold, rising, peak, falling and the undershoot, with the channels, the all-or-none rule and the
    // spike running one way along the axon are what the kit draws, from a model of the membrane (D-201).
    kit: 'nerve.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-racing-signal', name: 'The Racing Signal' },
    },
  },
  'synapse-signalling': {
    // The packets, the gap, the receptors and an exciting and an inhibiting connection are what the synapse view
    // draws; it names no chemical (D-201).
    kit: 'nerve.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-gap-crossing', name: 'The Gap Crossing' },
    },
  },
  'reflex-arc': {
    // Sensor, sensory neuron, spinal cord, motor neuron and muscle, with the news still on its way to the brain
    // when the muscle responds, are the reflex view (D-201).
    kit: 'nerve.v1',
    plan: {
      variant: 'stage',
      misconception: { kind: 'none' },
      landmark: { key: 'the-quick-loop', name: 'The Quick Loop' },
    },
  },
  'seasons-elsewhere': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sideways-giant', name: 'The Sideways Giant' },
    },
  },
  'tides-coasts': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sloshing-bay', name: 'The Sloshing Bay' },
    },
  },
  'greenhouse-limits': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-leaky-blanket', name: 'The Leaky Blanket' },
    },
  },
  'innate-immunity': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-first-guard', name: 'The First Guard' },
    },
  },
  'adaptive-immunity': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-tailored-defence', name: 'The Tailored Defence' },
    },
  },
  'immune-memory': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-remembered-foe', name: 'The Remembered Foe' },
    },
  },
  'dns-lookup': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-address-book', name: 'The Address Book' },
    },
  },
  'https-handshake': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-secret-handshake', name: 'The Secret Handshake' },
    },
  },
  'web-caching': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-saved-copy', name: 'The Saved Copy' },
    },
  },
  'rendering-pipeline': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-pixel-path', name: 'The Pixel Path' },
    },
  },
  'event-loop': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-patient-loop', name: 'The Patient Loop' },
    },
  },
  'same-origin-policy': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-wall-between-sites', name: 'The Wall Between Sites' },
    },
  },
  'big-o-growth': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-growth-curve', name: 'The Growth Curve' },
    },
  },
  'hybrid-sorting': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-sorted-runs', name: 'The Sorted Runs' },
    },
  },
  'hash-tables': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-labelled-shelf', name: 'The Labelled Shelf' },
    },
  },
  'industrial-causes': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-many-causes', name: 'The Many Causes' },
    },
  },
  'steam-power': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-steady-steam', name: 'The Steady Steam' },
    },
  },
  'factory-system': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-factory-floor', name: 'The Factory Floor' },
    },
  },
  'industrial-towns': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-crowded-towns', name: 'The Crowded Towns' },
    },
  },
  'industrial-debate': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-fork-in-the-road', name: 'The Fork in the Road' },
    },
  },
  'attention-mechanism': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-weighted-glance', name: 'The Weighted Glance' },
    },
  },
  'attention-example': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-aligned-words', name: 'The Aligned Words' },
    },
  },
  'attention-limits': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-edge-of-attention', name: 'The Edge of Attention' },
    },
  },
  'transformer-architecture': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-stacked-blocks', name: 'The Stacked Blocks' },
    },
  },
  'token-embeddings': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-word-map', name: 'The Word Map' },
    },
  },
  'next-token-generation': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-next-word', name: 'The Next Word' },
    },
  },
  'gradient-descent': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-downhill-walk', name: 'The Downhill Walk' },
    },
  },
  'training-by-example': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-example-trail', name: 'The Example Trail' },
    },
  },
  overfitting: {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-too-close-fit', name: 'The Too-Close Fit' },
    },
  },
  'long-input-cost': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-growing-bill', name: 'The Growing Bill' },
    },
  },
  'mixture-of-experts': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-specialist-team', name: 'The Specialist Team' },
    },
  },
  'subword-tokens': {
    plan: {
      variant: 'plain',
      misconception: { kind: 'none' },
      landmark: { key: 'the-word-pieces', name: 'The Word Pieces' },
    },
  },
} as const satisfies Readonly<Partial<Record<ScrollTopic, FormerV2Plan>>>;

/** The kit and v2 plan a recipe had before it became a document v3 recipe, or `undefined` for a recipe that was never a v2 recipe. */
export function formerV2PlanOf(topic: ScrollTopic): FormerV2Plan | undefined {
  return Object.hasOwn(FORMER_V2_PLANS, topic) ? FORMER_V2_PLANS[topic as keyof typeof FORMER_V2_PLANS] : undefined;
}
