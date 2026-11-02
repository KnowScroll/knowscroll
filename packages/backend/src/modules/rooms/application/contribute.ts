import {
  HARNESS_PROMPT_VERSION,
  applyClosingRun,
  closeStartedRunAlone,
  proposeWhenRecording,
  runOwnerOf,
  runToClose,
  type RecordingReasoningHarness,
  type RunOwner,
} from '../../../reasoning/public.js';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { ANSWER_SUPPORT_POLICY, NOT_COVERED_LINE } from '../domain/answer-support.js';
import { pointedKind } from '../domain/asks.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import type { ContributeJob } from '../events.js';
import { aboutText, type ReadGround } from './answer-ground.js';
import { answerAndCheck, endOf, type AnswerModel, type ModelRun, type PipelineResult } from './answer-pipeline.js';
import { assembleMaterial } from './inhabitant-context.js';
import {
  INHABITANT_POLICY_VERSION,
  INHABITANT_ROLE_VERSION,
  inhabitantRole,
  type ContributionMaterial,
} from './inhabitant-role.js';
import { hasResident, type AiTurnRow, type RoomPorts, type RoomRow } from './ports.js';
import { unpostedOutcome } from './turn-outcome.js';

/** The worker's consumer of `rooms.contribute`. */
export type Contribute = (job: ContributeJob, signal: AbortSignal) => Promise<void>;

export interface ContributePorts extends RoomPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
  /** The model the worker is configured for; recorded on every contribution. */
  readonly model: string;
  /** The library passages an answer may rest on, read outside any transaction (D-301). */
  readonly readGround: ReadGround;
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

/** What step 1 hands on: the ask, the bounded material, the room's topic and whom the run is for (none while recording is paused). */
interface Prepared {
  readonly request: AiTurnRow;
  readonly material: ContributionMaterial;
  readonly topic: RoomRow['topic'];
  readonly owner: RunOwner | undefined;
}

/**
 * Step 1, in one transaction: recheck that the ask still stands, reduce this room's own discussion to the bounded material and
 * learn the generation the asker's recording is at. An ask that cannot be answered ends here without a call.
 */
async function prepare(
  p: ContributePorts,
  harness: RecordingReasoningHarness,
  scope: PersonalScopeTx,
  requestId: string,
): Promise<Prepared | undefined> {
  if (!(await p.ownerActive(scope))) return undefined;
  const found = await standingAsk(p, scope, requestId);
  if (found === undefined) return undefined;
  if (!found.allowed || found.discussion === undefined) {
    // The authority went before any call: nothing reached the provider, so the ask is not counted.
    await p.ai.settle(found.lock, requestId, { state: 'failed', at: p.now(), dispatched: false });
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
    await p.ai.settle(found.lock, requestId, { state: 'failed', at: p.now(), dispatched: false });
    return undefined;
  }
  // The asker is the ask's own account (the job names their universe), so only the generation is read.
  const askerId = found.request.requestedByAccountId;
  const owner = askerId === null ? undefined : await runOwnerOf(harness, scope, found.request.turnId, askerId);
  return { request: found.request, material, topic: found.standing.room.topic, owner };
}

/** One call on the recording-aware harness, stamped with the generation the asker's recording was at (D-270). */
function recordingModel(
  harness: RecordingReasoningHarness,
  owner: RunOwner,
  authority: PersonalAuthority,
): AnswerModel {
  return async (call, signal) => {
    const { outcome, purpose } = await proposeWhenRecording(
      harness,
      owner,
      {
        run: {
          id: call.runId,
          authority,
          ownerModule: 'rooms',
          // Every step of an answer is this one step to the recording proof; the runs differ by their IDs.
          purpose: 'inhabitant-contribution',
          policyVersion: INHABITANT_POLICY_VERSION,
        },
        role: call.role,
        context: call.context,
        limits: { allowRepair: call.allowRepair },
      },
      signal,
    );
    return { outcome, run: { runId: call.runId, ...(purpose === undefined ? {} : { purpose }), end: endOf(outcome) } };
  };
}

/**
 * Step 2, outside every transaction: the passages for the question (shared library content, chosen by code), then the writer, the
 * figure rule and the support check, and at most one rewrite. While the asker's recording is paused nothing is read or asked and
 * the ask ends as failed, not counted. When no passage of the library fits the question no model is asked: the resident says so.
 */
async function answer(
  p: ContributePorts,
  harness: RecordingReasoningHarness,
  authority: PersonalAuthority,
  prepared: Prepared,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const { request, material, topic, owner } = prepared;
  if (owner === undefined) return { verdict: { kind: 'failed', dispatched: false }, support: undefined, runs: [] };
  const ground = await p.readGround(topic, aboutText(material));
  if (ground.length === 0)
    return {
      verdict: { kind: 'not_covered' },
      support: { policy: ANSWER_SUPPORT_POLICY, result: 'no_ground', cited: [], flagged: [] },
      runs: [],
    };
  return answerAndCheck(
    recordingModel(harness, owner, authority),
    {
      origin: 'asked',
      turnId: request.turnId,
      material,
      ground,
      writer: inhabitantRole(
        request.inhabitant,
        ground.map((passage) => passage.handle),
        pointedKind(request.askKind),
      ),
      idFor: p.idFor,
    },
    signal,
  );
}

