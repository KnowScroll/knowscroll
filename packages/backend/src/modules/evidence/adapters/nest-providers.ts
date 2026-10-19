import { READ_ACTION_FOR_EVIDENCE, type ReadActionForEvidence } from '../../experience/public.js';
import type { WithPersonalScope } from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { makeApplyActionEvidence } from '../application/apply-action-evidence.js';
import { insertActionEvent } from './postgres-store.js';

/** Injection token of the `evidence.apply-action` consumer use case. */
export const APPLY_ACTION_EVIDENCE = Symbol('evidence.applyActionEvidence');

/**
 * Reusable outer wiring for the worker's composition root (blueprint §22). Needs experience's
 * evidence read port (`READ_ACTION_FOR_EVIDENCE`) in the same composition root.
 */
export function evidenceProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: APPLY_ACTION_EVIDENCE,
      inject: [tokens.withPersonalScope, READ_ACTION_FOR_EVIDENCE],
      useFactory: (withPersonalScope: WithPersonalScope, readAction: ReadActionForEvidence) =>
        makeApplyActionEvidence({
          withPersonalScope,
          loadAction: async (scope, actionId) => {
            const action = await readAction(scope, actionId);
            return action === undefined
              ? undefined
              : { id: action.id, kind: action.kind, assetId: action.assetId, assetRevision: action.assetRevision };
          },
          insertActionEvent,
          advanceRevision: advanceScopeRevision,
          notifyScopeChanged,
          newId: () => uuidv7(),
        }),
    },
  ];
}
