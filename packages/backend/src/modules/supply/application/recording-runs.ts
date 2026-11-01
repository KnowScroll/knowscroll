import {
  closeStartedRun,
  closeStartedRunAlone,
  proposeAtGeneration as proposeStep,
  purposeOf as stampPurpose,
  type PersonalRecordingPurpose,
  type ProposeInput,
  type ProposeOutcome,
  type RecordingReasoningHarness,
  type RunOwner,
  type StartedRun,
} from '../../../reasoning/public.js';
import type { FenceOwnAccount, PersonalScopeTx } from '../../identity/public.js';

/**
 * Supply's personal model runs follow the person's recording generation (D-264).
 *
 * A question's placement and library check and a Quick answer's writer and checks run on the recording-aware harness, not on the
 * compatibility harness that works only at the first generation. Each run is stamped with the generation its record (the
 * request or the Quick answer) was made at, and every private read and write of the run is fenced to it: a person who paused and
 * resumed gets answers, and a run that was in flight across a pause or a Clear writes nothing into the new generation. A
 * free-text match is stamped with the generation recording is at when its step starts (D-268), because that ask carries none.
 * The mechanics are the reasoning engine's (`recording-runs.ts` there); this file names Supply's steps.
 */

export { closeStartedRun, closeStartedRunAlone };
export type { RunOwner, StartedRun };

/**
 * The steps of Supply's that run under the recording fence: a question's placement and library check, a free-text match, and a
 * Quick answer's writer and checks. The same list is in migrations 0096 and 0097 and in the owner check.
 */
export type SupplyRunPurpose = 'ask-scope' | 'ask-library' | 'match-request' | 'quick-answer' | 'quick-answer-support';

/** What a worker needs to run Supply's steps under the recording fence. */
export interface RecordingRuns {
  readonly harness: RecordingReasoningHarness;
  /** Takes the one account gate of a scope, to learn whose universe it is. */
  readonly fenceOwn: FenceOwnAccount;
}

/** A proposal for one of Supply's steps that run under the recording fence. */
export type SupplyProposal<T> = ProposeInput<T> & {
  readonly run: { readonly ownerModule: 'supply'; readonly purpose: SupplyRunPurpose };
};

/** The whole proof of one Supply run; the context the model is sent is also the context the proof names. Pure. */
export function purposeOf(
  owner: RunOwner,
  purpose: SupplyRunPurpose,
  runId: string,
  digest: string,
): PersonalRecordingPurpose {
  return stampPurpose('supply', owner, purpose, runId, digest);
}

/** Runs one Supply proposal at the record's generation, outside every transaction (see the reasoning engine's `proposeAtGeneration`). */
export function proposeAtGeneration<T>(
  harness: RecordingReasoningHarness,
  owner: RunOwner,
  input: SupplyProposal<T>,
  signal: AbortSignal,
): Promise<{ readonly outcome: ProposeOutcome<T>; readonly purpose: PersonalRecordingPurpose }> {
  return proposeStep(harness, owner, input, signal);
}

/** The account whose universe the scope is, or nothing when the owner is not active. Takes the one account gate of the scope. */
export async function accountOf(fenceOwn: FenceOwnAccount, scope: PersonalScopeTx): Promise<string | undefined> {
  const own = await fenceOwn(scope);
  return own.kind === 'active' ? own.owner.accountId : undefined;
}
