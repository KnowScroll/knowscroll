/** Established personal meaning and versioned public effects, independent of scenes/renderers. */
export { GEOGRAPHY_POLICY, FORMATION } from './domain/policy.js';
export type {
  MaterialGeographyChange,
  RequestCartography,
  RequestCartographyResult,
  RunCartographer,
  ReadOwnGeography,
  ReadOwnDeltas,
  ReadOwnEmerging,
  PublishGeographyDelta,
} from './application/ports.js';
export { CartographyJobSchema, type CartographyJob, cartographyQueue, publishDeltaQueue } from './events.js';
export const GEOGRAPHY_MATERIAL_CHANGE = Symbol('geography.materialChange');
export const REQUEST_CARTOGRAPHY = Symbol('geography.requestCartography');
export const RUN_CARTOGRAPHER = Symbol('geography.runCartographer');
export const READ_OWN_GEOGRAPHY = Symbol('geography.readOwn');
export const READ_OWN_DELTAS = Symbol('geography.readDeltas');
export const READ_OWN_EMERGING = Symbol('geography.readEmerging');
export const PUBLISH_GEOGRAPHY_DELTA = Symbol('geography.publishDelta');

export type { GeographySceneInput, ReadGeographySceneInput, GeographyApplied } from './application/ports.js';
export const READ_GEOGRAPHY_SCENE_INPUT = Symbol('geography.readSceneInput');
export const GEOGRAPHY_APPLIED = Symbol('geography.applied');
export type { GeographyRegionConstraint, ReadOwnRegionConstraint } from './application/ports.js';
export const READ_OWN_REGION_CONSTRAINT = Symbol('geography.readOwnRegionConstraint');
export { GeographyRegionConstraintSchema } from './application/region-constraint.js';

export { CHECK_GEOGRAPHY_RECORDING_RUN } from '../../reasoning/public.js';
