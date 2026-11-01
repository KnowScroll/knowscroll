import {
  HARNESS_PROMPT_VERSION,
  applyClosingRun,
  proposeWhenRecording,
  runToClose,
  startRunOwner,
  type PersonalRecordingPurpose,
  type RecordingReasoningHarness,
} from '../../../reasoning/public.js';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { pointedKind } from '../domain/asks.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import type { ContributeJob } from '../events.js';
import { assembleMaterial } from './inhabitant-context.js';
import {
  INHABITANT_POLICY_VERSION,
  INHABITANT_ROLE_VERSION,
  contributionContext,
  contributionVerdict,
  inhabitantRole,
  type ContributionVerdict,
} from './inhabitant-role.js';
import { hasResident, type AiTurnRow, type RoomPorts } from './ports.js';
import { unpostedOutcome } from './turn-outcome.js';

/** The worker's consumer of `rooms.contribute`. */
export type Contribute = (job: ContributeJob, signal: AbortSignal) => Promise<void>;

export interface ContributePorts extends RoomPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
  /** The model the worker is configured for; recorded on every contribution. */
  readonly model: string;
}

/**
 * The ask a worker may still act on: queued, by a member who is still in an open room, about a
 * discussion that exists. Anything else ends the ask without a message.
 */
async function standingAsk(p: ContributePorts, scope: PersonalScopeTx, requestId: string) {
  const request = await p.ai.forJob(scope, requestId);
  if (request?.state !== 'queued' || request.requestedByAccountId === null) return undefined;
  const lock = await p.rooms.lock(scope, request.roomId, 'read');
  if (!lock) return undefined;
  const standing = await p.rooms.standing(lock, request.requestedByAccountId);
  const discussion = await p.discussions.load(lock, request.discussionId);
  const allowed =
    standing.own?.endedBy === null &&
    roomAcceptsPosts(standing.room.status) &&
    hasResident(standing.room, request.inhabitant) &&
    discussion !== undefined;
  return { request, lock, standing, discussion, allowed };
}

/**
 * One ask of an AI inhabitant becomes at most one labelled message (blueprint §15 "AI inhabitant"
 * role). The person who asked is a member whose universe and epoch the job names. A pointed ask or a mention reads
 * the message it is about as the turn's focus; if that message is gone or kept out, the ask ends without a call.
 *
 * Steps: (1) one transaction rechecks authority, reads this room's own discussion and reduces it to
 * the bounded context, and learns the generation the asker's recording is at; (2) outside any transaction the
 * recording-aware harness makes one model call (plus at most one repair) on the ask's own run, at that generation (D-270);
 * (3) one transaction under the recording fence rechecks the asker is still a member of an open room, stores the message with
 * its provenance (role and prompt versions, model, attempt) and closes the run. Nothing is stored when authority is gone: a
 * member who left or was removed, a paused room, or an asker who paused, resumed or cleared their recording cancels the
 * contribution even if the model had finished. While the asker's recording is paused no call is made and the ask ends as
 * failed, not counted.
 *
 * Failure/retry: the run ID is the request ID, so a redelivery answers from the ledger and never
 * pays twice; an attempt of unknown outcome is never resent: the ask ends as failed and the run
 * stays open for an operator. The contribution is a suggestion in words: nothing here starts
 * production, and an inhabitant never writes unless a member's ask is queued.
 */
