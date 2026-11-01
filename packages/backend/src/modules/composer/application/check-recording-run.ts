import { parsePersonalRecordingPurpose, type CheckPersonalRecordingRun } from '../../../reasoning/public.js';
import type { CheckActivatedExposure } from './ports.js';

/** What the owner check reads: whether an exposure was activated, asked of Experience by its ID. */
export interface ComposerRecordingOwner {
  readonly exposureActivated: CheckActivatedExposure;
}

/**
 * Whether the encounter a Composer run serves is still the one it was made for (D-270). The recording harness calls it, inside
 * the transaction it holds, after the root, the account and the recording generation are fenced; it reads one row by key and
 * nothing else, and adds what only the Composer knows.
 *
 * Jev's assessment (`jev-assessment`) is made for one buffer job, which is made for the exposure the person activated: the run
 * is current while that exposure exists in this epoch and was activated. The job carries no generation: the run is stamped with
 * the generation recording was at when the job started, and the harness holds every read and write to it. Whether the session
 * has moved on is not asked here: a superseded job still settles its run and keeps what it bought. Anything else, including a
 * purpose that is not the Composer's, is `unavailable`.
 */
export function makeCheckComposerRecordingRun(owner: ComposerRecordingOwner): CheckPersonalRecordingRun {
  return async (cap, value) => {
    const purpose = parsePersonalRecordingPurpose(value);
    const scope = cap.personal;
    if (
      purpose?.ownerModule !== 'composer' ||
      purpose.purpose !== 'jev-assessment' ||
      purpose.universeId !== scope.authority.universeId ||
      purpose.privacyEpoch !== scope.authority.privacyEpoch ||
      purpose.recordingGeneration !== cap.generation
    )
      return 'unavailable';
    return (await owner.exposureActivated(scope, purpose.claimId)) ? 'current' : 'unavailable';
  };
}
