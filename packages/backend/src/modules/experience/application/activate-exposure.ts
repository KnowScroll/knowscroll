import { z } from 'zod';
import type { PersonalAuthority, ScopeRefusal } from '../../identity/public.js';
import { decideActivation } from '../domain/exposures.js';
import { originalRecordingGeneration, recordingRequest, type ActivateExposurePorts, type JsonValue } from './ports.js';

export const ACTIVATE_EXPOSURE_OPERATION = 'experience.activate-exposure';
/** Version of the stored outcome below. A new shape gets a new version (blueprint §5). */
export const ACTIVATE_EXPOSURE_OUTCOME_VERSION = 1;

export interface ActivateExposureCommand {
  readonly commandId: string;
  readonly exposureId: string;
  readonly recordingGeneration?: number;
}

/** The stored and returned outcome of an accepted activation. Replays return it unchanged. */
export const ActivateExposureOutcomeSchema = z.object({
  exposureId: z.uuid(),
  activatedAt: z.iso.datetime(),
  revision: z.number().int().min(0),
});

export type ActivateExposureOutcome = z.infer<typeof ActivateExposureOutcomeSchema>;

export type ActivateExposureRefusal =
  'exposure_not_found' | 'command_key_reused' | 'epoch_changed' | 'universe_unavailable' | 'outcome_from_newer_release';

export type ActivateExposureResult =
  | { readonly kind: 'activated'; readonly outcome: ActivateExposureOutcome; readonly replayed: boolean }
  | { readonly kind: 'refused'; readonly reason: ActivateExposureRefusal };

/**
 * `activateExposure`: the exposure's article became the active reading surface
 * (`POST /v1/experience/activate`). Activation is the lineage the recorder's observations require;
 * it asserts nothing was seen (visibility is observed separately, blueprint §7).
 *
 * Authority: the caller's account and universe at a privacy epoch, rechecked under the personal
 *   root lock; the exposure must belong to that universe and epoch.
 * Steps (one transaction): lock → receipt lookup → read the exposure (`exposure_not_found` when it
 *   is unknown or another person's: the two are indistinguishable) → insert the receipt → set the
 *   activation time once (`decideActivation`: an active exposure keeps its original time) → store
 *   the outcome → commit.
 * Side effects: `experience.exposures.activated_at`, `receipts.personal_commands`. No job, no notice.
 * Failure/retry: any exception rolls everything back; retrying with the same command ID is safe,
 *   and activating an exposure that is already active under a new command ID answers its original
 *   time without writing it again.
 * Invariants: activation never moves; observations can only follow it.
 */
export function makeActivateExposure(ports: ActivateExposurePorts) {
  return async function activateExposure(
    authority: PersonalAuthority,
    command: ActivateExposureCommand,
  ): Promise<ActivateExposureResult> {
    const request: JsonValue = { ...recordingRequest(command), exposureId: command.exposureId };
    const key = {
      commandId: command.commandId,
      operation: ACTIVATE_EXPOSURE_OPERATION,
      requestHash: ports.hashRequest(ACTIVATE_EXPOSURE_OPERATION, request),
      outcomeVersion: ACTIVATE_EXPOSURE_OUTCOME_VERSION,
    };
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<ActivateExposureResult> => {
      const lookup = await ports.findReceipt(scope, key);
      switch (lookup.kind) {
        case 'key_reused':
        case 'epoch_mismatch':
        case 'outcome_version_older':
          return { kind: 'refused', reason: 'command_key_reused' };
        case 'outcome_version_newer':
          return { kind: 'refused', reason: 'outcome_from_newer_release' };
        case 'replay':
          return {
            kind: 'activated',
            outcome: ActivateExposureOutcomeSchema.parse(lookup.outcome),
            replayed: true,
          };
        case 'new':
          break;
      }
      const exposure = await ports.readExposure(scope, command.exposureId);
      if (exposure === undefined || exposure.privacyEpoch !== scope.authority.privacyEpoch)
        return { kind: 'refused', reason: 'exposure_not_found' };

      await ports.insertReceipt(scope, key);
      const at = ports.now();
      const gate = await ports.recording?.fence(scope, originalRecordingGeneration(command));
      if (gate?.kind === 'unavailable') throw new Error('RECORDING_AUTHORITY_UNAVAILABLE');
      await ports.recording?.remember(
        scope,
        key,
        originalRecordingGeneration(command),
        gate?.kind === 'recording' ? gate.scope.generation : undefined,
        at,
      );
      const decision = decideActivation(exposure, at);
      if (decision.changed)
        await ports.markActivated(scope, exposure.id, decision.activatedAt, originalRecordingGeneration(command));
      if (gate?.kind === 'recording') await ports.recording?.activation(gate.scope, exposure.id, command.commandId, at);
      const outcome: ActivateExposureOutcome = {
        exposureId: exposure.id,
        activatedAt: decision.activatedAt.toISOString(),
        revision: scope.revisionAtEntry,
      };
      await ports.completeReceipt(scope, command.commandId, outcome);
      return { kind: 'activated', outcome, replayed: false };
    });
    return entered.kind === 'entered' ? entered.value : { kind: 'refused', reason: refusalOf(entered.refusal) };
  };
}

export type ActivateExposure = ReturnType<typeof makeActivateExposure>;

function refusalOf(refusal: ScopeRefusal): ActivateExposureRefusal {
  switch (refusal.kind) {
    case 'epoch_changed':
      return 'epoch_changed';
    case 'universe_missing':
    case 'universe_suspended':
    case 'account_mismatch':
      return 'universe_unavailable';
  }
}
