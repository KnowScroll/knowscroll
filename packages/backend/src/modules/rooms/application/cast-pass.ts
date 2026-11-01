import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type { ProductionAuthority, ProductionReasoningHarness, WithProductionScope } from '../../../reasoning/public.js';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { ANSWER_SUPPORT_POLICY } from '../domain/answer-support.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { WAITS } from '../domain/router.js';
import { looksOverstated, type SpeechTrigger } from '../domain/triggers.js';
import { CAST_PASS_ROUNDS, type CastPassJob } from '../events.js';
import { aboutText, type ReadGround } from './answer-ground.js';
import { answerAndCheck, endOf, type AnswerModel, type ModelRun, type PipelineResult } from './answer-pipeline.js';
import { queueCastDue } from './cast-schedule.js';
import { assembleMaterial } from './inhabitant-context.js';
import type { ContributionMaterial } from './inhabitant-role.js';
import {
  hasResident,
  type AiTurnRow,
  type DiscussionRow,
  type RoomLock,
  type RoomPorts,
  type RoomRow,
} from './ports.js';
import { RESIDENT_POLICY_VERSION, RESIDENT_ROLE_VERSION, residentRole } from './resident-role.js';
import { unpostedOutcome } from './turn-outcome.js';

/** The worker's consumer of `rooms.cast-pass`. */
export type CastPass = (job: CastPassJob, signal: AbortSignal) => Promise<void>;

export interface CastPassPorts extends RoomPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
  /** The model the worker is configured for; recorded on every contribution. */
  readonly model: string;
  /** The generation of the `rooms` root this worker works under. */
  readonly generation: number;
  /** The library passages an answer may rest on, read outside any transaction (D-298). */
  readonly readGround: ReadGround;
}

/** What step 1 hands on: the material for a call, or an answer already paid for, checked and held back while someone typed. */
type Prepared =
  | {
      readonly kind: 'call';
      readonly turn: AiTurnRow;
      readonly material: ContributionMaterial;
      readonly topic: RoomRow['topic'];
    }
  | { readonly kind: 'held'; readonly turn: AiTurnRow; readonly result: PipelineResult };

/** A turn the router allowed, and whether it is still wanted. */
interface Standing {
  readonly turn: AiTurnRow & { readonly trigger: SpeechTrigger; readonly causeMessageId: string };
  readonly room: RoomRow;
  readonly discussion: DiscussionRow;
  readonly wanted: boolean;
}

const isUnprompted = (turn: AiTurnRow): turn is Standing['turn'] =>
  turn.trigger !== 'asked' && turn.causeMessageId !== null;

/**
 * The queued unprompted turn a job names, with whether it is still wanted: the room takes posts, the resident is
 * still in the cast, the discussion and the message it answers are still there, its author has not since asked that
 * their messages be kept out of what AI reads, and nobody (a person other than its author, or an AI) has answered
 * that message meanwhile. Read under the room lock.
 */
async function standingTurn(p: RoomPorts, lock: RoomLock, turnId: string): Promise<Standing | undefined> {
  const turn = await p.ai.read(lock, turnId);
  if (turn?.state !== 'queued' || !isUnprompted(turn)) return undefined;
  const [room, discussion, cause] = await Promise.all([
    p.rooms.roomRow(lock),
    p.discussions.load(lock, turn.discussionId),
    p.discussions.messageById(lock, turn.discussionId, turn.causeMessageId),
  ]);
  // A turn's discussion cannot be deleted (the foreign key restricts it), so a missing one is a broken invariant.
  if (discussion === undefined) throw new Error('ROOMS_DISCUSSION_MISSING');
  const open = roomAcceptsPosts(room.status) && hasResident(room, turn.inhabitant);
  const author = cause?.authorAccountId ?? null;
  const keptOut = author === null ? false : (await p.rooms.keepOutAmong(lock, [author])).has(author);
  const after =
    open && cause !== undefined && !cause.hidden && !keptOut
      ? await p.cast.activityAfter(lock, turn.discussionId, cause.sequence, author)
      : undefined;
  return { turn, room, discussion, wanted: after !== undefined && after.byOthers === 0 && after.byAi === 0 };
}

/**
 * Step 1, in one transaction: recheck authority and that the turn is still wanted, and reduce the room to the
 * bounded material (keep-out substituted, no names). A turn that is no longer wanted ends here without a call. A turn
 * whose answer was already given, checked and held back while someone typed goes on as it is: nothing is built, read or asked
 * again (it would differ, and the ledger would refuse a changed request for a run that was already paid for).
 */
