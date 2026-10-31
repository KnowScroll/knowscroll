import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';

/**
 * The greenhouse kit (D-194): sunlight arriving, infrared leaving, and one layer of gas that absorbs
 * some infrared and sends it both ways. The writer chooses the view, how much the layer absorbs,
 * whether it has just been made thicker and the part to look at. Code derives the rest (D-195): how much
 * infrared the ground sends up, how much the layer returns, how much reaches space, whether the energy
 * in and out balance, and how warm the ground is. A stored state has no field in which energy could be
 * made or lost.
 *
 * It is the textbook one-layer model, and the picture says so: the layer lets sunlight through and
 * absorbs infrared, which the real atmosphere does only in part. The shares are illustrative.
 */
export const GREENHOUSE_KIT = 'greenhouse.v1';

export const GREENHOUSE_ENUMS = {
  /**
   * What the picture is of. `sunlight` draws what arrives and what is reflected; `infrared` the heat
   * radiation the ground and the layer send; `energy-balance` two bars, energy in and energy out, and
   * a thermometer for the ground.
   */
  view: ['sunlight', 'infrared', 'energy-balance'],
  /** How much infrared the layer of gas above the ground absorbs: none at all, some or most. */
  layer: ['none', 'thin', 'thick'],
  /**
   * `just-thickened`: the layer has just become one step thicker and the ground has not yet warmed, so
   * less energy leaves than the ground takes up. `settled`: the ground has warmed until the energy leaving
   * matches the energy the ground takes up. Drawn
   * only where there is a layer to thicken, in `infrared` and `energy-balance`.
   */
  change: ['settled', 'just-thickened'],
  /** The part the picture draws the eye to, if it is drawn. */
  focus: ['none', 'sun', 'reflected', 'surface', 'layer', 'to-space', 'back-down'],
} as const;

export type GreenhouseState = KitState<typeof GREENHOUSE_ENUMS>;
export type GreenhousePatch = KitPatch<typeof GREENHOUSE_ENUMS>;
export type GreenhouseView = GreenhouseState['view'];
export type GreenhouseLayer = GreenhouseState['layer'];

export const INITIAL_GREENHOUSE_STATE: GreenhouseState = {
  view: 'sunlight',
  layer: 'none',
  change: 'settled',
  focus: 'none',
};

export const GreenhouseStateSchema = kitStateSchema(GREENHOUSE_ENUMS);

/** The parts of the kit a picture may be made of. A focus names one of them. */
export type GreenhousePart = 'sun' | 'reflected' | 'surface' | 'layer' | 'to-space' | 'back-down' | 'balance';

/** What a view draws, which also depends on whether there is a layer. Anything else is never drawn, never described and never a focus. */
export function greenhouseParts(state: Pick<GreenhouseState, 'view' | 'layer'>): readonly GreenhousePart[] {
  const layered = state.layer !== 'none';
  switch (state.view) {
    case 'sunlight':
      return ['sun', 'reflected', 'surface', ...(layered ? (['layer'] as const) : [])];
    case 'infrared':
      return ['surface', 'to-space', ...(layered ? (['layer', 'back-down'] as const) : [])];
    case 'energy-balance':
      return ['sun', 'surface', 'to-space', 'balance', ...(layered ? (['layer'] as const) : [])];
  }
}

/**
 * The state a view can really show. `just-thickened` is set aside where the view cannot show it or no
 * layer exists to thicken, and a focus on a part that is not drawn is set aside. Idempotent.
 */
export function settleGreenhouseState(state: GreenhouseState): GreenhouseState {
  const parts = greenhouseParts(state);
  const canChange = state.view !== 'sunlight' && state.layer !== 'none';
  return {
    view: state.view,
    layer: state.layer,
    change: canChange ? state.change : 'settled',
    focus: state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none',
  };
}

/** The share of the sunlight that arrives which is reflected straight back to space: about 0.3. */
export const REFLECTED_SHARE = 0.3;

/** The share of the ground's infrared each layer absorbs, in the order of `GREENHOUSE_ENUMS.layer`. Illustrative, not the real atmosphere. */
export const LAYER_ABSORPTION: Readonly<Record<GreenhouseLayer, number>> = { none: 0, thin: 0.4, thick: 0.8 };

/** The layer one step thinner, which a layer that has just thickened was before. */
const THINNER: Readonly<Record<GreenhouseLayer, GreenhouseLayer>> = { none: 'none', thin: 'none', thick: 'thin' };