export function makeContribute(p: ContributePorts, harness: RecordingReasoningHarness): Contribute {
  return async (job, signal) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.contribute' },
    };
    const prepared = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      // The account gate comes before any room row is locked.
      const owner = await startRunOwner(harness, scope, job.requestId);
      const found = await standingAsk(p, scope, job.requestId);
      if (found === undefined) return undefined;
      if (!found.allowed || found.discussion === undefined) {
        // The authority went before any call: nothing reached the provider, so the ask is not counted.
        await p.ai.settle(found.lock, job.requestId, { state: 'failed', at: p.now(), dispatched: false });
        return undefined;
      }
      const material = await assembleMaterial(p, scope, found.lock, {
        turn: found.request,
        room: found.standing.room,
        discussion: found.discussion,
        ...(found.request.causeMessageId === null ? {} : { focus: found.request.causeMessageId }),
      });
      if (found.request.causeMessageId !== null && material.focus === undefined) {
        // The message the ask pointed at is gone, or its author keeps messages out: there is nothing to answer, and no
        // call was made, so the ask is not counted.
        await p.ai.settle(found.lock, job.requestId, { state: 'failed', at: p.now(), dispatched: false });
        return undefined;
      }
      return { request: found.request, context: contributionContext(material), owner };
    });
    if (prepared.kind !== 'entered' || prepared.value === undefined) return;
    const { request, context, owner } = prepared.value;

    const { outcome, purpose } = await proposeWhenRecording(
      harness,
      owner,
      {
        run: {
          id: request.turnId,
          authority,
          ownerModule: 'rooms',
          purpose: 'inhabitant-contribution',
          policyVersion: INHABITANT_POLICY_VERSION,
        },
        role: inhabitantRole(request.inhabitant, pointedKind(request.askKind)),
        context,
        limits: { allowRepair: true },
      },
      signal,
    );
    await applyVerdict(p, harness, authority, request, contributionVerdict(outcome), purpose);
  };
}

/** What an ask ends as when the recording fence refused its result: the model was called, so the ask stays counted. */
const FENCE_REFUSED: ContributionVerdict = { kind: 'failed', dispatched: true };

/**
 * Closes the run and, when the asker is still allowed, stores the message, in one transaction under the recording fence; a run
 * with no conclusive end settles in a plain one. When the fence no longer holds (the asker paused, resumed or cleared) the
 * answer is dropped and the ask ends without one.
 */
async function applyVerdict(
  p: ContributePorts,
  harness: RecordingReasoningHarness,
  authority: PersonalAuthority,
  request: AiTurnRow,
  verdict: ContributionVerdict,
  purpose: PersonalRecordingPurpose | undefined,
): Promise<void> {
  const closing = runToClose(request.turnId, purpose, verdict.end);
  if (closing === undefined) {
    await p.withScope(authority, (scope) => settle(p, scope, request, verdict));
    return;
  }
  const applied = await applyClosingRun(harness, authority, closing, (scope) => settle(p, scope, request, verdict));
  if (applied.kind === 'dropped') await p.withScope(authority, (scope) => settle(p, scope, request, FENCE_REFUSED));
}

/** Stores the message when the asker is still allowed, otherwise settles the ask without one; inside the caller's transaction. */
async function settle(
  p: ContributePorts,
  scope: PersonalScopeTx,
  request: AiTurnRow,
  verdict: ContributionVerdict,
): Promise<void> {
  if (!(await p.ownerActive(scope))) return;
  const found = await standingAsk(p, scope, request.turnId);
  if (found === undefined) return;
  const at = p.now();
  if (verdict.kind !== 'contribution' || !found.allowed) {
    // An answer the asker is no longer allowed to have (they left, the room paused) is dropped, but the
    // model was called: the ask stays counted. Only an ask that never reached the provider is refunded.
    await p.ai.settle(found.lock, request.turnId, unpostedOutcome(verdict, found.allowed, at));
    return;
  }
  const messageId = p.newId();
  await p.discussions.append(found.lock, request.discussionId, {
    kind: 'ai',
    messageId,
    inhabitant: request.inhabitant,
    aiKind: verdict.answer.kind,
    text: verdict.answer.text,
    recordedAt: at,
  });
  await p.ai.settle(found.lock, request.turnId, {
    state: 'completed',
    at,
    messageId,
    provenance: {
      roleVersion: INHABITANT_ROLE_VERSION,
      promptVersion: HARNESS_PROMPT_VERSION,
      model: p.model,
      attemptId: verdict.attemptId,
    },
  });
  // The room's members read the new message within seconds, not at the next poll.
  await p.rooms.announce(found.lock, at);
}
