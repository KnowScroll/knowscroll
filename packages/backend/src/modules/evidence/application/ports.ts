import type { WithPersonalScope, PersonalScopeTx } from '../../identity/public.js';

/** An action as the evidence job needs it (read from experience through its public surface). */
export interface ActionToRecord {
  readonly id: string;
  readonly kind: 'save' | 'unsave';
  readonly assetId: string;
  readonly assetRevision: number;
}

export interface ApplyActionEvidencePorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly loadAction: (scope: PersonalScopeTx, actionId: string) => Promise<ActionToRecord | undefined>;
  /** Inserts the evidence row; `false` when this action was already recorded (redelivery). */
  readonly insertActionEvent: (
    scope: PersonalScopeTx,
    event: ActionToRecord & { readonly eventId: string },
  ) => Promise<boolean>;
  readonly newId: () => string;
}
