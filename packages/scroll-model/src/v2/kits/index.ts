import { EARTH_SKY_KIT, EARTH_SKY_KIT_DEFINITION } from '../kit.js';
import { type KitDefinition } from './definition.js';

/**
 * Every drawing kit a Scroll's stage can use (D-194). A stage names one kit and every state of that
 * stage holds that kit's words and no others. The library plan keeps a list of these ids (`STAGE_KIT_IDS`), and a
 * test keeps the plan's list and this one the same. Adding a kit is a new id,
 * its own words and physics, and a new decision.
 */
export const STAGE_KIT_IDS = [EARTH_SKY_KIT] as const;
export type StageKitId = (typeof STAGE_KIT_IDS)[number];

/** Whether `id` names a kit the code still defines. A stored stage may name one it no longer does (a legacy stage). */
export function isStageKitId(id: string): id is StageKitId {
  return (STAGE_KIT_IDS as readonly string[]).includes(id);
}

const KITS: Readonly<Record<StageKitId, KitDefinition>> = {
  [EARTH_SKY_KIT]: EARTH_SKY_KIT_DEFINITION,
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
