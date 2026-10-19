/**
 * Experience's public surface for other modules and the apps: operation types, outcome schema
 * and the read port the evidence job uses. Commands and queries are built by
 * `adapters/nest-providers.ts` (composition roots only).
 */
import type { PersonalScopeTx } from '../identity/public.js';
import type { ActionKind } from './domain/actions.js';

export {
  ACTION_OUTCOME_VERSION,
  ActionOutcomeSchema,
  APPLY_ACTION_OPERATION,
  type ActionOutcome,
  type ApplyAction,
  type ApplyActionCommand,
  type ApplyActionResult,
} from './application/apply-action.js';
export { SAVED_PAGE_LIMIT, type ListSaved, type ListSavedResult } from './application/list-saved.js';

/** An action as the evidence module reads it. */
export interface ActionForEvidence {
  readonly id: string;
  readonly kind: ActionKind;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly privacyEpoch: number;
}

/**
 * Port: read one action of the scope's universe inside the reader's own locked scope.
 * `undefined` when the action no longer exists (erased).
 */
export type ReadActionForEvidence = (
  scope: PersonalScopeTx,
  actionId: string,
) => Promise<ActionForEvidence | undefined>;

export const READ_ACTION_FOR_EVIDENCE = Symbol('experience.readActionForEvidence');
