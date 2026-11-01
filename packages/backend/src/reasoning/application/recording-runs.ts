import type { PersonalAuthority, PersonalScopeTx, RecordingScopeTx } from '../../modules/identity/public.js';
import type { RecordingReasoningHarness } from './personal-recording.js';
import type { PersonalRecordingPurpose, StepOwnerModule } from './ports.js';
import type { ProposeInput, ProposeOutcome } from './propose.js';

/**
 * What a module needs to run a model step for one of a person's records under their recording generation (D-264, D-270).
 *
 * A step stamps its run with the generation the person is at when it starts, runs the model outside every transaction, and
 * stores its result in the transaction that closes the run, under the same fence. A pause, a resume or a Clear while the model
 * is working ends the run: a late reply is paid for and dropped, and nothing is written into the new generation. The engine
 * does not name any module's steps; each module names its own and checks, in its owner check, that the record is still the
 * one the step was made for.
 */

/** The person's own record a run serves, and the recording generation the run started at. */
export interface RunOwner {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  /** The request, draft, ask or answer the run serves; the module's owner check finds the record by it. */
  readonly recordId: string;
  /** The generation recording was at when the step started. Every private read and write of the run is held to it. */
  readonly recordingGeneration: number;
}

/**
 * A run that was started: the proof it ran under, which closes it later, and how it ended. `end` is absent when an attempt may
 * have reached the provider; the run then stays open for an operator and is never resent.
 */
export interface StartedRun {
  readonly runId: string;
  readonly purpose: PersonalRecordingPurpose;
  readonly end?: 'completed' | 'failed' | 'cancelled';
}

/** A proposal for one of a module's steps that run under the recording fence. */
export type StepProposal<T> = ProposeInput<T> & { readonly run: { readonly ownerModule: StepOwnerModule } };

/**
 * Who a step runs for: the account whose universe the scope is, and the generation recording is at now. Nothing when
 * recording is paused or the owner is not active, and then the step does not start a run. Call it in the transaction that reads
 * what the step needs, once per scope (it takes the scope's one account gate).
 */
export async function startRunOwner(
  harness: RecordingReasoningHarness,
  scope: PersonalScopeTx,
  recordId: string,
): Promise<RunOwner | undefined> {
  const current = await harness.currentOwner(scope);
  if (current === undefined) return undefined;
  return {
    accountId: current.accountId,
    universeId: scope.authority.universeId,
    privacyEpoch: scope.authority.privacyEpoch,
    recordId,
    recordingGeneration: current.generation,
  };
}

/**
 * The whole proof of one run. A module has no frozen owner context of its own here, so the context the model is sent is also
 * the context the proof names: `digest` is the harness's digest of it (`contextDigest`) and stands for both hashes. Pure.
 */
export function purposeOf(
  ownerModule: StepOwnerModule,
  owner: RunOwner,
  purpose: string,
  runId: string,
  digest: string,
): PersonalRecordingPurpose {
  return {
    version: 'personal-role-purpose.v1',
    accountId: owner.accountId,
    universeId: owner.universeId,
    privacyEpoch: owner.privacyEpoch,
    ownerModule,
    purpose,
    businessRunId: runId,
    recordingGeneration: owner.recordingGeneration,
    contextSha256: digest,
    modelContextSha256: digest,
    claimId: owner.recordId,
  };
}

/**
 * Runs one model proposal at the owner's generation, outside every transaction. Every private read and write of the run is
 * refused, and a reservation not yet sent is released, once recording is no longer at that generation (a pause, a resume, a
 * Clear): the outcome is then `refused`. Returns the proof with the outcome so the step that applies it can close the run.
 */
export async function proposeAtGeneration<T>(
  harness: RecordingReasoningHarness,
  owner: RunOwner,
  input: StepProposal<T>,
  signal: AbortSignal,
): Promise<{ readonly outcome: ProposeOutcome<T>; readonly purpose: PersonalRecordingPurpose }> {
  const purpose = purposeOf(
    input.run.ownerModule,
    owner,
    input.run.purpose,
    input.run.id,
    harness.contextDigest(input.context),
  );
  const outcome = await harness.proposePersonal({ ...input, recordingPurpose: purpose }, signal);
  return { outcome, purpose };
}

/**
 * Like {@link proposeAtGeneration}, for a step that found no owner to run for (recording is paused): no run is started and no
 * model is called, and the outcome is the refusal a step already handles. Nothing is written, so there is no proof to close.
 */
export async function proposeWhenRecording<T>(
  harness: RecordingReasoningHarness,
  owner: RunOwner | undefined,
  input: StepProposal<T>,
  signal: AbortSignal,
): Promise<{ readonly outcome: ProposeOutcome<T>; readonly purpose?: PersonalRecordingPurpose }> {
  if (owner === undefined) return { outcome: { kind: 'refused', reason: 'scope_refused' } };
  return proposeAtGeneration(harness, owner, input, signal);
}

/** The run to close with a step's result: only a run that was started and has a conclusive end. */
export function runToClose(
  runId: string,
  purpose: PersonalRecordingPurpose | undefined,
  end: StartedRun['end'],
): StartedRun | undefined {
  return purpose === undefined || end === undefined ? undefined : { runId, purpose, end };
}

/** Closes a started run in the transaction that applies its result; a run with no conclusive end stays open. */
export async function closeStartedRun(
  harness: RecordingReasoningHarness,
  scope: RecordingScopeTx,
  run: StartedRun,
): Promise<void> {
  if (run.end === undefined) return;
  await harness.closePersonalRun(scope, {
    runId: run.runId,
    state: run.end,
    recordingPurpose: run.purpose,
  });
}

/**
 * Closes one started run in a transaction of its own. A transaction closes one personal run, so the second and later runs of a
 * request close this way. When the generation or the record has moved on the close is refused and the run is left open; the
 * ledger's idle sweep closes it.
 */
export async function closeStartedRunAlone(
  harness: RecordingReasoningHarness,
  authority: PersonalAuthority,
  run: StartedRun,
): Promise<void> {
  if (run.end === undefined) return;
  await harness.withPersonalApply(authority, run.purpose, (scope) => closeStartedRun(harness, scope, run));
}

/**
 * Applies a step's result and closes its run in one transaction, under the recording fence. `dropped` means the fence no
 * longer holds (the person paused, resumed or cleared, or the module's owner check found the record gone): nothing was
 * applied and the run is left open for the ledger's idle sweep. The caller then writes only the end of what was asked, in a
 * transaction of its own.
 */
export async function applyClosingRun<T>(
  harness: RecordingReasoningHarness,
  authority: PersonalAuthority,
  run: StartedRun,
  apply: (scope: PersonalScopeTx) => Promise<T>,
): Promise<{ readonly kind: 'applied'; readonly value: T } | { readonly kind: 'dropped' }> {
  const applied = await harness.withPersonalApply(authority, run.purpose, async (scope) => {
    await closeStartedRun(harness, scope, run);
    return apply(scope.personal);
  });
  return applied.kind === 'entered' ? { kind: 'applied', value: applied.value } : { kind: 'dropped' };
}