async function prepare(p: CastPassPorts, scope: PersonalScopeTx, job: CastPassJob): Promise<Prepared | undefined> {
  if (!p.residentsEnabled || !(await p.ownerActive(scope))) return undefined;
  const lock = await p.rooms.lock(scope, job.roomId, 'write');
  if (!lock) return undefined;
  const found = await standingTurn(p, lock, job.turnId);
  if (found === undefined) return undefined;
  const { turn, room, discussion } = found;
  if (turn.held !== null) return { kind: 'held', turn, result: heldResult(turn, turn.held) };
  const material = found.wanted
    ? await assembleMaterial(p, scope, lock, { turn, room, discussion, focus: turn.causeMessageId })
    : undefined;
  if (material?.focus === undefined) {
    // Nothing reached the provider: the turn is handed back, so it no longer counts against the caps.
    await p.ai.settle(lock, turn.turnId, { state: 'failed', at: p.now(), dispatched: false });
    return undefined;
  }
  return { kind: 'call', turn, material, topic: room.topic };
}

/**
 * The result of a turn whose answer is held: the answer that passed its checks, posted as it is. The writer's run is the only one
 * left to close, because the checks' runs were closed before the answer was held.
 */
function heldResult(turn: AiTurnRow, held: NonNullable<AiTurnRow['held']>): PipelineResult {
  return {
    verdict: { kind: 'post', answer: { kind: held.kind, text: held.text }, attemptId: held.attemptId },
    support: held.support,
    runs: [{ runId: turn.turnId, end: 'completed' }],
  };
}

/** One call on the room scope's harness, paid by the room and counted `ambient` (D-162). */
function roomModel(harness: ProductionReasoningHarness, authority: ProductionAuthority): AnswerModel {
  return async (call, signal) => {
    const outcome = await harness.proposeProduction(
      {
        run: {
          id: call.runId,
          authority,
          ownerModule: 'rooms',
          purpose: call.step === 'check' ? 'resident-support' : 'resident-turn',
          policyVersion: RESIDENT_POLICY_VERSION,
        },
        role: call.role,
        context: call.context,
        limits: { allowRepair: call.allowRepair },
      },
      signal,
    );
    return { outcome, run: { runId: call.runId, end: endOf(outcome) } };
  };
}

/**
 * Step 2, outside every transaction: the passages for the question (shared library content, chosen by code), then the writer, the
 * figure rule and the support check, and at most one rewrite. When no passage of the library fits the question no model is asked
 * and the turn is handed back: a resident that spoke on its own has nothing it may say.
 */
async function answer(
  p: CastPassPorts,
  harness: ProductionReasoningHarness,
  authority: ProductionAuthority,
  prepared: Extract<Prepared, { kind: 'call' }>,
  signal: AbortSignal,
): Promise<PipelineResult> {
  const { turn, material, topic } = prepared;
  const ground = await p.readGround(topic, aboutText(material));
  if (ground.length === 0)
    return {
      verdict: { kind: 'failed', dispatched: false },
      support: { policy: ANSWER_SUPPORT_POLICY, result: 'no_ground', cited: [], flagged: [] },
      runs: [],
    };
  return answerAndCheck(
    roomModel(harness, authority),
    {
      origin: 'unprompted',
      turnId: turn.turnId,
      material,
      ground,
      writer: residentRole(
        turn.inhabitant,
        ground.map((passage) => passage.handle),
      ),
      idFor: p.idFor,
    },
    signal,
  );
}

/**
 * Step 3, in one transaction: store the message if the turn is still wanted and nobody is typing, and settle the
 * turn either way. Returns whether the run may be closed (it may not when posting was put off).
 */
