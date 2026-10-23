/** Backend-only future opportunities. No consumer UI, evidence writes or supply admission. */
export { PLANNER_POLICY, PLANNER_LIMITS, IntentSchema, OpportunitySchema, ProposalSchema } from './domain/proposal.js';
export type { Opportunity, PlannerIntent, PlannerProposal } from './domain/proposal.js';
export type {
  RequestPlanner,
  RequestPlannerOutcome,
  PlannerMaterialChange,
  ReadPlannerOpportunities,
  RunPlanner,
} from './application/ports.js';
export { plannerQueue, PlannerJobSchema } from './events.js';
export const REQUEST_PLANNER = Symbol('planner.request');
export const PLANNER_MATERIAL_CHANGE = Symbol('planner.material-change');
export const READ_PLANNER_OPPORTUNITIES = Symbol('planner.read-opportunities');
export const RUN_PLANNER = Symbol('planner.run');
/** Cheap stored read of the current accepted plan, for Composer on the navigation path. */
export const READ_CURRENT_PLAN = Symbol('planner.read-current-plan');

export type { PlannerSource } from './application/ports.js';