/** Energy flows, in units of the sunlight that arrives (1.0). Derived by `greenhousePhysics`; never stored. */
export interface GreenhousePhysics {
  /** Sunlight reflected straight back to space. */
  readonly reflected: number;
  /** Sunlight the ground takes up. */
  readonly absorbed: number;
  /** Infrared the ground sends up. */
  readonly surfaceEmission: number;
  /** Infrared the ground sends up that passes the layer straight to space. */
  readonly passesThrough: number;
  /** Infrared the layer sends up, and the same amount it sends back down to the ground. */
  readonly layerUp: number;
  readonly backDown: number;
  /** All infrared that reaches space: what passes through plus what the layer sends up. */
  readonly toSpace: number;
  /** Energy in minus energy out: nil once settled, positive while the ground is still warming. */
  readonly imbalance: number;
  /** How warm the ground is, from 0 (no layer) to 1 (the thickest layer, settled). Temperature goes as the fourth root of the energy the ground sends up. */
  readonly warmth: number;
}

const TOLERANCE = 1e-9;

/** The ground's infrared emission when a layer that absorbs `share` has let it settle: the energy balance of the ground and the layer. */
function settledEmission(absorbed: number, share: number): number {
  return absorbed / (1 - share / 2);
}

/**
 * The one-layer energy balance. The layer absorbs a share of the ground's infrared and sends out as
 * much as it absorbs, half up and half down. Settled, the ground sends up `absorbed / (1 - share / 2)`
 * (more than it takes up), and exactly as much infrared leaves to space as the sunlight the ground takes
 * up (the share reflected at once never reaches the ground). Just after the layer thickens the ground has
 * not warmed, so it still sends up what it sent before, and less leaves than the ground takes up.
 */
export function greenhousePhysics(state: Pick<GreenhouseState, 'layer' | 'change'>): GreenhousePhysics {
  const absorbed = 1 - REFLECTED_SHARE;
  const share = LAYER_ABSORPTION[state.layer];
  const justThickened = state.change === 'just-thickened' && state.layer !== 'none';
  const surfaceEmission = settledEmission(
    absorbed,
    LAYER_ABSORPTION[justThickened ? THINNER[state.layer] : state.layer],
  );
  const layerUp = (share * surfaceEmission) / 2;
  const passesThrough = (1 - share) * surfaceEmission;
  const toSpace = passesThrough + layerUp;
  const coolest = settledEmission(absorbed, LAYER_ABSORPTION.none);
  const warmest = settledEmission(absorbed, LAYER_ABSORPTION.thick);
  return {
    reflected: REFLECTED_SHARE,
    absorbed,
    surfaceEmission,
    passesThrough,
    layerUp,
    backDown: layerUp,
    toSpace,
    imbalance: absorbed - toSpace,
    warmth: (surfaceEmission ** 0.25 - coolest ** 0.25) / (warmest ** 0.25 - coolest ** 0.25),
  };
}

const LAYER_WORDS: Readonly<Record<Exclude<GreenhouseLayer, 'none'>, string>> = {
  thin: 'thin layer that absorbs some of the infrared',
  thick: 'thick layer that absorbs most of the infrared',
};

const compare = (more: number, than: number): 'more' | 'less' | 'the same' =>
  Math.abs(more - than) < TOLERANCE ? 'the same' : more > than ? 'more' : 'less';

function sunlightSentences(state: GreenhouseState): string[] {
  return [
    'Sunlight arrives from the Sun at the top. A share of it is reflected straight back to space. The rest is taken up by the ground, which warms.',
    state.layer === 'none'
      ? 'There is no layer of gas above the ground.'
      : `Above the ground lies a ${LAYER_WORDS[state.layer]}. In this simple picture it lets sunlight through; the real atmosphere absorbs a little of it too.`,
  ];
}

function infraredSentences(state: GreenhouseState, physics: GreenhousePhysics): string[] {
  const upward = compare(physics.surfaceEmission, physics.absorbed);
  if (state.layer === 'none')
    return [
      'The warm ground sends infrared (heat radiation) upward.',
      'With no layer above it all of that infrared goes out to space, as much as the sunlight the ground takes up.',
    ];
  const outcome =
    state.change === 'just-thickened'
      ? `The layer has just become thicker and the ground has not yet warmed, so for now ${compare(physics.toSpace, physics.absorbed)} infrared reaches space than the sunlight the ground takes up.`
      : `Settled, the ground sends up ${upward} infrared than the sunlight it takes up, yet as much infrared leaves to space as the sunlight the ground takes up: the layer makes no energy, it sends part of it back.`;
  return [
    'The warm ground sends infrared (heat radiation) upward.',
    `Above it lies a ${LAYER_WORDS[state.layer]}. The layer sends out infrared of its own, half up to space and half back down to the ground. The rest of the ground’s infrared passes straight through.`,
    outcome,
  ];
}

