import { canonicalSha256 } from '@knowscroll/scroll-model';
import type {
  PersonalRecordingPurpose,
  ProposeInput,
  ProposeOutcome,
  ReasoningContext,
  RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import type { FenceOwnAccount, PersonalAuthority, PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';

/**
 * Supply's personal model runs follow the person's recording generation (D-264).
 *
 * A question's placement and library check and a Quick answer's writer and checks run on the recording-aware harness, not on the
 * compatibility harness that works only at the first generation. Each run is stamped with the generation its record (the
 * request or the Quick answer) was made at, and every private read and write of the run is fenced to it: a person who paused and
 * resumed gets answers, and a run that was in flight across a pause or a Clear writes nothing into the new generation.
 */

/** The person's own record a group of runs serves, and the recording generation that record was made at. */
export interface RunOwner {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  /** The request or Quick answer; the owner check (`check-recording-run.ts`) finds the record by it. */
  readonly recordId: string;
  /** What the create transaction checked against the person's root: the generation the record belongs to. */
  readonly recordingGeneration: number;
}

/**
 * The steps of Supply's that run under the recording fence: a question's placement and library check, and a Quick answer's
 * writer and checks. The same list is in migration 0094 and in the owner check.
 */
export type SupplyRunPurpose = 'ask-scope' | 'ask-library' | 'quick-answer' | 'quick-answer-support';

/** What a worker needs to run Supply's steps under the recording fence. */
export interface RecordingRuns {
  readonly harness: RecordingReasoningHarness;
  /** Takes the one account gate of a scope, to learn whose universe it is. */
  readonly fenceOwn: FenceOwnAccount;
}

/** A proposal for one of Supply's runs: its purpose is one the recording harness knows. */
export type SupplyProposal<T> = ProposeInput<T> & {
  readonly run: { readonly ownerModule: 'supply'; readonly purpose: SupplyRunPurpose };
};

/**
 * A run that was started: the proof it ran under, which closes it later, and how it ended. `end` is absent when an attempt may
 * have reached the provider; the run then stays open for an operator and is never resent.
 */
export interface StartedRun {
  readonly runId: string;
  readonly purpose: PersonalRecordingPurpose;
  readonly end?: 'completed' | 'failed' | 'cancelled';
}

/** The hash the recording harness binds a run to: of exactly the bundle reference and the items it sends. */
const contextDigest = (context: ReasoningContext): string =>
  canonicalSha256({
    bundleRef: context.bundleRef,
    items: context.items.map(({ ref, kind, text }) => ({ ref, kind, text })),
  });

/**
 * The whole proof of one run. Supply has no frozen owner context of its own, so the context the model is sent is also the
 * context the proof names. Pure.
 */
export function purposeOf(
  owner: RunOwner,
  purpose: SupplyRunPurpose,
  runId: string,
  context: ReasoningContext,
): PersonalRecordingPurpose {
  const digest = contextDigest(context);
  return {
    version: 'personal-role-purpose.v1',
    accountId: owner.accountId,
    universeId: owner.universeId,
    privacyEpoch: owner.privacyEpoch,
    ownerModule: 'supply',
    purpose,
    businessRunId: runId,
    recordingGeneration: owner.recordingGeneration,
    contextSha256: digest,
    modelContextSha256: digest,
    claimId: owner.recordId,
  };
}

/**
 * Runs one model proposal under the record's generation, outside every transaction. Every private read and write of the run
 * is refused, and a reservation not yet sent is released, once the person's recording generation is no longer the record's
 * (a pause, a resume, a Clear): the outcome is then `refused`. Returns the proof with the outcome so the step that applies it
 * can close the run.
 */
export async function proposeAtGeneration<T>(
  harness: RecordingReasoningHarness,
  owner: RunOwner,
  input: SupplyProposal<T>,
  signal: AbortSignal,
): Promise<{ readonly outcome: ProposeOutcome<T>; readonly purpose: PersonalRecordingPurpose }> {
  const purpose = purposeOf(owner, input.run.purpose, input.run.id, input.context);
  const outcome = await harness.proposePersonal({ ...input, recordingPurpose: purpose }, signal);
  return { outcome, purpose };
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

/** The account whose universe the scope is, or nothing when the owner is not active. Takes the one account gate of the scope. */
export async function accountOf(fenceOwn: FenceOwnAccount, scope: PersonalScopeTx): Promise<string | undefined> {
  const own = await fenceOwn(scope);
  return own.kind === 'active' ? own.owner.accountId : undefined;
}
