import { ROOM_LIVE_EVENTS_MAX, type RoomLiveEvent } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CastMember } from '../domain/cast.js';
import type { AiLevel } from '../domain/membership.js';
import { authorsOf } from './feed-authors.js';
import type { RoomLock, RoomPorts } from './ports.js';

/** How far back the strip looks: what happened today, not what happened once. */
const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many of the newest events are read before the reader's own rules are applied and three are chosen. */
const LIVE_LOOKS = 20;

/**
 * The live strip above General (T3 "General + live activity", v3 R-8b, D-276): who posted in the Feed and who replied under a post,
 * newest first, at most three. Every event is a row the room already holds (a post, a reply), so nothing is made up and nothing is
 * counted: no number of people, no one's presence, no word about what anyone read. A reader whose AI level is Off is told nothing of
 * what a resident or a scout posted, because none of it reaches them; a person the reader blocked, and a post a moderator removed,
 * are left out. One event stands for one post and one kind of thing, so a busy thread does not fill the strip.
 */
export async function liveStrip(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  reader: { readonly aiLevel: AiLevel; readonly accountId: string },
  cast: readonly CastMember[],
  now: Date,
): Promise<readonly RoomLiveEvent[] | undefined> {
  const rows = await p.feed.liveEvents(lock, new Date(now.getTime() - LIVE_WINDOW_MS), LIVE_LOOKS);
  if (rows.length === 0) return undefined;
  const signed = await authorsOf(p, scope, reader.accountId, cast, rows);
  const events: RoomLiveEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const by = signed(row);
    if (by === undefined || (reader.aiLevel === 'off' && by.kind !== 'person')) continue;
    const key = `${row.kind}:${row.discussionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ kind: row.kind, by, at: row.at.toISOString(), discussionId: row.discussionId });
    if (events.length === ROOM_LIVE_EVENTS_MAX) break;
  }
  return events.length === 0 ? undefined : events;
}
