import { EARTH_SKY_KIT, EARTH_SKY_KIT_DEFINITION } from '../kit.js';
import { type KitDefinition } from './definition.js';
import { GREENHOUSE_KIT, GREENHOUSE_KIT_DEFINITION } from './greenhouse.js';
import { STAR_KIT, STAR_KIT_DEFINITION } from './star.js';
import { TIDES_KIT, TIDES_KIT_DEFINITION } from './tides.js';
import { TRANSIT_KIT, TRANSIT_KIT_DEFINITION } from './transit.js';

/**
 * Every drawing kit a Scroll's stage can use (D-194). A stage names one kit and every state of that
 * stage holds that kit's words and no others. A recipe names the kit that draws its subject (the library
 * plan's `stageKit`), and a test keeps the plan's list and this one the same. Adding a kit is a new id,
 * its own words and physics, and a new decision.
 */
export const STAGE_KIT_IDS = [EARTH_SKY_KIT, TIDES_KIT, GREENHOUSE_KIT, STAR_KIT, TRANSIT_KIT] as const;
export type StageKitId = (typeof STAGE_KIT_IDS)[number];

const KITS: Readonly<Record<StageKitId, KitDefinition>> = {
  [EARTH_SKY_KIT]: EARTH_SKY_KIT_DEFINITION,
  [TIDES_KIT]: TIDES_KIT_DEFINITION,
  [GREENHOUSE_KIT]: GREENHOUSE_KIT_DEFINITION,
  [STAR_KIT]: STAR_KIT_DEFINITION,
  [TRANSIT_KIT]: TRANSIT_KIT_DEFINITION,
};

/** The generic definition of a kit: its words, its first state, how it settles and describes a state. */
export function kitDefinition(id: StageKitId): KitDefinition {
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
  describeStarState,
  INITIAL_STAR_STATE,
  lifetimeInSunLifetimes,
  mainSequenceRadiusInSuns,
  MASS_IN_SUNS,
  settleStarState,
  STAR_ENUMS,
  STAR_KIT,
  starParts,
  starPhysics,
  StarStateSchema,
  surfaceAt,
  type StarEnd,
  type StarMass,
  type StarMotion,
  type StarPart,
  type StarPatch,
  type StarPhysics,
  type StarStage,
  type StarState,
  type StarView,
  type SurfaceTemperature,
} from './star.js';
export {
  combinedTide,
  describeTidesState,
  INITIAL_TIDES_STATE,
  MOON_DIRECTION_DEGREES,
  MOON_DISTANCE_EARTH_RADII,
  moonPull,
  SOLAR_SHARE_OF_LUNAR,
  settleTidesState,
  SUN_DIRECTION_DEGREES,
  tideRangeByPhase,
  TIDES_ENUMS,
  TIDES_KIT,
  tidesParts,
  tidesPhysics,
  TidesStateSchema,
  type CombinedTide,
  type MoonPhase,
  type MoonPull,
  type TideKind,
  type TidesPart,
  type TidesPatch,
  type TidesPhysics,
  type TidesState,
  type TidesView,
} from './tides.js';
export {
  brightnessAt,
  coveredShare,
  CROSSING_SEPARATION,
  describeTransitState,
  INITIAL_TRANSIT_STATE,
  ORBIT_RADIUS_IN_STAR_RADII,
  orbitDegreesAt,
  PLANET_WIDTH_SHARE,
  settleTransitState,
  TRANSIT_ENUMS,
  TRANSIT_KIT,
  transitDepth,
  transitParts,
  transitPhysics,
  TransitStateSchema,
  type CrossingPlace,
  type PlanetSize,
  type TransitPart,
  type TransitPatch,
  type TransitPhysics,
  type TransitState,
  type TransitView,
} from './transit.js';
