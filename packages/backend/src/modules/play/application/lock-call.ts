import type { CallLockNotSaved, CallLockRequest, CallLockSaved } from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import { afterLock, judgePick } from '../domain/results.js';
import type { PlayPorts, ReceiptKey, ReceiptLookup, StoredCall, StoredPlay } from './ports.js';
import { resultsOf } from './results.js';

export const CALL_LOCK_OPERATION = 'play.call-lock';
const OUTCOME_VERSION = 1;

export type CallLockRefusal =
  | 'call_not_found'
  | 'exposure_required'
  | 'option_invalid'
  | 'command_key_reused'
  | 'epoch_changed'
  | 'universe_unavailable'
  | 'outcome_from_newer_release';

export type CallLockResult =
  | { readonly kind: 'saved'; readonly outcome: CallLockSaved }
  | { readonly kind: 'not_saved'; readonly outcome: CallLockNotSaved }
  | { readonly kind: 'refused'; readonly reason: CallLockRefusal };

/** What a receipt keeps of a lock: enough to answer a retry from the stored lock and today's results. */
interface StoredOutcome extends StoredCall {
  readonly newlyLocked: boolean;
}

const refused = (reason: CallLockRefusal): CallLockResult => ({ kind: 'refused', reason });

type Receipt =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly outcome: StoredOutcome }
  | { readonly kind: 'refused'; readonly reason: CallLockRefusal };

/** The receipt step: an identical retry is answered from the receipt; a reused or foreign key is refused. */
function receiptStep(lookup: ReceiptLookup): Receipt {
  switch (lookup.kind) {
    case 'new':
      return { kind: 'new' };
    case 'replay':
      return { kind: 'replay', outcome: lookup.outcome as StoredOutcome };
    case 'outcome_version_newer':
      return { kind: 'refused', reason: 'outcome_from_newer_release' };
    case 'key_reused':
    case 'epoch_mismatch':
    case 'outcome_version_older':
      return { kind: 'refused', reason: 'command_key_reused' };
  }
}

function saved(command: CallLockRequest, lock: StoredOutcome, play: StoredPlay, replayed: boolean): CallLockResult {
  return {
    kind: 'saved',
    outcome: {
      recorded: true,
      commandId: command.commandId,
      assetId: command.assetId,
      revision: command.revision,
      stopId: lock.stopId,
      option: lock.option,
      correct: lock.correct,
      newlyLocked: lock.newlyLocked,
      results: resultsOf(command, play),
      replayed,
    },
  };
}

/**
 * `POST /v1/play/calls/lock` (`call.lock`): stores what the person locked on one Call it of one
 * Scroll revision, with whether it was right and the spark and combo it earned.
 *
 * Authority: the caller's account and universe at their privacy epoch, rechecked under the personal
 * root lock; the person must have an activated exposure of this exact revision. Correctness is
 * recomputed here from the immutable revision and never taken from the client.
 * Steps (one transaction): own-account fence, receipt lookup (an identical retry answers the stored
 * lock), the recording gate (paused or stale: nothing is stored, no receipt, and the answer says
 * so), exposure, the call and the option, then receipt, call, tally.
 * Effects: `play.calls`, `play.scroll_results` and the receipt, all or nothing. A second lock of a
 * call that already has one, by another command, stands as the first and changes nothing. It is no
 * evidence, enqueues nothing, and no other module reads it (D-063).
 * Failure/retry: an exception rolls everything back; retrying with the same command ID is safe.
 */
export function makeLockCall(ports: PlayPorts) {
  return async (authority: PersonalAuthority, command: CallLockRequest): Promise<CallLockResult> => {
    const key: ReceiptKey = {
      commandId: command.commandId,
      operation: CALL_LOCK_OPERATION,
      // The recording generation is how the lock is stored, not what is asked: a retry after the
      // policy was read again is the same request.
      requestHash: ports.hash(CALL_LOCK_OPERATION, {
        assetId: command.assetId,
        revision: command.revision,
        stopId: command.stopId,
        option: command.option,
      }),
      outcomeVersion: OUTCOME_VERSION,
    };
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<CallLockResult> => {
      if ((await ports.fenceOwn(scope)).kind !== 'active') return refused('universe_unavailable');
      const receipt = receiptStep(await ports.findReceipt(scope, key));
      if (receipt.kind === 'refused') return refused(receipt.reason);
      if (receipt.kind === 'replay') {
        const play = await ports.store.readPlay(scope, command.assetId, command.revision);
        return saved(command, receipt.outcome, play, true);
      }
      const gate = await ports.fenceRecording(scope, command.recordingGeneration);
      if (gate.kind === 'paused' || gate.kind === 'stale')
        return {
          kind: 'not_saved',
          outcome: {
            recorded: false,
            reason: gate.kind === 'paused' ? 'recording_paused' : 'recording_generation_stale',
            currentGeneration: gate.currentGeneration,
          },
        };
      if (gate.kind !== 'recording') return refused('universe_unavailable');
      return recordLock(ports, gate.scope, key, command);
    });
    if (entered.kind === 'entered') return entered.value;
    return refused(entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable');
  };
}

/** The lock itself, inside the recording gate: exposure, call, option, then the writes. */
async function recordLock(
  ports: PlayPorts,
  recording: RecordingScopeTx,
  key: ReceiptKey,
  command: CallLockRequest,
): Promise<CallLockResult> {
  const scope = recording.personal;
  if (!(await ports.hasActivatedExposure(scope, command.assetId, command.revision)))
    return refused('exposure_required');
  const calls = await ports.readCalls(scope, command.assetId, command.revision);
  const call = calls?.find((candidate) => candidate.stopId === command.stopId && candidate.kind === 'call_it');
  if (call === undefined) return refused('call_not_found');
  const judgement = judgePick(call, command.option);
  if (judgement.kind === 'option_out_of_range') return refused('option_invalid');

  await ports.insertReceipt(scope, key);
  const before = await ports.store.readPlay(scope, command.assetId, command.revision);
  const standing = before.calls.find((candidate) => candidate.stopId === command.stopId);
  if (standing !== undefined) return completed(ports, scope, command, { ...standing, newlyLocked: false }, before);

  const lock: StoredCall = { stopId: command.stopId, option: command.option, correct: judgement.correct };
  const tally = afterLock(before.tally, lock.correct);
  await ports.store.insertCall(
    recording,
    { ...lock, assetId: command.assetId, revision: command.revision, commandId: command.commandId },
    tally,
  );
  return completed(ports, scope, command, { ...lock, newlyLocked: true }, { calls: [...before.calls, lock], tally });
}

/** Keeps the outcome on the receipt and answers it. */
async function completed(
  ports: PlayPorts,
  scope: PersonalScopeTx,
  command: CallLockRequest,
  outcome: StoredOutcome,
  play: StoredPlay,
): Promise<CallLockResult> {
  await ports.completeReceipt(scope, command.commandId, { ...outcome });
  return saved(command, outcome, play, false);
}

export type LockCall = ReturnType<typeof makeLockCall>;
