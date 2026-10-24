import { z } from 'zod';
import type { PersonalAuthority, ScopeRefusal } from '../../identity/public.js';
import type { ExposureOrigin } from '../domain/exposures.js';
import type { JsonValue, OpenExposurePorts } from './ports.js';

export const OPEN_EXPOSURE_OPERATION = 'experience.open-exposure';
/** Version of the stored outcome below. A new shape gets a new version (blueprint §5). */
export const OPEN_EXPOSURE_OUTCOME_VERSION = 1;

export interface OpenExposureCommand {
  readonly commandId: string;
  readonly target: { readonly kind: 'scroll' | 'reel'; readonly assetId: string };
  readonly origin: { readonly kind: ExposureOrigin };
  /** What the client can render, as it declared it (validated at the wire boundary). */
  readonly capabilities: JsonValue;
}

/** The stored and returned outcome of an accepted open. Replays return it unchanged. */
export const OpenExposureOutcomeSchema = z.object({
  exposureId: z.uuid(),
  assetId: z.uuid(),
  assetRevision: z.number().int().min(1),
  kind: z.enum(['scroll', 'reel']),
  /** The universe revision under the lock: opening changes nothing a client reads, so it is unchanged. */
  revision: z.number().int().min(0),
});

export type OpenExposureOutcome = z.infer<typeof OpenExposureOutcomeSchema>;

export type OpenExposureRefusal =
  'asset_not_found' | 'command_key_reused' | 'epoch_changed' | 'universe_unavailable' | 'outcome_from_newer_release';

export type OpenExposureResult =
  | { readonly kind: 'opened'; readonly outcome: OpenExposureOutcome; readonly replayed: boolean }
  | { readonly kind: 'refused'; readonly reason: OpenExposureRefusal };

/**
 * `openExposure`: open an admitted Scroll for the authenticated person (`POST /v1/experience/open`),
 * creating the exposure that roots this encounter's lineage: exposure ID, the asset's current
 * revision, the origin, and what the client can render. Opening is not consumption (blueprint §8:
 * only observed, qualified reading is evidence).
 *
 * Authority: the caller's account and universe at a privacy epoch, rechecked under the personal
 *   root lock.
 * Steps (one transaction, blueprint §19): lock → receipt lookup (identical replay returns the
 *   stored outcome; different content under the same key is refused; a receipt from an older
 *   privacy epoch is never replayed) → the asset exists, is admitted, is a Scroll and has a stored
 *   revision → insert the receipt → insert the exposure at the asset's current revision → store the
 *   outcome → commit.
 * Side effects: `experience.exposures`, `receipts.personal_commands`. No job (nothing to project
 *   yet), no notice, no network call.
 * Failure/retry: any exception rolls everything back; retrying with the same command ID is safe.
 *   A missing, withdrawn or non-Scroll asset is a retryable refusal that writes nothing (D-016).
 * Invariants: the exposure presents the revision that was current when the command committed and
 *   never changes revision afterwards: a later revision of the asset is a new exposure.
 */
export function makeOpenExposure(ports: OpenExposurePorts) {
  return async function openExposure(
    authority: PersonalAuthority,
    command: OpenExposureCommand,
  ): Promise<OpenExposureResult> {
    const request: JsonValue = {
      target: { kind: command.target.kind, assetId: command.target.assetId },
      origin: { kind: command.origin.kind },
      capabilities: command.capabilities,
    };
    const key = {
      commandId: command.commandId,
      operation: OPEN_EXPOSURE_OPERATION,
      requestHash: ports.hashRequest(OPEN_EXPOSURE_OPERATION, request),
      outcomeVersion: OPEN_EXPOSURE_OUTCOME_VERSION,
    };
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<OpenExposureResult> => {
      const lookup = await ports.findReceipt(scope, key);
      switch (lookup.kind) {
        case 'key_reused':
        case 'epoch_mismatch':
        case 'outcome_version_older':
          return { kind: 'refused', reason: 'command_key_reused' };
        case 'outcome_version_newer':
          return { kind: 'refused', reason: 'outcome_from_newer_release' };
        case 'replay':
          return { kind: 'opened', outcome: OpenExposureOutcomeSchema.parse(lookup.outcome), replayed: true };
        case 'new':
          break;
      }
      const asset = await ports.findOpenableAsset(scope, command.target.assetId);
      if (asset?.kind !== command.target.kind || !asset.admitted || asset.documentSha256 === undefined)
        return { kind: 'refused', reason: 'asset_not_found' };
      // A Scroll ordered for a thread is not found by anyone outside it, exactly as a missing one.
      if (!(await ports.audienceHolds({ scope }, scope.authority, asset.assetId)))
        return { kind: 'refused', reason: 'asset_not_found' };

      await ports.insertReceipt(scope, key);
      const exposureId = ports.newId();
      await ports.insertExposure(scope, {
        id: exposureId,
        assetId: asset.assetId,
        assetRevision: asset.revision,
        kind: command.target.kind,
        origin: command.origin.kind,
        capabilities: command.capabilities,
        commandId: command.commandId,
        openedAt: ports.now(),
      });
      const outcome: OpenExposureOutcome = {
        exposureId,
        assetId: asset.assetId,
        assetRevision: asset.revision,
        kind: command.target.kind,
        revision: scope.revisionAtEntry,
      };
      await ports.completeReceipt(scope, command.commandId, outcome);
      return { kind: 'opened', outcome, replayed: false };
    });
    return entered.kind === 'entered' ? entered.value : { kind: 'refused', reason: refusalOf(entered.refusal) };
  };
}

export type OpenExposure = ReturnType<typeof makeOpenExposure>;

function refusalOf(refusal: ScopeRefusal): OpenExposureRefusal {
  switch (refusal.kind) {
    case 'epoch_changed':
      return 'epoch_changed';
    case 'universe_missing':
    case 'universe_suspended':
    case 'account_mismatch':
      return 'universe_unavailable';
  }
}
