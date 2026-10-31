import { defineKit, kitStateSchema, type KitPatch, type KitState } from './definition.js';

/**
 * The circulation kit (D-201): the four-chambered heart with its valves, the two circuits, the fall of
 * pressure along the vessels, and the hand-off of oxygen. The writer chooses the view, the point of the
 * heartbeat, how much the blood flows and how wide the small arteries are, where the blood is, and the part
 * to look at. Code derives the rest (D-202): which valves are open from the pressures on either side of them,
 * how full the ventricles are, how much pressure each stretch of the loop uses up, and how much of its oxygen
 * the blood gives up. A stored state has no field in which a valve could open against the pressure.
 *
 * Every pressure is relative and no figure is ever shown. The pictures are simple and not to scale, and the
 * colours of the two kinds of blood are a drawing convention (blood is red either way).
 */
export const CIRCULATION_KIT = 'circulation.v1';

export const CIRCULATION_ENUMS = {
  /**
   * What the picture is of. `heart` is the heart cut open at one point of the beat; `circuits` is the loop
   * through the lungs and the loop through the body; `pressure` is the average pressure along the loop through
   * the body; `oxygen` is the curve of how much oxygen haemoglobin holds.
   */
  view: ['heart', 'circuits', 'pressure', 'oxygen'],
  /** In `heart`: the point of the beat, in order. After `relaxing` the beat starts again at `filling`. */
  phase: ['filling', 'atria-squeeze', 'ventricles-tense', 'ejection', 'relaxing'],
  /** In `pressure`: how much blood flows round the loop, against the usual. */
  flow: ['usual', 'more', 'less'],
  /** In `pressure`: how wide the small arteries (arterioles) are, against the usual. */
  vessels: ['usual', 'narrowed', 'widened'],
  /** In `oxygen`: where the blood is. In the lungs the haemoglobin loads; in tissue it gives some up. */
  where: ['lungs', 'resting-tissue', 'active-tissue'],
  /** The part the picture draws the eye to, if the view draws it. */
  focus: [
    'none',
    'atria',
    'ventricles',
    'valves',
    'right-side',
    'left-side',
    'lungs',
    'body',
    'arteries',
    'arterioles',
    'capillaries',
    'veins',
    'curve',
    'handoff',
  ],
} as const;

export type CirculationState = KitState<typeof CIRCULATION_ENUMS>;
export type CirculationPatch = KitPatch<typeof CIRCULATION_ENUMS>;
export type CirculationView = CirculationState['view'];
export type HeartPhase = CirculationState['phase'];
export type BloodFlow = CirculationState['flow'];
export type VesselWidth = CirculationState['vessels'];
export type BloodPlace = CirculationState['where'];

export const INITIAL_CIRCULATION_STATE: CirculationState = {
  view: 'heart',
  phase: 'filling',
  flow: 'usual',
  vessels: 'usual',
  where: 'lungs',
  focus: 'none',
};

export const CirculationStateSchema = kitStateSchema(CIRCULATION_ENUMS);

/** The parts of the kit a picture may be made of. A focus names one of them. */
export type CirculationPart = Exclude<CirculationState['focus'], 'none'>;

/** What a state draws. A focus on anything else is set aside. */
export function circulationParts(state: Pick<CirculationState, 'view' | 'where'>): readonly CirculationPart[] {
  switch (state.view) {
    case 'heart':
      return ['atria', 'ventricles', 'valves'];
    case 'circuits':
      return ['right-side', 'left-side', 'lungs', 'body'];
    case 'pressure':
      return ['arteries', 'arterioles', 'capillaries', 'veins'];
    case 'oxygen':
      return state.where === 'lungs' ? ['curve'] : ['curve', 'handoff'];
  }
}

/** The values a picture shows when a key does not matter to the view, so unseen differences are not counted as change. */
const NEUTRAL = { phase: 'filling', flow: 'usual', vessels: 'usual', where: 'lungs' } as const;

