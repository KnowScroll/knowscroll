import type { PersonalScopeTx } from '../../identity/public.js';
import type { AskKind } from '../domain/asks.js';
import { askDecision, hourBefore, utcDayStart, type AskDecision, type InhabitantId } from '../domain/contribution.js';
import type { RoomLock, RoomPorts } from './ports.js';

/**
 * Whether this member may ask now, from the asked-turn bounds counted under the room lock: one reply prepared per
 * discussion at a time, a daily bound per room and an hourly bound per person (D-068). Asked turns have these bounds
 * apart from the unprompted caps, so a member is always answered while the room is not full.
 */
export async function askDecisionFor(
  p: RoomPorts,
  lock: RoomLock,
  accountId: string,
  discussionId: string,
  now: Date,
): Promise<AskDecision> {
  const [counts, open] = await Promise.all([
    p.ai.countAsks(lock, { accountId, dayStart: utcDayStart(now), hourStart: hourBefore(now) }),
    p.ai.openAsks(lock, discussionId, now),
  ]);
  return askDecision({
    roomAsksToday: counts.room,
    personAsksLastHour: counts.person,
    personRequestsLastHour: counts.personRequests,
    openAsk: open.length > 0,
  });
}

/**
 * Writes an asked turn and queues the model call in the caller's transaction, so the ledger row and its job commit
 * together. The row names what set the turn going (`kind`) and, for every kind but the plain ask, the message it is
 * about (`causeMessageId`). The caller has already decided the ask is allowed.
 */
export async function queueAsk(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  ask: {
    readonly kind: AskKind;
    readonly inhabitant: InhabitantId;
    readonly roomId: string;
    readonly discussionId: string;
    readonly causeMessageId: string | null;
    readonly accountId: string;
    readonly commandId: string;
    readonly now: Date;
  },
): Promise<void> {
  const turnId = p.newId();
  await p.ai.insertAsk(lock, {
    turnId,
    trigger: 'asked',
    askKind: ask.kind,
    causeMessageId: ask.causeMessageId,
    held: null,
    roomId: ask.roomId,
    discussionId: ask.discussionId,
    inhabitant: ask.inhabitant,
    requestedByAccountId: ask.accountId,
    commandId: ask.commandId,
    state: 'queued',
    createdAt: ask.now,
  });
  await p.enqueueContribution(scope, turnId);
}