function balanceSentences(state: GreenhouseState, physics: GreenhousePhysics): string[] {
  const bars =
    Math.abs(physics.imbalance) < TOLERANCE
      ? 'The two bars are equal: as much infrared leaves to space as the ground takes up from the Sun, so nothing is gained or lost.'
      : 'The bar for energy leaving is shorter than the one for energy taken up: for now the ground takes up more than leaves, so it warms until the two bars match.';
  const warmth =
    physics.warmth < TOLERANCE
      ? 'The thermometer shows the ground as warm as it is with no layer at all.'
      : state.change === 'just-thickened'
        ? 'The thermometer shows the ground as warm as it was before the layer thickened.'
        : 'The thermometer shows the ground warmer than it would be with no layer at all.';
  return [
    state.layer === 'none'
      ? 'There is no layer of gas above the ground.'
      : `Above the ground lies a ${LAYER_WORDS[state.layer]}.${state.change === 'just-thickened' ? ' The layer has just become thicker.' : ''}`,
    'Two bars compare the energy the ground takes up from the Sun with the energy leaving to space, and a thermometer shows its warmth.',
    bars,
    warmth,
  ];
}

const FOCUS_SENTENCE: Readonly<Record<GreenhouseState['focus'], string>> = {
  none: '',
  sun: 'The picture draws the eye to the sunlight.',
  reflected: 'The picture draws the eye to the reflected sunlight.',
  surface: 'The picture draws the eye to the ground.',
  layer: 'The picture draws the eye to the layer.',
  'to-space': 'The picture draws the eye to the energy that leaves to space.',
  'back-down': 'The picture draws the eye to the infrared sent back down.',
};

/**
 * What a greenhouse state shows, as sentences: the text version of a stage and its accessible name.
 * It is derived by code from the state and the energy flows of `greenhousePhysics`, never written by
 * the model, and it settles the state first, so it mentions only what the view draws and cannot
 * disagree with the picture or state energy that is made from nothing.
 */
export function describeGreenhouseState(chosen: GreenhouseState): string {
  const state = settleGreenhouseState(chosen);
  const physics = greenhousePhysics(state);
  const sentences =
    state.view === 'sunlight'
      ? sunlightSentences(state)
      : state.view === 'infrared'
        ? infraredSentences(state, physics)
        : balanceSentences(state, physics);
  return [
    ...sentences,
    'This is a simple picture with one layer, not the real atmosphere.',
    FOCUS_SENTENCE[state.focus],
  ]
    .filter((sentence) => sentence !== '')
    .join(' ');
}

export const GREENHOUSE_KIT_DEFINITION = defineKit({
  id: GREENHOUSE_KIT,
  enums: GREENHOUSE_ENUMS,
  initial: INITIAL_GREENHOUSE_STATE,
  settle: settleGreenhouseState,
  describe: describeGreenhouseState,
  writerGuide: [
    'Code draws the picture from a fixed kit: the Sun, sunlight and reflected sunlight, the ground, one layer of gas above it, the infrared the ground and the layer send out, and two bars and a thermometer for the energy. You choose only the view, how much the layer absorbs, whether it has just been made thicker and the part to look at, from the listed words. Code decides everything else: how much infrared the ground sends up, how much the layer sends back down, how much reaches space, whether energy in and out balance, and how warm the ground is. So the layer you choose is a claim the picture makes: choose the one that matches what the stop says.',
    '- The views: "sunlight" shows sunlight arriving, a share reflected and the rest taken up by the ground; "infrared" shows the infrared the ground sends up, the layer absorbing part of it and sending some up and some back down, and the rest passing through; "energy-balance" shows two bars (energy the ground takes up, energy leaving to space) and a thermometer. The layer is "none", "thin" (absorbs some infrared) or "thick" (absorbs most). "change" is "settled" or "just-thickened": just after the layer thickens, less energy leaves than the ground takes up until the ground warms; it needs a layer and the "infrared" or "energy-balance" view, and is otherwise ignored.',
    '- The picture is a simple one-layer model. In it the layer lets sunlight through; it is never a lid or a solid blanket, and energy is never made. Never ask the picture to show a temperature number, a forecast or a glasshouse.',
  ],
});
