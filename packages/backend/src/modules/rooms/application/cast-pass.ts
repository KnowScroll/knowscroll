import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ReasoningContext,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { WAITS } from '../domain/router.js';
import { looksOverstated, type SpeechTrigger } from '../domain/triggers.js';
import { CAST_PASS_ROUNDS, type CastPassJob } from '../events.js';
import { queueCastDue } from './cast-schedule.js';
import { assembleMaterial } from './inhabitant-context.js';
import { contributionContext, contributionVerdict, type ContributionVerdict } from './inhabitant-role.js';
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
}

/** What step 1 hands on: the context for a call, or an answer already paid for and held back while someone typed. */
type Prepared =
  | { readonly kind: 'call'; readonly turn: AiTurnRow; readonly context: ReasoningContext }
  | { readonly kind: 'held'; readonly turn: AiTurnRow; readonly verdict: ContributionVerdict };

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
 * bounded context (keep-out substituted, no names). A turn that is no longer wanted ends here without a call. A turn
 * whose answer was already given and held back while someone typed goes on as it is: the context is not built again
 * (it would differ, and the ledger would refuse a changed request for a run that was already paid for).
 */
async function prepare(p: CastPassPorts, scope: PersonalScopeTx, job: CastPassJob): Promise<Prepared | undefined> {
  if (!p.residentsEnabled || !(await p.ownerActive(scope))) return undefined;
  const lock = await p.rooms.lock(scope, job.roomId, 'write');
  if (!lock) return undefined;
  const found = await standingTurn(p, lock, job.turnId);
  if (found === undefined) return undefined;
  const { turn, room, discussion } = found;
  if (turn.held !== null)
    return {
      kind: 'held',
      turn,
      verdict: { kind: 'contribution', answer: turn.held, attemptId: turn.held.attemptId, end: 'completed' },
    };
  const material = found.wanted
    ? await assembleMaterial(p, scope, lock, { turn, room, discussion, focus: turn.causeMessageId })
    : undefined;
  if (material?.focus === undefined) {
    // Nothing reached the provider: the turn is handed back, so it no longer counts against the caps.
    await p.ai.settle(lock, turn.turnId, { state: 'failed', at: p.now(), dispatched: false });
    return undefined;
  }
  return { kind: 'call', turn, context: contributionContext(material) };
}

/**
 * Step 3, in one transaction: store the message if the turn is still wanted and nobody is typing, and settle the
 * turn either way. Returns whether the run may be closed (it may not when posting was put off).
 */
async function apply(
  p: CastPassPorts,
  scope: PersonalScopeTx,
  job: CastPassJob,
  verdict: ContributionVerdict,
): Promise<'settled' | 'put_off' | 'gone'> {
  if (!(await p.ownerActive(scope))) return 'gone';
  const lock = await p.rooms.lock(scope, job.roomId, 'write');
  if (!lock) return 'gone';
  const found = await standingTurn(p, lock, job.turnId);
  if (found === undefined) return 'settled';
  const { turn, room, discussion } = found;
  const at = p.now();
  if (verdict.kind !== 'contribution' || !found.wanted) {
    await p.ai.settle(lock, turn.turnId, unpostedOutcome(verdict, found.wanted, at));
    return 'settled';
  }
  const typing = await p.cast.typingUntil(lock, discussion.discussionId, at);
  if (typing !== undefined && job.round < CAST_PASS_ROUNDS) {
    // Someone is typing: put posting off until the hold lapses. The answer is paid for, so it is kept on the turn (which
    // counts as having reached the provider) and the next delivery posts it as it is, without a second call.
    await p.ai.hold(lock, turn.turnId, { ...verdict.answer, attemptId: verdict.attemptId });
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

/**
 * A resident answers a message on its own (blueprint §15 "AI inhabitant" role, D-162, D-164), once the router
 * allowed the turn. Three steps, the model call outside any transaction: (1) one transaction rechecks authority and
 * that the turn is still wanted and builds the bounded context; (2) the harness makes one call (plus at most one
 * repair) under the nonpersonal `rooms` scope, as an `ambient` role, on a run whose ID is the turn ID, so a
 * redelivery never pays twice and an unknown outcome is never resent; (3) one transaction stores the message and
 * settles the turn, and the run is closed.
 *
 * Failure/retry: a turn that stopped being wanted (the room paused, a person answered, the message was removed,
 * its author now keeps messages out) is handed back without a call; one answered after the call is settled `failed`
 * and posts nothing, and stays counted. A cap, a quota or a budget refusal posts nothing and shows nothing. Posting is
 * put off while someone is typing: the paid answer is held on the turn, and the redelivered job posts it (or drops
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
    const { turn } = prepared.value;
    const verdict =
      prepared.value.kind === 'held'
        ? prepared.value.verdict
        : contributionVerdict(
            await harness.proposeProduction(
              {
                run: {
                  id: turn.turnId,
                  authority: roomAuthority,
                  ownerModule: 'rooms',
                  purpose: 'resident-turn',
                  policyVersion: RESIDENT_POLICY_VERSION,
                },
                role: residentRole(turn.inhabitant),
                context: prepared.value.context,
                limits: { allowRepair: true },
              },
              signal,
            ),
          );
    const applied = await p.withScope(authority, (scope) => apply(p, scope, job, verdict));
    if (applied.kind !== 'entered' || applied.value !== 'settled' || verdict.end === undefined) return;
    const { end } = verdict;
    await withRoomScope(roomAuthority, (scope) =>
      harness.closeProductionRun(scope, { runId: turn.turnId, state: end }),
    );
  };
}