/** The state a view can really show: a key the view does not use is set aside, and so is a focus on a part that is not drawn. Idempotent. */
export function settleCirculationState(state: CirculationState): CirculationState {
  const where = state.view === 'oxygen' ? state.where : NEUTRAL.where;
  const parts = circulationParts({ view: state.view, where });
  return {
    view: state.view,
    phase: state.view === 'heart' ? state.phase : NEUTRAL.phase,
    flow: state.view === 'pressure' ? state.flow : NEUTRAL.flow,
    vessels: state.view === 'pressure' ? state.vessels : NEUTRAL.vessels,
    where,
    focus: state.focus === 'none' || parts.includes(state.focus) ? state.focus : 'none',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The heartbeat: pressures decide the valves.

/**
 * Relative pressures in the left atrium, the left ventricle and the aorta at each point of the beat, in units
 * of the aorta's highest. The right side runs lower and in step, with the same order of events, so the one set
 * serves both; the picture shows the left side's. They are the shape of the textbook (Wiggers) diagram and are never drawn as figures.
 */
export const HEART_PRESSURES: Readonly<Record<HeartPhase, { atrium: number; ventricle: number; artery: number }>> = {
  filling: { atrium: 0.2, ventricle: 0.1, artery: 0.65 },
  'atria-squeeze': { atrium: 0.3, ventricle: 0.15, artery: 0.65 },
  'ventricles-tense': { atrium: 0.2, ventricle: 0.5, artery: 0.65 },
  ejection: { atrium: 0.2, ventricle: 1, artery: 0.95 },
  relaxing: { atrium: 0.3, ventricle: 0.4, artery: 0.7 },
};

/**
 * How full the ventricles are in the picture, as a share of their fullest. Only the order matters and it is
 * physiology: they fill, are topped up by the atria, stay as full while they tense (no blood has left), empty
 * partly while the blood is pushed out, and stay at their emptiest while they relax with every valve shut.
 */
export const VENTRICLE_FILL: Readonly<Record<HeartPhase, number>> = {
  filling: 0.7,
  'atria-squeeze': 1,
  'ventricles-tense': 1,
  ejection: 0.7,
  relaxing: 0.4,
};

const ATRIA_SQUEEZING: Readonly<Record<HeartPhase, boolean>> = {
  filling: false,
  'atria-squeeze': true,
  'ventricles-tense': false,
  ejection: false,
  relaxing: false,
};

const VENTRICLES_SQUEEZING: Readonly<Record<HeartPhase, boolean>> = {
  filling: false,
  'atria-squeeze': false,
  'ventricles-tense': true,
  ejection: true,
  relaxing: false,
};

/** A valve is passive: it is open when the pressure behind it is above the pressure ahead of it, and shut otherwise. */
export function valveIsOpen(pressureBehind: number, pressureAhead: number): boolean {
  return pressureBehind > pressureAhead;
}

export interface HeartPhysics {
  readonly atriumPressure: number;
  readonly ventriclePressure: number;
  readonly arteryPressure: number;
  /** The valves between the atria and the ventricles (mitral and tricuspid). */
  readonly atrioventricularOpen: boolean;
  /** The valves between the ventricles and the arteries (aortic and pulmonary). */
  readonly semilunarOpen: boolean;
  readonly atriaSqueezing: boolean;
  readonly ventriclesSqueezing: boolean;
  readonly ventricleFill: number;
}

/** What follows from a point of the beat by physics. Derived, never stored and never written by the model. */
export function heartPhysics(phase: HeartPhase): HeartPhysics {
  const { atrium, ventricle, artery } = HEART_PRESSURES[phase];
  return {
    atriumPressure: atrium,
    ventriclePressure: ventricle,
    arteryPressure: artery,
    atrioventricularOpen: valveIsOpen(atrium, ventricle),
    semilunarOpen: valveIsOpen(ventricle, artery),
    atriaSqueezing: ATRIA_SQUEEZING[phase],
    ventriclesSqueezing: VENTRICLES_SQUEEZING[phase],
    ventricleFill: VENTRICLE_FILL[phase],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The loop through the body: pressure uses itself up along the vessels.

/** The stretches of the loop through the body, in the order the blood meets them. */
export const LOOP_STRETCHES = ['arteries', 'arterioles', 'capillaries', 'veins'] as const;
export type LoopStretch = (typeof LOOP_STRETCHES)[number];

/**
 * Each stretch's share of the whole loop's resistance when the vessels are as usual. They add up to 1. The small
 * arteries (arterioles) hold the largest share, and the capillaries, a vast number in parallel, the next. They are
 * round illustrative shares in the shape of the textbook, never drawn as figures.
 */
export const USUAL_RESISTANCE_SHARE: Readonly<Record<LoopStretch, number>> = {
  arteries: 0.1,
  arterioles: 0.5,
  capillaries: 0.25,
  veins: 0.15,
};

/** The arterioles' width against the usual. */
export const ARTERIOLE_RADIUS: Readonly<Record<VesselWidth, number>> = { usual: 1, narrowed: 0.8, widened: 1.25 };

/** The blood flowing round the loop against the usual. */
export const RELATIVE_FLOW: Readonly<Record<BloodFlow, number>> = { usual: 1, more: 1.5, less: 0.5 };

/**
 * The resistance of a tube goes as one over its radius to the fourth power (Poiseuille): the arterioles at four
 * fifths of their width resist about two and a half times as much. This is the simple model of steady flow in a
 * rigid tube; real vessels are elastic and blood is not a simple fluid, so the picture says it is simple.
 */
export function resistanceFactor(radius: number): number {
  return radius ** -4;
}

export interface LoopPhysics {
  /** Each stretch's resistance, in units of the whole loop's resistance when the vessels are as usual. */
  readonly resistance: Readonly<Record<LoopStretch, number>>;
  /** The pressure used up across each stretch: the flow times its resistance. */
  readonly drop: Readonly<Record<LoopStretch, number>>;
  /** The average pressure where each stretch starts, in the same units, and the pressure at the end of the veins (0). */
  readonly pressureAtStart: Readonly<Record<LoopStretch, number>>;
  readonly pressureAtEnd: number;
  readonly totalResistance: number;
  /** The stretch across which the most pressure is used up. */
  readonly biggestDrop: LoopStretch;
}

/**
 * What follows from the flow and the width of the arterioles by physics: the pressure across a stretch is the flow
 * times its resistance (the fluid form of Ohm's law), the stretches are in series, and the pressure at the end of
 * the veins, where the blood returns to the heart, is taken as 0. Narrowing the arterioles raises the pressure
 * before them and leaves the pressure after them as it was, for the same flow.
 */
export function loopPhysics(state: Pick<CirculationState, 'flow' | 'vessels'>): LoopPhysics {
  const flow = RELATIVE_FLOW[state.flow];
  const resistance = {
    arteries: USUAL_RESISTANCE_SHARE.arteries,
    arterioles: USUAL_RESISTANCE_SHARE.arterioles * resistanceFactor(ARTERIOLE_RADIUS[state.vessels]),
    capillaries: USUAL_RESISTANCE_SHARE.capillaries,
    veins: USUAL_RESISTANCE_SHARE.veins,
  };
  const drop = Object.fromEntries(LOOP_STRETCHES.map((stretch) => [stretch, flow * resistance[stretch]])) as Record<
    LoopStretch,
    number
  >;
  const pressureAtStart = {} as Record<LoopStretch, number>;
  let pressure = 0;
  for (const stretch of [...LOOP_STRETCHES].reverse()) {
    pressure += drop[stretch];
    pressureAtStart[stretch] = pressure;
  }
  const biggestDrop = LOOP_STRETCHES.reduce((most, stretch) => (drop[stretch] > drop[most] ? stretch : most));
  return {
    resistance,
    drop,
    pressureAtStart,
    pressureAtEnd: 0,
    totalResistance: LOOP_STRETCHES.reduce((sum, stretch) => sum + resistance[stretch], 0),
    biggestDrop,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Oxygen: haemoglobin loads where oxygen is plentiful and unloads where it is scarce.

/**
 * The oxygen pressure of each place, in mmHg: the air sacs of the lungs, resting tissue and working muscle. The
 * figures are the textbook's typical ones and are used only to place a point on the curve, never drawn.
 */
export const OXYGEN_PRESSURE: Readonly<Record<BloodPlace, number>> = {
  lungs: 100,
  'resting-tissue': 40,
  'active-tissue': 20,
};

/** The Hill equation's constants for adult haemoglobin: half loaded at 26.8 mmHg, with a steepness of about 2.7. */
export const HALF_LOADED_PRESSURE = 26.8;
export const HILL_STEEPNESS = 2.7;

/**
 * The share of haemoglobin carrying oxygen at an oxygen pressure (the Hill equation). The S shape comes from
 * haemoglobin's four binding sites helping one another: once one oxygen is on, the next binds more readily. Real
 * blood shifts this curve with acidity, carbon dioxide and warmth, which the picture leaves out.
 */
export function haemoglobinSaturation(oxygenPressure: number): number {
  if (oxygenPressure <= 0) return 0;
  const steep = oxygenPressure ** HILL_STEEPNESS;
  return steep / (HALF_LOADED_PRESSURE ** HILL_STEEPNESS + steep);
}

export interface OxygenPhysics {
  readonly oxygenPressure: number;
  /** The share of haemoglobin loaded here, and as the blood leaves the lungs. */
  readonly saturation: number;
  readonly loadedInLungs: number;
  /** What the blood has given up on the way from the lungs to here, as a share of the whole, and as a share of what it carried. */
  readonly released: number;
  readonly releasedShareOfLoad: number;
}

/** What follows from the place by physics. */
export function oxygenPhysics(place: BloodPlace): OxygenPhysics {
  const oxygenPressure = OXYGEN_PRESSURE[place];
  const saturation = haemoglobinSaturation(oxygenPressure);
  const loadedInLungs = haemoglobinSaturation(OXYGEN_PRESSURE.lungs);
  const released = loadedInLungs - saturation;
  return { oxygenPressure, saturation, loadedInLungs, released, releasedShareOfLoad: released / loadedInLungs };
}

// ---------------------------------------------------------------------------------------------------------------
// The text version of each state.

const FOCUS_SENTENCE: Readonly<Record<CirculationState['focus'], string>> = {
  none: '',
  atria: 'The picture draws the eye to the atria.',
  ventricles: 'The picture draws the eye to the ventricles.',
  valves: 'The picture draws the eye to the valves.',
  'right-side': 'The picture draws the eye to the right side of the heart.',
  'left-side': 'The picture draws the eye to the left side of the heart.',
  lungs: 'The picture draws the eye to the lungs.',
  body: 'The picture draws the eye to the rest of the body.',
  arteries: 'The picture draws the eye to the arteries.',
  arterioles: 'The picture draws the eye to the arterioles.',
  capillaries: 'The picture draws the eye to the capillaries.',
  veins: 'The picture draws the eye to the veins.',
  curve: 'The picture draws the eye to the curve.',
  handoff: 'The picture draws the eye to the oxygen handed over.',
};

/** What every view that colours blood says of the colours; the picture carries the same words (`COLOUR_KEY`). */
export const COLOUR_CONVENTION =
  'Red and blue mark blood rich and poor in oxygen, a drawing convention: blood is red either way.';

function heartSentences(phase: HeartPhase): string[] {
  const physics = heartPhysics(phase);
  const chambers = [
    physics.atriaSqueezing ? 'The two atria squeeze.' : 'The atria are relaxed and filling.',
    physics.ventriclesSqueezing ? 'The two ventricles squeeze.' : 'The ventricles are relaxed.',
  ].join(' ');
  const valves = `The valves between atria and ventricles are ${physics.atrioventricularOpen ? 'open' : 'shut'}; those to the arteries are ${physics.semilunarOpen ? 'open' : 'shut'}.`;
  const blood = physics.semilunarOpen
    ? 'Blood is pushed out, to the lungs and to the body.'
    : physics.atrioventricularOpen
      ? 'Blood flows from the atria into the ventricles.'
      : 'No blood enters or leaves the ventricles.';
  return [
    'The heart’s four chambers and four valves, with bars for the pressure in the left atrium, the left ventricle and the aorta. A valve is open when the pressure behind it is above that ahead. The low pressures are drawn larger so the valves can be compared.',
    chambers,
    valves,
    blood,
    COLOUR_CONVENTION,
  ];
}

function circuitSentences(): string[] {
  return [
    'Two loops meet at the heart. The right side sends blood to the lungs, where it picks up oxygen, and it returns to the left side. The left side sends it to the rest of the body, where it gives up oxygen, and it returns to the right side.',
    COLOUR_CONVENTION,
  ];
}

const PRESSURE_WORD: Readonly<Record<LoopStretch, string>> = {
  arteries: 'the large arteries',
  arterioles: 'the arterioles',
  capillaries: 'the capillaries',
  veins: 'the veins',
};

function pressureSentences(state: CirculationState): string[] {
  const physics = loopPhysics(state);
  const flow: Readonly<Record<BloodFlow, string>> = {
    usual: '',
    more: 'More blood flows, so every stretch uses up more pressure.',
    less: 'Less blood flows, so every stretch uses up less pressure.',
  };
  const vessels: Readonly<Record<VesselWidth, string>> = {
    usual: '',
    narrowed: 'The arterioles are narrowed and resist more, so the pressure before them is higher.',
    widened: 'The arterioles are widened and resist less, so the pressure before them is lower.',
  };
  return [
    'A graph of the average pressure along the loop through the body: from the large arteries to the veins. It falls all the way, as each stretch uses some of it.',
    `The biggest fall is across ${PRESSURE_WORD[physics.biggestDrop]}: the fall across a stretch is the flow times its resistance. Pressures are relative; the pulse is left out.`,
    flow[state.flow],
    vessels[state.vessels],
    COLOUR_CONVENTION,
  ];
}

function loadWords(share: number): string {
  if (share >= 0.5) return 'most of its load';
  if (share >= 0.35) return 'about half of its load';
  return 'a small share of its load';
}

function oxygenSentences(place: BloodPlace): string[] {
  const physics = oxygenPhysics(place);
  const where: Readonly<Record<BloodPlace, string>> = {
    lungs: 'In the lungs oxygen is plentiful, so nearly all of the haemoglobin is loaded.',
    'resting-tissue': `In resting tissue oxygen is scarcer, so the blood gives up ${loadWords(physics.releasedShareOfLoad)} and the rest stays on the haemoglobin.`,
    'active-tissue': `In working tissue oxygen is much scarcer, so the blood gives up ${loadWords(physics.releasedShareOfLoad)}, though some stays on the haemoglobin.`,
  };
  return [
    'A curve of how much of the haemoglobin in red blood cells carries oxygen, against how much oxygen is around. It is S-shaped, because each haemoglobin holds up to four oxygen molecules and the first makes the next easier to bind. Acidity and warmth, which shift it, are left out.',
    where[place],
    COLOUR_CONVENTION,
  ];
}

/**
 * What a circulation state shows, as sentences: the text version of a stage and its accessible name. It is
 * derived by code from the state and its physics, never written by the model, and it settles the state first,
 * so it mentions only what the view draws and cannot disagree with the picture. It gives no figure.
 */
export function describeCirculationState(chosen: CirculationState): string {
  const state = settleCirculationState(chosen);
  const sentences =
    state.view === 'heart'
      ? heartSentences(state.phase)
      : state.view === 'circuits'
        ? circuitSentences()
        : state.view === 'pressure'
          ? pressureSentences(state)
          : oxygenSentences(state.where);
  return [...sentences, FOCUS_SENTENCE[state.focus]].filter((sentence) => sentence !== '').join(' ');
}

export const CIRCULATION_KIT_DEFINITION = defineKit({
  id: CIRCULATION_KIT,
  enums: CIRCULATION_ENUMS,
  initial: INITIAL_CIRCULATION_STATE,
  settle: settleCirculationState,
  describe: describeCirculationState,
  writerGuide: [
    'Code draws the picture from a fixed kit: the heart with its four chambers and four valves, the two loops of blood (through the lungs and through the body), a graph of the pressure along the loop through the body, and the curve of how much oxygen haemoglobin holds. You choose only the view, the point of the heartbeat, the flow, the width of the arterioles, where the blood is and the part to look at, from the listed words. Code decides everything else: which valves are open (a valve opens when the pressure behind it is higher than ahead of it), how full the ventricles are, how much pressure each stretch uses up and how much oxygen the blood gives up. So the point of the beat and the other words you choose are claims the picture makes: choose the ones that match what the stop says.',
    '- The views: "heart" shows the heart cut open at one point of the beat, "phase", in order: "filling" (everything relaxed, blood flowing into the ventricles), "atria-squeeze", "ventricles-tense" (the ventricles squeeze with every valve shut, so no blood leaves yet), "ejection" (blood pushed out) and "relaxing" (every valve shut again as the ventricles relax); the beat then starts again at "filling". The two atria squeeze together and then the two ventricles together, never all four at once. "circuits" shows the loop through the lungs and the loop through the body, with the right side serving the lungs and the left side the body. "pressure" shows the average pressure along the loop through the body, falling from the arteries through the arterioles and capillaries to the veins; "flow" is "usual", "more" or "less", and "vessels" is "usual", "narrowed" or "widened" for the arterioles. "oxygen" shows the S-shaped curve; "where" is "lungs", "resting-tissue" or "active-tissue", and the curve shows the blood loading in the lungs and, in tissue, giving some oxygen up, more where oxygen is scarcer. A key a view does not use is ignored.',
    '- The picture draws no heart rate, no blood pressure figure, no disease and no medical advice, so say nothing that depends on one. Pressures are relative and the pulse is left out; the vessels follow a simple model, not a real person. Blood is drawn red and blue by convention: never say that blood is blue.',
  ],
});
