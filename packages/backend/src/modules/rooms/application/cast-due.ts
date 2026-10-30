import { ROOM_PRESENCE_LEASE_MS } from '@knowscroll/contracts';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { residentFor, route, type RouteDecision, type RouteFacts } from '../domain/router.js';
import { CAST_DUE_ROUNDS, type CastDueJob } from '../events.js';
import { queueCastDue } from './cast-schedule.js';
import type { MessageRow, RoomLock, RoomPorts } from './ports.js';

/** The worker's consumer of `rooms.cast-due`. */
export type CastDue = (job: CastDueJob) => Promise<void>;

export interface CastDuePorts extends RoomPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
}

/** A moment after the time a check was asked to look again at, so a job never wakes a hair before it is due. */
const LOOK_AGAIN_SLACK_MS = 1_000;

/** Reads what the router needs about one message and its room, under the room lock, at `now`. */
async function factsOf(
  p: RoomPorts,
  lock: RoomLock,
  job: CastDueJob,
  cause: MessageRow,
  now: Date,
): Promise<RouteFacts> {
  const author = cause.authorAccountId;
  const room = await p.rooms.roomRow(lock);
  const inhabitant = residentFor(job.trigger);
  const fresh = await p.presence.fresh(lock, new Date(now.getTime() - ROOM_PRESENCE_LEASE_MS), 2);
  const [authorMember, keptOut, authorMessages, listeners, after, typingUntil, decidedBefore, counts] =
    await Promise.all([
      author === null ? undefined : p.rooms.memberOf(lock, author),
      author === null ? new Set<string>() : p.rooms.keepOutAmong(lock, [author]),
      author === null ? 0 : p.cast.messagesBy(lock, author),
      p.cast.listeners(lock),
      p.cast.activityAfter(lock, job.discussionId, cause.sequence, author),
      p.cast.typingUntil(lock, job.discussionId, now),
      p.ai.decidedFor(lock, job.causeMessageId, job.trigger),
      p.ai.capCounts(lock, { now, inhabitant, authorAccountId: author }),
    ]);
  return {
    now,
    trigger: {
      kind: job.trigger,
      at: cause.recordedAt,
      authorKeptOut: author !== null && keptOut.has(author),
      authorFirstMessage: author !== null && authorMessages <= 1,
      decidedBefore,
    },
    // A person who left or was removed no longer has a question here: the room is treated as closed for them.
    room: {
      open: roomAcceptsPosts(room.status) && (author === null || authorMember?.endedBy === null),
      residents: room.cast.map((member) => member.inhabitant),
      listeners,
    },
    onlyAuthorHere: fresh.every((account) => account === author),
    after,
    typingUntil,
    counts,
  };
}

/** Writes the router's yes or no as a turn row and, for a yes, queues the model call in the same transaction. */
async function record(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  job: CastDueJob,
  decision: Extract<RouteDecision, { kind: 'speak' | 'refuse' }>,
  now: Date,
): Promise<void> {
  const turnId = p.newId();
  await p.ai.insertDecision(lock, {
    turnId,
    discussionId: job.discussionId,
    inhabitant: residentFor(job.trigger),
    trigger: job.trigger,
    causeMessageId: job.causeMessageId,
    decision: decision.kind === 'speak' ? { kind: 'allowed' } : { kind: 'refused', cap: decision.cap },
    counts: decision.counts,
    now,
  });
  if (decision.kind === 'speak')
    await p.enqueueCastPass(scope, {
      v: 1,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      roomId: job.roomId,
      turnId,
      round: 0,
    });
}

/**
 * The Stage manager's turn at a message (D-081, D-164): once the wait people are owed is over, decide whether a
 * resident answers it, and if so queue the model call. No model is called here and no external network is waited on.
 *
 * Authority: the worker acts as a system actor for the universe and epoch of the person whose message set it off,
 * only to take the room lock in the blueprint's order and to stop when that person is gone (a deleted account or
 * a privacy reset ends the check). The room is locked FOR UPDATE, so the caps are counted exactly.
 *
 * Steps: read the facts, ask the pure router, then do what it says in this transaction: nothing for a trigger that
 * no longer applies, look again later for a wait or a typing hold (at most `CAST_DUE_ROUNDS` times), a refused
 * turn row for a cap (posts nothing, shows nothing), or an allowed turn row and the `rooms.cast-pass` job.
 *
 * Failure/retry: a redelivery finds the turn row and lets go; a lost job leaves the message as unanswered as if no
 * resident were there. Side effects: turn rows and jobs only. Nothing here is consumption evidence.
 */
export function makeCastDue(p: CastDuePorts): CastDue {
  return async (job) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.cast-due' },
    };
    await p.withScope(authority, async (scope) => {
      if (!p.residentsEnabled || !(await p.ownerActive(scope))) return;
      const lock = await p.rooms.lock(scope, job.roomId, 'write');
      if (!lock) return;
      const cause = await p.discussions.messageById(lock, job.discussionId, job.causeMessageId);
      if (cause === undefined || cause.hidden) return;
      const now = p.now();
      const decision = route(await factsOf(p, lock, job, cause, now));
      if (decision.kind === 'wait') {
        if (job.round >= CAST_DUE_ROUNDS) return;
        await queueCastDue(p, scope, {
          roomId: job.roomId,
          discussionId: job.discussionId,
          causeMessageId: job.causeMessageId,
          trigger: job.trigger,
          startAfter: new Date(decision.until.getTime() + LOOK_AGAIN_SLACK_MS),
          round: job.round + 1,
        });
      } else if (decision.kind !== 'drop') {
        await record(p, scope, lock, job, decision, now);
      }
    });
  };
}