/**
 * One ask of an AI inhabitant becomes at most one labelled message (blueprint §15 "AI inhabitant"
 * role). The person who asked is a member whose universe and epoch the job names. A pointed ask or a mention reads
 * the message it is about as the turn's focus; if that message is gone or kept out, the ask ends without a call.
 *
 * An answer that states a fact rests on library passages chosen by code for the room and the question, and is posted only after
 * it passed the shared support check (D-301). Steps: (1) one transaction rechecks authority, reads this room's own discussion and
 * reduces it to the bounded context, and learns the generation the asker's recording is at; (2) outside any transaction the
 * passages are read and chosen, and the recording-aware harness makes the writer's call (one repair), the check of its answer (one
 * repair) and, when a sentence is flagged, one rewrite and its check, at most `ANSWER_PAID_ATTEMPTS` paid attempts in all, each on
 * its own run at that generation (D-270); (3) one transaction under the recording fence rechecks the asker is still a member of an
 * open room, stores the message with its provenance (role and prompt versions, model, attempt, how the answer came out) and closes
 * the writer's run. Nothing is stored when authority is gone: a member who left or was removed, a paused room, or an asker who
 * paused, resumed or cleared their recording cancels the contribution even if the model had finished. While the asker's recording
 * is paused no call is made and the ask ends as failed, not counted.
 *
 * The words a resident posts are the model's only when every sentence passed. When the library does not support an answer, or
 * covers nothing of the question, the message is `NOT_COVERED_LINE`, code's own words. A step that failed, was refused or left no
 * usable check posts nothing and the ask ends as failed.
 *
 * Failure/retry: every run's ID is derived from the ask's, so a redelivery answers from the ledger and never pays twice; an
 * attempt of unknown outcome is never resent: the ask ends as failed and the run stays open for an operator. The contribution is
 * a suggestion in words: nothing here starts production, and an inhabitant never writes unless a member's ask is queued.
 */
export function makeContribute(p: ContributePorts, harness: RecordingReasoningHarness): Contribute {
  return async (job, signal) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.contribute' },
    };
    const prepared = await p.withScope(authority, (scope) => prepare(p, harness, scope, job.requestId));
    if (prepared.kind !== 'entered' || prepared.value === undefined) return;
    const result = await answer(p, harness, authority, prepared.value, signal);
    await applyResult(p, harness, authority, prepared.value.request, result);
  };
}

/** What an ask ends as when the recording fence refused its result: the model was called, so the ask stays counted. */
const FENCE_REFUSED: PipelineResult = {
  verdict: { kind: 'failed', dispatched: true },
  support: undefined,
  runs: [],
};

/** Closes one run that is not the writer's, in a transaction of its own, while the ask is still queued for its owner check. */
async function closeAlone(
  harness: RecordingReasoningHarness,
  authority: PersonalAuthority,
  run: ModelRun,
): Promise<void> {
  const closing = runToClose(run.runId, run.purpose, run.end);
  if (closing !== undefined) await closeStartedRunAlone(harness, authority, closing);
}

/**
 * Closes the runs and, when the asker is still allowed, stores the message. The checks' and the rewrite's runs close first, each in
 * its own transaction and while the ask is still queued (a transaction closes one personal run, and the owner check is current only
 * for a queued ask); the writer's run closes in the transaction that stores the message, under the recording fence. A run with no
 * conclusive end settles in a plain one. When the fence no longer holds (the asker paused, resumed or cleared) the answer is dropped
 * and the ask ends without one. A delivery that dies between a check's close and the store finds the check closed on redelivery,
 * which is an unchecked answer: nothing is posted and the ask stays counted.
 */
async function applyResult(
  p: ContributePorts,
  harness: RecordingReasoningHarness,
  authority: PersonalAuthority,
  request: AiTurnRow,
  result: PipelineResult,
): Promise<void> {
  const [writer, ...others] = result.runs;
  for (const run of others) await closeAlone(harness, authority, run);
  const closing = writer === undefined ? undefined : runToClose(writer.runId, writer.purpose, writer.end);
  if (closing === undefined) {
    await p.withScope(authority, (scope) => settle(p, scope, request, result));
    return;
  }
  const applied = await applyClosingRun(harness, authority, closing, (scope) => settle(p, scope, request, result));
  if (applied.kind === 'dropped') await p.withScope(authority, (scope) => settle(p, scope, request, FENCE_REFUSED));
}

/** Stores the message when the asker is still allowed, otherwise settles the ask without one; inside the caller's transaction. */
async function settle(
  p: ContributePorts,
  scope: PersonalScopeTx,
  request: AiTurnRow,
  result: PipelineResult,
): Promise<void> {
  if (!(await p.ownerActive(scope))) return;
  const found = await standingAsk(p, scope, request.turnId);
  if (found === undefined) return;
  const at = p.now();
  const { verdict } = result;
  if ((verdict.kind !== 'post' && verdict.kind !== 'not_covered') || !found.allowed) {
    // An answer the asker is no longer allowed to have (they left, the room paused) is dropped, but the
    // model was called: the ask stays counted. Only an ask that never reached the provider is refunded.
    await p.ai.settle(found.lock, request.turnId, unpostedOutcome(result, found.allowed, at));
    return;
  }
  const messageId = p.newId();
  await p.discussions.append(found.lock, request.discussionId, {
    kind: 'ai',
    messageId,
    inhabitant: request.inhabitant,
    // The line that says the library does not cover it explains why there is no answer, whichever resident was asked.
    aiKind: verdict.kind === 'post' ? verdict.answer.kind : 'explanation',
    text: verdict.kind === 'post' ? verdict.answer.text : NOT_COVERED_LINE,
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
    ...(result.support === undefined ? {} : { support: result.support }),
  });
  // The room's members read the new message within seconds, not at the next poll.
  await p.rooms.announce(found.lock, at);
}
