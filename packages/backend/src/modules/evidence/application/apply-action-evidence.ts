import type { ApplyActionEvidencePayload } from '../events.js';
import type { ApplyActionEvidencePorts } from './ports.js';

export type ApplyActionEvidenceResult =
  | { readonly kind: 'applied'; readonly revision: number; readonly eventId: string }
  | {
      readonly kind: 'skipped';
      readonly reason: 'already_applied' | 'action_missing' | 'epoch_changed' | 'universe_unavailable';
    };

/**
 * Consumer of `evidence.apply-action` (worker; non-transactional: it opens its own short
 * transaction).
 *
 * Authority: a `system` actor for the payload's universe at the payload's privacy epoch. The
 *   worker has no HTTP guard, so this recheck under the personal lock is the authority check; work
 *   for an older epoch is skipped, never applied.
 * Steps (one transaction): lock → read the action → insert the evidence row keyed by
 *   (universe, action) → advance the universe revision → `pg_notify` the scope change → commit.
 * Redelivery: the unique key makes a second delivery a no-op (`already_applied`): no second row,
 *   no second revision, no second hint.
 */
export function makeApplyActionEvidence(ports: ApplyActionEvidencePorts) {
  return async function applyActionEvidence(payload: ApplyActionEvidencePayload): Promise<ApplyActionEvidenceResult> {
    const authority = {
      universeId: payload.universeId,
      privacyEpoch: payload.privacyEpoch,
      actor: { kind: 'system', purpose: 'evidence.apply-action' },
    } as const;
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<ApplyActionEvidenceResult> => {
      const action = await ports.loadAction(scope, payload.actionId);
      if (action === undefined) return { kind: 'skipped', reason: 'action_missing' };
      const eventId = ports.newId();
      if (!(await ports.insertActionEvent(scope, { ...action, eventId })))
        return { kind: 'skipped', reason: 'already_applied' };
      const revision = await ports.advanceRevision(scope);
      await ports.notifyScopeChanged(scope, { revision, eventId });
      return { kind: 'applied', revision, eventId };
    });
    if (entered.kind === 'entered') return entered.value;
    return {
      kind: 'skipped',
      reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
    };
  };
}

export type ApplyActionEvidence = ReturnType<typeof makeApplyActionEvidence>;
