import type { WithPersonalScope } from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { notifyScopeChanged } from '../../../infrastructure/notices/index.js';
import { advanceScopeRevision } from '../../../infrastructure/postgres/personal-scope.js';
import { makeApplyActionEvidence } from '../application/apply-action-evidence.js';
import { insertActionEvent, loadAction } from './postgres-store.js';

/** Injection token of the `evidence.apply-action` consumer use case. */
export const APPLY_ACTION_EVIDENCE = Symbol('evidence.applyActionEvidence');

/** Reusable outer wiring for the worker's composition root (blueprint §22). */
export function evidenceProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: APPLY_ACTION_EVIDENCE,
      inject: [tokens.withPersonalScope],
      useFactory: (withPersonalScope: WithPersonalScope) =>
        makeApplyActionEvidence({
          withPersonalScope,
          loadAction,
          insertActionEvent,
          advanceRevision: advanceScopeRevision,
          notifyScopeChanged,
          newId: () => uuidv7(),
        }),
    },
  ];
}