async function apply(
  p: CastPassPorts,
  scope: PersonalScopeTx,
  job: CastPassJob,
  result: PipelineResult,
): Promise<'settled' | 'put_off' | 'gone'> {
  if (!(await p.ownerActive(scope))) return 'gone';
  const lock = await p.rooms.lock(scope, job.roomId, 'write');
  if (!lock) return 'gone';
  const found = await standingTurn(p, lock, job.turnId);
  if (found === undefined) return 'settled';
  const { turn, room, discussion } = found;
  const { verdict } = result;
  const at = p.now();
  if (verdict.kind !== 'post' || !found.wanted) {
    // A resident that spoke on its own and has nothing the library supports stays quiet: the turn is declined, and counted.
    await p.ai.settle(lock, turn.turnId, unpostedOutcome(result, found.wanted, at));
    return 'settled';
  }
  const typing = await p.cast.typingUntil(lock, discussion.discussionId, at);
  if (typing !== undefined && job.round < CAST_PASS_ROUNDS) {
    // Someone is typing: put posting off until the hold lapses. The answer is paid for and checked, so it is kept on the turn
    // (which counts as having reached the provider) and the next delivery posts it as it is, without a second call.
    await p.ai.hold(lock, turn.turnId, {
      ...verdict.answer,
      attemptId: verdict.attemptId,
      ...(result.support === undefined ? {} : { support: result.support }),
    });
    await p.enqueueCastPass(scope, { ...job, round: job.round + 1 }, new Date(typing.getTime() + 1_000));
    return 'put_off';
  }
  const messageId = p.newId();
  await p.discussions.append(lock, discussion.discussionId, {
    kind: 'ai',
    messageId,
    inhabitant: turn.inhabitant,
    aiKind: verdict.answer.kind,
    text: verdict.answer.text,
    recordedAt: at,
    trigger: turn.trigger,
  });
  await p.ai.settle(lock, turn.turnId, {
    state: 'completed',
    at,
    messageId,
    provenance: {
      roleVersion: RESIDENT_ROLE_VERSION,
      promptVersion: HARNESS_PROMPT_VERSION,
      model: p.model,
      attemptId: verdict.attemptId,
    },
    ...(result.support === undefined ? {} : { support: result.support }),
  });
  // The one reply the Skeptic may make to an Explainer that overstated: scheduled like any check, decided by the router.
  if (turn.trigger === 'unanswered_question' && hasResident(room, 'skeptic') && looksOverstated(verdict.answer.text))
    await queueCastDue(p, scope, {
      roomId: job.roomId,
      discussionId: discussion.discussionId,
      causeMessageId: messageId,
      trigger: 'answer_overstated',
      startAfter: new Date(at.getTime() + WAITS.reply.room),
    });
  await p.rooms.announce(lock, at);
  return 'settled';
}

/** Closes the runs that are not the writer's: finished steps that the result no longer needs open (a room-scope run has no owner check). */
async function closeSteps(
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
  authority: ProductionAuthority,
  runs: readonly ModelRun[],
): Promise<void> {
  for (const run of runs)
    if (run.end !== undefined) {
      const state = run.end;
      await withRoomScope(authority, (scope) => harness.closeProductionRun(scope, { runId: run.runId, state }));
    }
}

/**
 * A resident answers a message on its own (blueprint §15 "AI inhabitant" role, D-162, D-164), once the router
 * allowed the turn. Three steps, the model calls outside any transaction: (1) one transaction rechecks authority and
 * that the turn is still wanted and reduces the room to the bounded material; (2) the passages for the message are read and
 * chosen by code, and the harness makes the writer's call (one repair), the check of its answer (one repair) and, when a
 * sentence is flagged, one rewrite and its check, at most `ANSWER_PAID_ATTEMPTS` paid attempts in all (D-298), under the
 * nonpersonal `rooms` scope, as `ambient` roles, each on a run whose ID is derived from the turn's, so a redelivery never pays
 * twice; (3) one transaction stores the message and settles the turn, and the runs are closed.
 *
 * What a resident posts on its own passed the figure rule and the shared support check. A resident whose answer the library does
 * not support, or whose draft is flagged again after its one rewrite, says nothing: the turn is declined and counted, and the
 * fixed line a member who asked is given is not posted unasked.
 *
 * Failure/retry: a turn that stopped being wanted (the room paused, a person answered, the message was removed,
 * its author now keeps messages out) is handed back without a call; one answered after the call is settled `failed`
 * and posts nothing, and stays counted. A cap, a quota or a budget refusal posts nothing and shows nothing. Posting is
 * put off while someone is typing: the paid, checked answer is held on the turn, and the redelivered job posts it (or drops
 * it, still counted) without building a context or calling the model again.
 */
export function makeCastPass(
  p: CastPassPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
): CastPass {
  const roomAuthority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };
  return async (job, signal) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.cast-pass' },
    };
    const prepared = await p.withScope(authority, (scope) => prepare(p, scope, job));
    if (prepared.kind !== 'entered' || prepared.value === undefined) return;
    const result =
      prepared.value.kind === 'held'
        ? prepared.value.result
        : await answer(p, harness, roomAuthority, prepared.value, signal);
    // The checks' and the rewrite's runs are finished, so they close now; the writer's closes once the turn is settled.
    const [writer, ...others] = result.runs;
    await closeSteps(harness, withRoomScope, roomAuthority, others);
    const applied = await p.withScope(authority, (scope) => apply(p, scope, job, result));
    if (applied.kind !== 'entered' || applied.value !== 'settled' || writer === undefined) return;
    await closeSteps(harness, withRoomScope, roomAuthority, [writer]);
  };
}
