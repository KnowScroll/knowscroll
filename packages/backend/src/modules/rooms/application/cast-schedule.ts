import { ROOM_PRESENCE_LEASE_MS } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { residentFor, waitFor } from '../domain/router.js';
import { triggerOfPersonMessage, type SpeechTrigger } from '../domain/triggers.js';
import { hasResident, type RoomLock, type RoomPorts, type RoomRow } from './ports.js';

/** Two faces are enough to tell "only the author is here" from "someone else is too". */
const FACES_NEEDED = 2;

/**
 * Queues the check of whether a resident answers a message, to run once the wait people are owed is over (D-164).
 * It only schedules: the router decides at that time, from what the room looks like then. Nothing is queued unless
 * residents are on in this world, the room has the resident the trigger asks for, and the message reads as a
 * question or a strong claim; an idle room therefore queues nothing and makes no call. Called in the transaction
 * that stores the message, so the job and the message commit together or not at all.
 */
export async function scheduleCastCheck(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  message: {
    readonly room: RoomRow;
    readonly discussionId: string;
    readonly messageId: string;
    readonly authorAccountId: string;
    readonly text: string;
    readonly now: Date;
  },
): Promise<void> {
  if (!p.residentsEnabled) return;
  const trigger = triggerOfPersonMessage(message.text);
  if (trigger === undefined || !hasResident(message.room, residentFor(trigger))) return;
  const here = await p.presence.fresh(lock, new Date(message.now.getTime() - ROOM_PRESENCE_LEASE_MS), FACES_NEEDED);
  const onlyAuthorHere = here.every((account) => account === message.authorAccountId);
  await queueCastDue(p, scope, {
    roomId: lock.roomId,
    discussionId: message.discussionId,
    causeMessageId: message.messageId,
    trigger,
    startAfter: new Date(message.now.getTime() + waitFor(trigger, onlyAuthorHere)),
  });
}

/** Queues a check at `startAfter` under the scope's own universe and epoch. */
export function queueCastDue(
  p: RoomPorts,
  scope: PersonalScopeTx,
  check: {
    readonly roomId: string;
    readonly discussionId: string;
    readonly causeMessageId: string;
    readonly trigger: SpeechTrigger;
    readonly startAfter: Date;
    readonly round?: number;
  },
): Promise<void> {
  return p.enqueueCastDue(
    scope,
    {
      v: 1,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      roomId: check.roomId,
      discussionId: check.discussionId,
      causeMessageId: check.causeMessageId,
      trigger: check.trigger,
      round: check.round ?? 0,
    },
    check.startAfter,
  );
}
