import { EARTH_SKY_KIT, EARTH_SKY_KIT_DEFINITION } from '../kit.js';
import { CIRCULATION_KIT, CIRCULATION_KIT_DEFINITION } from './circulation.js';
import { BLACK_HOLE_KIT, BLACK_HOLE_KIT_DEFINITION } from './black-hole.js';
import { type KitDefinition } from './definition.js';
import { GREENHOUSE_KIT, GREENHOUSE_KIT_DEFINITION } from './greenhouse.js';
import { NERVE_KIT, NERVE_KIT_DEFINITION } from './nerve.js';
import { STARLIGHT_KIT, STARLIGHT_KIT_DEFINITION } from './starlight.js';

/**
 * Every drawing kit a Scroll's stage can use (D-194). A stage names one kit and every state of that
 * stage holds that kit's words and no others. A recipe names the kit that draws its subject (the library
 * plan's `stageKit`), and a test keeps the plan's list and this one the same. Adding a kit is a new id,
 * its own words and physics, and a new decision.
 */
export const STAGE_KIT_IDS = [
  EARTH_SKY_KIT,
  GREENHOUSE_KIT,
  CIRCULATION_KIT,
  NERVE_KIT,
  STARLIGHT_KIT,
  BLACK_HOLE_KIT,
] as const;
export type StageKitId = (typeof STAGE_KIT_IDS)[number];

/** Whether `id` names a kit the code still defines. A stored stage may name one it no longer does (a legacy stage). */
export function isStageKitId(id: string): id is StageKitId {
  return (STAGE_KIT_IDS as readonly string[]).includes(id);
}

const KITS: Readonly<Record<StageKitId, KitDefinition>> = {
  [EARTH_SKY_KIT]: EARTH_SKY_KIT_DEFINITION,
  [GREENHOUSE_KIT]: GREENHOUSE_KIT_DEFINITION,
  [CIRCULATION_KIT]: CIRCULATION_KIT_DEFINITION,
  [NERVE_KIT]: NERVE_KIT_DEFINITION,
  [STARLIGHT_KIT]: STARLIGHT_KIT_DEFINITION,
  [BLACK_HOLE_KIT]: BLACK_HOLE_KIT_DEFINITION,
};

/**
 * The generic definition of a kit: its words, its first state, how it settles and describes a state. It throws for a
 * kit the code does not define, so nothing is made of a kit that is gone; code that meets a stored stage checks
 * `isStageKitId` first.
 */
export function kitDefinition(id: StageKitId): KitDefinition {
  if (!isStageKitId(id)) throw new Error(`Unknown stage kit "${String(id)}".`);
  return KITS[id];
}

