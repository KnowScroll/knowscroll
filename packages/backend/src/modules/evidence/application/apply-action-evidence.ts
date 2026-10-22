import { ApplyActionEvidencePayloadSchema, type ApplyActionEvidencePayload } from '../events.js';
import type { ApplyActionEvidencePorts } from './ports.js';

export type ApplyActionEvidenceResult =
  | { readonly kind: 'applied'; readonly eventId: string }
  | {
      readonly kind: 'skipped';
      readonly reason:
        'recording_ineligible' | 'already_applied' | 'action_missing' | 'epoch_changed' | 'universe_unavailable';
    };

/**
 * Consumer of `evidence.apply-action` (worker; non-transactional: it opens its own short
 * transaction).
 *
 * Authority: a `system` actor for the payload's universe at the payload's privacy epoch. The
 *   worker has no HTTP guard, so this recheck under the personal lock is the authority check; work
 *   for an older epoch is skipped, never applied.
 * Steps (one transaction): lock → read the action → insert the evidence row keyed by
 *   (universe, action) → commit. Evidence changes nothing a client reads, so it advances no
 *   revision and sends no hint (the command already did, for its own change); a future evidence
 *   effect that clients read would advance the revision for that change only.
 * Redelivery: the unique key makes a second delivery a no-op (`already_applied`): no second row.
 */
export function makeApplyActionEvidence(ports: ApplyActionEvidencePorts) {
  return async function applyActionEvidence(payload: ApplyActionEvidencePayload): Promise<ApplyActionEvidenceResult> {
    payload = ApplyActionEvidencePayloadSchema.parse(payload);
    const authority = {
      universeId: payload.universeId,
      privacyEpoch: payload.privacyEpoch,
      actor: { kind: 'system', purpose: 'evidence.apply-action' },
    } as const;
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<ApplyActionEvidenceResult> => {
      if ((await ports.fenceOwn(scope)).kind !== 'active') return { kind: 'skipped', reason: 'universe_unavailable' };
      const gate = await ports.fenceRecording(scope, payload.v === 2 ? payload.recordingGeneration : undefined);
      if (gate.kind !== 'recording') return { kind: 'skipped', reason: 'recording_ineligible' };
      const cap = gate.scope;
      const action = await ports.loadAction(scope, payload.actionId);
      if (action === undefined) return { kind: 'skipped', reason: 'action_missing' };
      const origin = action.recordingOrigin;
      const eligible =
        origin?.kind === 'recorded'
          ? origin.eligibleGeneration === cap.generation && (origin.originalGeneration ?? 1) === cap.generation
          : payload.v === 1;
      if (!eligible) return { kind: 'skipped', reason: 'recording_ineligible' };
      const eventId = ports.newId();
      if (!(await ports.insertActionEvent(cap, { ...action, eventId })))
        return { kind: 'skipped', reason: 'already_applied' };
      return { kind: 'applied', eventId };
    });
    if (entered.kind === 'entered') return entered.value;
    return {
      kind: 'skipped',
      reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
    };
  };
}

export type ApplyActionEvidence = ReturnType<typeof makeApplyActionEvidence>;
