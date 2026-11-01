import {
  JoinWatchSchema,
  LeaveWatchSchema,
  ReadRoomWatchSchema,
  ReadWatchReelsSchema,
  RoomWatchSchema,
  StartWatchSchema,
  StopWatchSchema,
  WATCH_REELS_MAX,
  WatchJoinedAcceptanceSchema,
  WatchLeftAcceptanceSchema,
  WatchReelsSchema,
  WatchStartedAcceptanceSchema,
  WatchStoppedAcceptanceSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { isModerator, roomAcceptsPosts } from '../domain/membership.js';
import { LONGEST_REEL_MS, endsAt, keptUntil, mayStop, startsAtFrom } from '../domain/watch.js';
import { receiptBase, runCommand, type CommandContext, type CommandSpec } from './command.js';
import { enterRoom } from './gate.js';
import { ok, refuse, roomEnvelope, type Result, type RoomLock, type RoomPorts } from './ports.js';
import { lastOnStage, liveSession, sessionViewOf, startDecision } from './watch-view.js';

/**
 * Settles the room's session when its Reel has run out: it is marked stopped at the moment the last frame was due, and the people
 * who joined are deleted (D-258). There is no job: the first member command in the room after the end settles it (a presence beat,
 * which an open room sends every 25 seconds, or a Watch command), as a Launch is settled. The session row is taken FOR UPDATE, so a
 * join in flight commits first and is deleted with the others, and two commands at once settle it once. Sessions that ended more than
 * seven days ago are deleted by the same commands, so a room that stops watching does not keep them.
 */
export async function settleWatch(p: RoomPorts, lock: RoomLock, now: Date): Promise<void> {
  const running = await p.watches.live(lock, 'none');
  if (running !== undefined && now.getTime() >= endsAt(running.startsAt, running.durationMs).getTime()) {
    const row = await p.watches.live(lock, 'update');
    if (row !== undefined && now.getTime() >= endsAt(row.startsAt, row.durationMs).getTime()) {
      await p.watches.clearViewers(lock, row.sessionId);
      if (await p.watches.stop(lock, row.sessionId, endsAt(row.startsAt, row.durationMs)))
        await p.rooms.announce(lock, now);
    }
  }
  await p.watches.purge(lock, keptUntil(now));
}

/** What a command that records the person as watching answers while their recording is paused or the device is out of date. */
function notSavedGate<A extends object>(
  p: RoomPorts,
  operation: string,
  command: { readonly commandId: string; readonly roomId: string; readonly recordingGeneration: number },
  acceptance: z.ZodType<A>,
): NonNullable<CommandSpec<A>['gate']> {
  return async ({ scope }: CommandContext) => {
    const fence = await p.fenceRecording(scope, command.recordingGeneration);
    if (fence.kind === 'recording') return undefined;
    if (fence.kind !== 'paused' && fence.kind !== 'stale') return refuse('unavailable');
    return ok(
      acceptance.parse({
        ...roomEnvelope(scope),
        commandId: command.commandId,
        outcome: 'not_saved',
        operation,
        roomId: command.roomId,
        reason: fence.kind === 'paused' ? 'recording_paused' : 'recording_generation_stale',
      }),
    );
  };
}

/**
 * Watch together: a room watches one library Reel on a shared clock. Every method is for a current member and every refusal is the
 * same `unavailable`. The server keeps which Reel, when the first frame is due and when it stopped, and who joined; it never keeps,
 * reads or sends anyone's position. Starting and joining are recorded in the room, so each is refused (`not_saved`) while recording is
 * paused (D-258). Nothing here opens an exposure or writes evidence for anyone: a person's own watch is the ordinary Reel encounter
 * their own device opens after they join (D-063).
 */
export function makeWatch(p: RoomPorts) {
  return {
    /**
     * The room's stage for a member: the session that is on (the Reel, whether they joined, "N watching" from three, the time on the
     * server's clock) or, when none is, whether they may start one and what was last on the stage. Writes nothing.
     */
    async watch(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomWatchSchema>>> {
      const parsed = ReadRoomWatchSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof RoomWatchSchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const member = { ...entered, member: entered.member };
        const now = p.now();
        const row = await liveSession(p, entered.lock, now);
        const session = row === undefined ? undefined : await sessionViewOf(p, scope, member, row, now);
        const block = row === undefined ? await startDecision(p, scope, entered, now) : undefined;
        const last = row === undefined ? await lastOnStage(p, entered.lock) : undefined;
        return ok(
          RoomWatchSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            ...(session === undefined ? {} : { session }),
            ...(row !== undefined
              ? {}
              : { start: block === undefined ? { allowed: true } : { allowed: false, reason: block } }),
            ...(last === undefined ? {} : { last }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** The Reels the room's topic rests on, for the person about to start one: library Reels only, newest revision, no fixture. Writes nothing. */
    async watchReels(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof WatchReelsSchema>>> {
      const parsed = ReadWatchReelsSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof WatchReelsSchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const reels = await p.readReels(scope, entered.standing.room.topic, WATCH_REELS_MAX);
        return ok(
          WatchReelsSchema.parse({ ...roomEnvelope(scope), readId: parsed.data.readId, status: 'ready', reels }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * A member starts Watch together on a library Reel of the room's topic and joins it. The Reel must still be the current revision of
     * a served library Reel under the topic; the stage must be free (no session, no Launch); two members must have the room open and
     * the room's day cap must not be reached. The first frame is due five seconds on. The room is locked FOR UPDATE, so two starts at
     * once make one session. The same command again replays.
     */
    startWatch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof WatchStartedAcceptanceSchema>>> {
      const parsed = StartWatchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.watch-start',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: WatchStartedAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        gate: notSavedGate(p, 'watch.start', command, WatchStartedAcceptanceSchema),
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          await settleWatch(p, lock, now);
          const block = await startDecision(p, scope, entered, now);
          if (block !== undefined) return refuse(block === 'too_many' ? 'rate_limited' : 'unavailable');
          const [reel] = await p.readReels(scope, standing.room.topic, 1, { assetId: command.assetId });
          if (reel === undefined || reel.durationMs > LONGEST_REEL_MS) return refuse('unavailable');
          return ok(async () => {
            const sessionId = p.newId();
            const startsAt = startsAtFrom(now);
            await p.watches.insert(lock, {
              sessionId,
              assetId: reel.assetId,
              assetRevision: reel.assetRevision,
              title: reel.title,
              durationMs: reel.durationMs,
              startedBy: owner.accountId,
              startsAt,
            });
            await p.watches.addViewer(lock, sessionId, owner.accountId);
            await p.rooms.announce(lock, now);
            return WatchStartedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'watch.start',
              roomId: command.roomId,
              sessionId,
              startsInMs: startsAt.getTime() - now.getTime(),
            });
          });
        },
      });
    },

    /**
     * A member says they are watching, while the session is on and its Reel is still served. Joining twice changes nothing. Only now
     * does the member's own device open the Reel as an ordinary encounter of their own; this command writes nothing about it.
     */
    joinWatch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof WatchJoinedAcceptanceSchema>>> {
      const parsed = JoinWatchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.watch-join',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: WatchJoinedAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        gate: notSavedGate(p, 'watch.join', command, WatchJoinedAcceptanceSchema),
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const row = await p.watches.live(lock, 'share');
          if (row?.sessionId !== command.sessionId || now.getTime() >= endsAt(row.startsAt, row.durationMs).getTime())
            return refuse('unavailable');
          const [card] = await p.readContent(scope, [{ assetId: row.assetId, assetRevision: row.assetRevision }]);
          if (card?.status !== 'available') return refuse('unavailable');
          return ok(async () => {
            if (await p.watches.addViewer(lock, row.sessionId, owner.accountId)) await p.rooms.announce(lock, now);
            return WatchJoinedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'watch.join',
              roomId: command.roomId,
              sessionId: row.sessionId,
            });
          });
        },
      });
    },

    /**
     * A member leaves the stage: they are taken out of the viewers and nothing of theirs is kept. Always possible, recording paused or
     * not. A session that is already settled answers `unavailable`, and the device reads the stage again.
     */
    leaveWatch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof WatchLeftAcceptanceSchema>>> {
      const parsed = LeaveWatchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.watch-leave',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: WatchLeftAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner } = entered;
          const row = await p.watches.live(lock, 'share');
          if (row?.sessionId !== command.sessionId) return refuse('unavailable');
          return ok(async () => {
            if (await p.watches.removeViewer(lock, row.sessionId, owner.accountId)) await p.rooms.announce(lock, now);
            return WatchLeftAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'watch.leave',
              roomId: command.roomId,
              sessionId: row.sessionId,
            });
          });
        },
      });
    },

    /**
     * The member who shared the session, or a moderator of the room, ends it for everyone: it is stopped now and the people who joined
     * are deleted. Anyone else is told `unavailable`. A session that has already ended answers the same.
     */
    stopWatch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof WatchStoppedAcceptanceSchema>>> {
      const parsed = StopWatchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.watch-stop',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: WatchStoppedAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, member } = entered;
          const row = await p.watches.live(lock, 'update');
          if (row?.sessionId !== command.sessionId || member === undefined) return refuse('unavailable');
          // A Reel that has run out is already over: the next member command settles it at the moment it ended.
          if (now.getTime() >= endsAt(row.startsAt, row.durationMs).getTime()) return refuse('unavailable');
          if (!mayStop({ isStarter: row.startedBy === owner.accountId, isModerator: isModerator(member.role) }))
            return refuse('unavailable');
          return ok(async () => {
            await p.watches.clearViewers(lock, row.sessionId);
            await p.watches.stop(lock, row.sessionId, now);
            await p.rooms.announce(lock, now);
            return WatchStoppedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'watch.stop',
              roomId: command.roomId,
              sessionId: row.sessionId,
            });
          });
        },
      });
    },
  };
}
