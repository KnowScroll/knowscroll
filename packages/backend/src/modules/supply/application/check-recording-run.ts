import {
  parsePersonalRecordingPurpose,
  type CheckPersonalRecordingRun,
  type PersonalRecordingPurpose,
} from '../../../reasoning/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { QuickAnswerStore } from './quick-answer-ports.js';
import type { SupplyStore } from './ports.js';

/** What the owner check reads: the person's own request and Quick answer rows, by exact key. */
export interface SupplyRecordingOwner {
  readonly requests: Pick<SupplyStore, 'read'>;
  readonly quickAnswers: Pick<QuickAnswerStore, 'read'>;
}

/**
 * Whether the record a Supply run serves is still the one it was made for (D-264, D-268). The recording harness calls it, inside the
 * transaction it holds, after the root, the account and the recording generation are fenced; it reads one row by key and nothing
 * else, and adds what only Supply knows.
 *
 * A question's placement and library check are current while the request waits to be placed, and only for the generation the
 * request was asked at. A Quick answer's runs are current while its card exists (not dismissed or erased) and only for the
 * generation it was asked at; its checks close after the answer is settled, so settled still counts. A free-text match is
 * current while its request waits to be matched; that request carries no generation, and the harness has already held the run
 * to the generation it started at. Anything else, including a purpose that is not Supply's, is `unavailable`.
 */
export function makeCheckSupplyRecordingRun(owner: SupplyRecordingOwner): CheckPersonalRecordingRun {
  return async (cap, value) => {
    const purpose = parsePersonalRecordingPurpose(value);
    const scope = cap.personal;
    if (
      purpose?.ownerModule !== 'supply' ||
      purpose.universeId !== scope.authority.universeId ||
      purpose.privacyEpoch !== scope.authority.privacyEpoch ||
      purpose.recordingGeneration !== cap.generation
    )
      return 'unavailable';
    return (await isCurrent(owner, scope, purpose)) ? 'current' : 'unavailable';
  };
}

async function isCurrent(
  owner: SupplyRecordingOwner,
  scope: PersonalScopeTx,
  purpose: PersonalRecordingPurpose,
): Promise<boolean> {
  switch (purpose.purpose) {
    case 'ask-scope':
    case 'ask-library':
      return requestWaits(owner, scope, purpose.claimId, purpose.recordingGeneration);
    case 'match-request':
      return textRequestWaits(owner, scope, purpose.claimId);
    case 'quick-answer':
    case 'quick-answer-support':
      return quickAnswerExists(owner, scope, purpose.claimId, purpose.recordingGeneration);
    default:
      return false;
  }
}

async function requestWaits(
  owner: SupplyRecordingOwner,
  scope: PersonalScopeTx,
  requestId: string,
  generation: number,
): Promise<boolean> {
  const request = await owner.requests.read(scope, requestId);
  return (
    request?.status === 'matching' &&
    request.command.intent.kind === 'ask' &&
    request.command.intent.recordingGeneration === generation
  );
}

async function textRequestWaits(owner: SupplyRecordingOwner, scope: PersonalScopeTx, requestId: string): Promise<boolean> {
  const request = await owner.requests.read(scope, requestId);
  const { intent } = request?.command ?? {};
  return request?.status === 'matching' && intent?.kind === 'topic' && intent.subject.kind === 'text';
}

async function quickAnswerExists(
  owner: SupplyRecordingOwner,
  scope: PersonalScopeTx,
  quickAnswerId: string,
  generation: number,
): Promise<boolean> {
  const row = await owner.quickAnswers.read(scope, quickAnswerId);
  return row !== undefined && row.state !== 'dismissed' && row.recordingGeneration === generation;
}
