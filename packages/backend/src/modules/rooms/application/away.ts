import { CONCEPTS } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import {
  AWAY_MIN_NEW_MESSAGES,
  SUMMARY_MESSAGES,
  coversFrom,
  isOwedSummary,
  wasAwayLongEnough,
  windowOf,
} from '../domain/away.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import type { AwayMaterial } from './away-role.js';
import { reduceMessages } from './inhabitant-context.js';
import { hasResident, type MemberRow, type RoomLock, type RoomPorts, type RoomRow, type SummaryRow } from './ports.js';

/**
 * A member's device has the room open now, and was last open at `previous`. If they were away long enough, to enough
 * new messages, they are owed a "while you were away" (D-169): the room's window is claimed (one summary per room and
 * 12-hour window, however many members return in it), a model call is queued for it in this transaction when this member
 * is the first, and the member's own away mark names the window. A member whose AI level is Off is owed nothing and
 * costs nothing. Nothing here makes a model call or waits on one: the worker does, from the queued job.
 */
export async function openWindowOnReturn(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: { readonly lock: RoomLock; readonly owner: { readonly accountId: string }; readonly room: RoomRow },
  member: MemberRow,
  previous: Date,
  now: Date,
): Promise<void> {
  const { lock, owner, room } = entered;
  if (!p.residentsEnabled || !roomAcceptsPosts(room.status) || !hasResident(room, 'skeptic')) return;
  // The cheap rules first: the count below is a query, and most returns are short.
  if (!wasAwayLongEnough({ previous, now, level: member.aiLevel })) return;
  const newMessages = await p.discussions.newMessagesFor(lock, owner.accountId, previous, AWAY_MIN_NEW_MESSAGES);
  if (!isOwedSummary({ previous, now, newMessages, level: member.aiLevel })) return;
  const window = windowOf(now);
  const claim = await p.summaries.claim(lock, {
    summaryId: p.newId(),
    windowNo: window,
    coversFrom: coversFrom(previous, now),
    coversThrough: now,
    now,
  });
  await p.positions.markAway(lock, owner.accountId, { since: previous, window });
  if (claim.claimed)
    await p.enqueueSummary(scope, {
      v: 1,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      roomId: lock.roomId,
      summaryId: claim.summary.summaryId,
    });
}

/**
 * What a resident may read to write one window's summary: the room's name and topic and the window's newest messages from
 * every discussion, reduced to words by the same builder every context path uses (D-161). A removed message and a deleted
 * account's are not there; a member who keeps their messages out is left out altogether, not shown as a placeholder, so
 * the summary cannot say that something was said. Each message carries the place it was said in: General, Today, or "a topic".
 * A topic's title is never read, because a title is someone's words that a cached summary could outlive (D-169). No
 * name, handle, ID, position or friend conversation reaches the model.
 */
export async function assembleAway(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  parts: { readonly summary: SummaryRow; readonly room: RoomRow },
): Promise<AwayMaterial> {
  const { summary, room } = parts;
  const window = await p.discussions.windowMessages(lock, {
    after: summary.coversFrom,
    through: summary.coversThrough,
    limit: SUMMARY_MESSAGES,
  });
  const reduced = await reduceMessages(
    p,
    scope,
    lock,
    window.map((entry) => entry.message),
    { also: [], refs: [] },
  );
  const placeOf = new Map(window.map((entry) => [entry.message.messageId, entry]));
  const topic = CONCEPTS.find((concept) => concept.id === room.topic.id);
  return {
    summaryId: summary.summaryId,
    roomName: room.name,
    topicMeaning: topic?.meaning,
    messages: reduced.messages.flatMap((entry) => {
      const where = placeOf.get(entry.row.messageId);
      if (entry.keptOut || where === undefined) return [];
      return [
        {
          place:
            where.discussionKind === 'general' ? 'General' : where.discussionKind === 'today' ? 'Today' : 'a topic',
          speaker: entry.message.speaker,
          text: entry.message.text,
        },
      ];
    }),
  };
}
