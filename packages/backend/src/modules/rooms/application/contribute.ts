import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type { ReasoningHarness } from '../../../reasoning/public.js';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
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
import type { AiRequestRow, RoomPorts } from './ports.js';

/** The harness refuses with this fixed message when a run can no longer be closed legitimately. */
const HARNESS_REFUSAL = 'PERSONAL_REASONING_AUTHORITY_REFUSED';

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
    standing.room.inhabitants.includes(request.inhabitant) &&
    discussion !== undefined;
  return { request, lock, standing, discussion, allowed };
}

/**
 * One ask of an AI inhabitant becomes at most one labelled message (blueprint §15 "AI inhabitant"
 * role). The person who asked is a member whose universe and epoch the job names.
 *
 * Steps: (1) one transaction rechecks authority, reads this room's own discussion and reduces it to
 * the bounded context; (2) outside any transaction the harness makes one model call (plus at most
 * one repair) on the ask's own run; (3) one transaction rechecks the asker is still a member of an
 * open room, stores the message with its provenance (role and prompt versions, model, attempt)
 * and closes the run. Nothing is stored when authority is gone: a member who left or was removed,
 * a paused room or a Clear cancels the contribution even if the model had finished.
 *
 * Failure/retry: the run ID is the request ID, so a redelivery answers from the ledger and never
 * pays twice; an attempt of unknown outcome is never resent: the ask ends as failed and the run
 * stays open for an operator. The contribution is a suggestion in words: nothing here starts
 * production, and an inhabitant never writes unless a member's ask is queued.
 */
export function makeContribute(p: ContributePorts, harness: ReasoningHarness): Contribute {
  return async (job, signal) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.contribute' },
    };
    const prepared = await p.withScope(authority, async (scope) => {
      if (!(await p.ownerActive(scope))) return undefined;
      const found = await standingAsk(p, scope, job.requestId);
      if (found === undefined) return undefined;
      if (!found.allowed || found.discussion === undefined) {
        // The authority went before any call: nothing reached the provider, so the ask is not counted.
        await p.ai.settle(found.lock, job.requestId, { state: 'failed', at: p.now(), dispatched: false });
        return undefined;
      }
      const material = await assembleMaterial(p, scope, found.lock, {
        request: found.request,
        standing: found.standing,
        discussion: found.discussion,
      });
      return { request: found.request, context: contributionContext(material) };
    });
    if (prepared.kind !== 'entered' || prepared.value === undefined) return;
    const { request, context } = prepared.value;

    const outcome = await harness.propose(
      {
        run: {
          id: request.requestId,
          authority,
          ownerModule: 'rooms',
          purpose: 'inhabitant-contribution',
          policyVersion: INHABITANT_POLICY_VERSION,
        },
        role: inhabitantRole(request.inhabitant),
        context,
        limits: { allowRepair: true },
      },
      signal,
    );
    await applyVerdict(p, harness, authority, request, contributionVerdict(outcome));
  };
}

/** Closes the run and, when the asker is still allowed, stores the message; otherwise settles the ask without one. */
async function applyVerdict(
  p: ContributePorts,
  harness: ReasoningHarness,
  authority: PersonalAuthority,
  request: AiRequestRow,
  verdict: ContributionVerdict,
): Promise<void> {
  await p.withScope(authority, async (scope) => {
    if (verdict.end) {
      try {
        await harness.closeRun(scope, { runId: request.requestId, state: verdict.end });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== HARNESS_REFUSAL) throw error;
      }
    }
    if (!(await p.ownerActive(scope))) return;
    const found = await standingAsk(p, scope, request.requestId);
    if (found === undefined) return;
    const at = p.now();
    if (verdict.kind !== 'contribution' || !found.allowed) {
      // An answer the asker is no longer allowed to have (they left, the room paused) is dropped, but the
      // model was called: the ask stays counted. Only an ask that never reached the provider is refunded.
      await p.ai.settle(found.lock, request.requestId, {
        state: verdict.kind === 'nothing_to_add' && found.allowed ? 'declined' : 'failed',
        at,
        dispatched: verdict.kind === 'failed' ? verdict.dispatched : true,
      });
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
    await p.ai.settle(found.lock, request.requestId, {
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
  });
}
