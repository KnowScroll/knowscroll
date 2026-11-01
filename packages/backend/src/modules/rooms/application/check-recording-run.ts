import { parsePersonalRecordingPurpose, type CheckPersonalRecordingRun } from '../../../reasoning/public.js';
import type { RoomPorts } from './ports.js';

/** What the owner check reads: the asker's own queued ask, by its key. */
export interface RoomsRecordingOwner {
  readonly ai: Pick<RoomPorts['ai'], 'forJob'>;
}

/**
 * Whether the ask a Rooms run serves is still the one it was made for (D-268). The recording harness calls it, inside the
 * transaction it holds, after the root, the account and the recording generation are fenced; it reads one row by key and nothing
 * else, and adds what only Rooms knows.
 *
 * An AI inhabitant's answer to a member's ask (`inhabitant-contribution`) is current while that ask is still queued for this
 * person: the turn is theirs, asked by them, and has not been settled, cancelled or withdrawn. The ask carries no generation:
 * the run is stamped with the generation the asker's recording was at when the step started, and the harness holds every read
 * and write to it. A resident's own turn runs in the room's scope, not a person's, and is never checked here. Anything else,
 * including a purpose that is not Rooms', is `unavailable`.
 */
export function makeCheckRoomsRecordingRun(owner: RoomsRecordingOwner): CheckPersonalRecordingRun {
  return async (cap, value) => {
    const purpose = parsePersonalRecordingPurpose(value);
    const scope = cap.personal;
    if (
      purpose?.ownerModule !== 'rooms' ||
      purpose.purpose !== 'inhabitant-contribution' ||
      purpose.universeId !== scope.authority.universeId ||
      purpose.privacyEpoch !== scope.authority.privacyEpoch ||
      purpose.recordingGeneration !== cap.generation
    )
      return 'unavailable';
    const turn = await owner.ai.forJob(scope, purpose.claimId);
    return turn?.state === 'queued' && turn.requestedByAccountId === purpose.accountId ? 'current' : 'unavailable';
  };
}
