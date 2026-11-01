import {
  ROOM_PRESENCE_LEASE_MS,
  type RoomWatchStrip,
  type WatchLastOnStage,
  type WatchSessionView,
  type WatchStartBlock,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { isModerator, roomAcceptsPosts } from '../domain/membership.js';
import { phaseAt as launchPhaseAt } from '../domain/launch.js';
import { dayStartOf, mayStop, phaseAt, startBlock, watchingShown } from '../domain/watch.js';
import type { EnteredRoom } from './gate.js';
import type { RoomLock, RoomPorts } from './ports.js';
import type { WatchSessionRow } from './watch-ports.js';

/** The most people one read looks up. */
const PEOPLE_READ_LIMIT = 200;

/** The room's session that is on at `now`: not stopped and its Reel has not run out. A session past its end is read as none until a member command settles it. */
export async function liveSession(p: RoomPorts, lock: RoomLock, now: Date): Promise<WatchSessionRow | undefined> {
  const row = await p.watches.live(lock, 'none');
  return row !== undefined && phaseAt(row.startsAt, row.durationMs, now).kind !== 'over' ? row : undefined;
}

/** A Launch is in its lobby or running: it has the stage. */
async function launchOn(p: RoomPorts, lock: RoomLock, now: Date): Promise<boolean> {
  const running = await p.launches.unfinished(lock, 'none');
  return running !== undefined && launchPhaseAt(running.startsAt, now).kind !== 'over';
}

/** The members who have the room open now, as accounts. */
async function hereNow(p: RoomPorts, lock: RoomLock, now: Date): Promise<ReadonlySet<string>> {
  return new Set(await p.presence.fresh(lock, new Date(now.getTime() - ROOM_PRESENCE_LEASE_MS), PEOPLE_READ_LIMIT));
}

/**
 * How many people are watching, as this reader may be told. Only people who joined count, and of them only those who still have the
 * room open (a closed tab is not watching), never an AI (an AI cannot join), never a person the reader blocked, and the reader counts
 * when they joined. The number is said from three and is absent below it (`watchingShown`).
 */
async function watchingFor(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  readerId: string,
  joined: readonly string[],
  now: Date,
): Promise<number | undefined> {
  const here = await hereNow(p, lock, now);
  const others = joined.filter((account) => account !== readerId && here.has(account));
  const blocked = others.length === 0 ? new Set<string>() : await p.blocked(scope, readerId, others);
  const counted = others.filter((account) => !blocked.has(account)).length + (joined.includes(readerId) ? 1 : 0);
  return watchingShown(counted);
}

/**
 * The live session as this reader sees it: the Reel, whether they joined, who shared it (when that person is still a member the reader
 * has not blocked), whether they may stop it, "N watching" from three and the time on the server's clock. Nothing in it says where
 * anyone is in the Reel: there is nothing stored that could.
 */
export async function sessionViewOf(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: EnteredRoom & { readonly member: NonNullable<EnteredRoom['member']> },
  row: WatchSessionRow,
  now: Date,
): Promise<WatchSessionView | undefined> {
  const phase = phaseAt(row.startsAt, row.durationMs, now);
  if (phase.kind === 'over') return undefined;
  const { lock, owner } = entered;
  const joined = await p.watches.viewers(lock, row.sessionId);
  const sharer = row.startedBy;
  const hidden =
    sharer === null || sharer === owner.accountId
      ? new Set<string>()
      : await p.blocked(scope, owner.accountId, [sharer]);
  const person =
    sharer === null || hidden.has(sharer) ? undefined : (await p.people.byAccounts(scope, [sharer])).get(sharer);
  const watching = await watchingFor(p, scope, lock, owner.accountId, joined, now);
  const common = {
    sessionId: row.sessionId,
    reel: { assetId: row.assetId, assetRevision: row.assetRevision, title: row.title, durationMs: row.durationMs },
    youIn: joined.includes(owner.accountId),
    ...(person === undefined ? {} : { sharedBy: person }),
    canStop: mayStop({ isStarter: sharer === owner.accountId, isModerator: isModerator(entered.member.role) }),
    ...(watching === undefined ? {} : { watching }),
  };
  return phase.kind === 'starting'
    ? { phase: 'starting', ...common, startsInMs: phase.startsInMs }
    : { phase: 'playing', ...common, elapsedMs: phase.elapsedMs };
}

/** Whether the reader may start a Reel now, and if not the first reason that stops it. Reads the topic's library through the caller's scope. */
export async function startDecision(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: EnteredRoom,
  now: Date,
): Promise<WatchStartBlock | undefined> {
  const { lock, owner, standing } = entered;
  const [session, launch, here, reels, startedToday] = await Promise.all([
    liveSession(p, lock, now),
    launchOn(p, lock, now),
    hereNow(p, lock, now),
    p.readReels(scope, standing.room.topic, 1),
    p.watches.startedSince(lock, dayStartOf(now)),
  ]);
  return startBlock({
    roomOpen: roomAcceptsPosts(standing.room.status),
    stageTaken: session !== undefined || launch,
    hasReels: reels.length > 0,
    here: new Set([...here, owner.accountId]).size,
    startedToday,
  });
}

/** What was last on the room's stage: the newer of its last Reel session and its last Launch, as a time. Absent for a room that never had either. */
export async function lastOnStage(p: RoomPorts, lock: RoomLock): Promise<WatchLastOnStage | undefined> {
  const [session, launch] = await Promise.all([p.watches.latest(lock), p.launches.latest(lock)]);
  const options: WatchLastOnStage[] = [
    ...(session === undefined
      ? []
      : [{ kind: 'reel' as const, at: session.startsAt.toISOString(), title: session.title }]),
    ...(launch === undefined ? [] : [{ kind: 'launch' as const, at: launch.startsAt.toISOString() }]),
  ];
  return options.toSorted((a, b) => b.at.localeCompare(a.at))[0];
}

/** What the room's own view says of Watch together: a session is on, or the topic has a Reel to offer. It names no person and no number. */
export async function watchStrip(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  topic: { readonly kind: 'system' | 'planet'; readonly id: string },
  now: Date,
): Promise<RoomWatchStrip | undefined> {
  if ((await liveSession(p, lock, now)) !== undefined) return { state: 'live' };
  return (await p.readReels(scope, topic, 1)).length > 0 ? { state: 'ready' } : undefined;
}
