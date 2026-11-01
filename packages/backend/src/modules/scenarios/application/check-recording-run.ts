import { parsePersonalRecordingPurpose, type CheckPersonalRecordingRun } from '../../../reasoning/public.js';
import type { ScenarioStore } from './ports.js';

/** What the owner check reads: the member's own draft and branch rows, by exact key. */
export interface ScenarioRecordingOwner {
  readonly store: Pick<ScenarioStore, 'readDraft' | 'readNode'>;
}

/**
 * Whether the record a Scenarios run serves is still the one it was made for (D-270). The recording harness calls it, inside the
 * transaction it holds, after the root, the account and the recording generation are fenced; it reads one row by key and nothing
 * else, and adds what only Scenarios knows.
 *
 * The planner's `suggest` step is current while its draft is still being thought about. The short-answer writer's `answer` step
 * is current while its what-if branch stands and the answer is still being written. A draft or branch carries no generation: the
 * run is stamped with the generation recording was at when the step started, and the harness holds every read and write to it.
 * Anything else, including a purpose that is not Scenarios', is `unavailable`.
 */
export function makeCheckScenariosRecordingRun(owner: ScenarioRecordingOwner): CheckPersonalRecordingRun {
  return async (cap, value) => {
    const purpose = parsePersonalRecordingPurpose(value);
    const scope = cap.personal;
    if (
      purpose?.ownerModule !== 'scenarios' ||
      purpose.universeId !== scope.authority.universeId ||
      purpose.privacyEpoch !== scope.authority.privacyEpoch ||
      purpose.recordingGeneration !== cap.generation
    )
      return 'unavailable';
    switch (purpose.purpose) {
      case 'suggest': {
        const draft = await owner.store.readDraft(scope, purpose.claimId);
        return draft?.state === 'thinking' && draft.requesterUniverseId === scope.authority.universeId
          ? 'current'
          : 'unavailable';
      }
      case 'answer': {
        const node = await owner.store.readNode(scope, purpose.claimId);
        return node?.kind === 'what_if' && node.status !== 'removed' && node.answer?.state === 'making'
          ? 'current'
          : 'unavailable';
      }
      default:
        return 'unavailable';
    }
  };
}