export {
  applyKitPatch,
  isKitPatch,
  kitKeys,
  kitStateSchema,
  type KitDefinition,
  type KitEnums,
  type KitPatch,
  type KitState,
  type WordState,
} from './definition.js';
export {
  ARTERIOLE_RADIUS,
  circulationParts,
  CIRCULATION_ENUMS,
  CIRCULATION_KIT,
  CirculationStateSchema,
  describeCirculationState,
  haemoglobinSaturation,
  heartPhysics,
  HEART_PRESSURES,
  INITIAL_CIRCULATION_STATE,
  loopPhysics,
  LOOP_STRETCHES,
  OXYGEN_PRESSURE,
  oxygenPhysics,
  RELATIVE_FLOW,
  settleCirculationState,
  type BloodFlow,
  type BloodPlace,
  type CirculationPart,
  type CirculationPatch,
  type CirculationState,
  type CirculationView,
  type HeartPhase,
  type HeartPhysics,
  type LoopPhysics,
  type LoopStretch,
  type OxygenPhysics,
  type VesselWidth,
} from './circulation.js';
export { TRACE_STEP } from './membrane.js';
export {
  describeGreenhouseState,
  GREENHOUSE_ENUMS,
  GREENHOUSE_KIT,
  greenhouseParts,
  greenhousePhysics,
  GreenhouseStateSchema,
  INITIAL_GREENHOUSE_STATE,
  LAYER_ABSORPTION,
  REFLECTED_SHARE,
  settleGreenhouseState,
  type GreenhouseLayer,
  type GreenhousePart,
  type GreenhousePatch,
  type GreenhousePhysics,
  type GreenhouseState,
  type GreenhouseView,
} from './greenhouse.js';
export {
  actionPotential,
  arcPhysics,
  ARC_LINKS,
  axonProfile,
  AXON_PEAK_AT,
  AXON_PROFILE_SAMPLES,
  describeNerveState,
  INITIAL_NERVE_STATE,
  NERVE_ENUMS,
  NERVE_KIT,
  nerveParts,
  NerveStateSchema,
  PUSH_RESPONSE_DURATION_MS,
  postsynapticCourse,
  pushResponses,
  settleNerveState,
  SPIKE_DURATION_MS,
  spikePhysics,
  SYNAPSE_TIME_IN_CONSTANTS,
  synapsePhysics,
  type ArcPhysics,
  type ArcStep,
  type AxonPlace,
  type AxonProfile,
  type ChannelsPhysics,
  type NervePart,
  type NervePatch,
  type NerveState,
  type NerveView,
  type PushResponse,
  type SpikePhase,
  type SpikePhysics,
  type SynapseEffect,
  type SynapsePhysics,
  type SynapseStep,
} from './nerve.js';
export {
  BLACK_HOLE_ENUMS,
  BLACK_HOLE_KIT,
  blackHoleParts,
  blackHolePhysics,
  BlackHoleStateSchema,
  CORE_COLLAPSE_MASS_IN_SUNS,
  describeBlackHoleState,
  DISC_INNER_EDGE_IN_HORIZON_RADII,
  DISC_INNER_KELVINS,
  DISC_RINGS,
  discKelvins,
  escapeSpeedShare,
  formationPhysics,
  HOLE_MASS_IN_SUNS,
  horizonRadiusKilometres,
  INITIAL_BLACK_HOLE_STATE,
  massInsideOrbit,
  ORBIT_RADII,
  orbitPeriod,
  orbitSpeed,
  PROGENITOR_MASS_IN_SUNS,
  pullAt,
  separationAt,
  settleBlackHoleState,
  SHADOW_RADIUS_IN_HORIZON_RADII,
  TIME_TO_MERGER,
  waveFrequencyAt,
  waveStrengthAt,
  type BlackHolePart,
  type BlackHolePatch,
  type BlackHolePhysics,
  type BlackHoleState,
  type BlackHoleView,
  type FormationPhysics,
  type HoleSize,
  type LifeStage,
  type MergerStage,
  type ProgenitorStar,
  type StarEnding,
} from './black-hole.js';
export {
  blackbodyColour,
  colourMatching,
  peakNanometres,
  planckGlow,
  VISIBLE_NANOMETRES,
  wavelengthColour,
  WIEN_NANOMETRE_KELVINS,
} from './spectrum.js';
export {
  describeStarlightState,
  DISTANCE_STEPS,
  dimmedShare,
  habitableZoneOf,
  INITIAL_STARLIGHT_STATE,
  luminosityOf,
  MAIN_SEQUENCE_MASS_IN_SUNS,
  mainSequenceLuminosityAt,
  ORBIT_ASTRONOMICAL_UNITS,
  settleStarlightState,
  STARLIGHT_ENUMS,
  STARLIGHT_KIT,
  starlightAt,
  starlightParts,
  starlightPhysics,
  StarlightStateSchema,
  starlightStar,
  starGroup,
  STARS_BY_TEMPERATURE,
  SUN_SURFACE_KELVINS,
  ZONE_STARLIGHT,
  ZONE_STARS,
  zoneVerdict,
  type HabitableZone,
  type PlanetOrbit,
  type StarGroup,
  type StarKind,
  type StarlightDistance,
  type StarlightPart,
  type StarlightPatch,
  type StarlightPhysics,
  type StarlightState,
  type StarlightStar,
  type StarlightView,
  type ZoneStar,
  type ZoneVerdict,
} from './starlight.js';
