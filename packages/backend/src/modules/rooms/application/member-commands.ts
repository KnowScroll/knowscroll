import {
  AwayDismissalSchema,
  DismissAwaySchema,
  ROOM_PRESENCE_LEASE_MS,
  RoomPreferencesAcceptanceSchema,
  RoomPresenceAckSchema,
  SetRoomPreferencesSchema,
  SetRoomPresenceSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { openWindowOnReturn } from './away.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import { ok, refuse, roomEnvelope, type Result, type RoomPorts } from './ports.js';
import { settleLaunches } from './launch.js';
import { settleWatch } from './watch.js';
import { settleDue } from './sky.js';
import { youOf } from './view.js';

/**
 * A member's own place in a room: the settings only they change, and whether they have the room open. Both run
 * in the caller's personal scope and the room's lock (FOR SHARE: who is in does not change here) and need a
 * current member. Neither is consumption evidence, neither says anything to another person except the lease,
 * which is how a face appears.
 */
export function makeMemberCommands(p: RoomPorts) {
  return {
    /**
     * Sets the caller's AI level, their keep-out choice and the acknowledgement of the AI notice, each on its own.
     * The same value again is accepted, so a retry, a replay and a second tap all end in the same state. Keeping
     * messages out takes effect for the next thing an AI reads, and erases any "while you were away" that read them.
     */
    setPreferences(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomPreferencesAcceptanceSchema>>> {
      const parsed = SetRoomPreferencesSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.room-preferences',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomPreferencesAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        decide({ scope, entered, now }) {
          return Promise.resolve(
            ok(async () => {
              const member = await p.rooms.setPreferences(
                entered.lock,
                entered.owner.accountId,
                {
                  ...(command.aiLevel === undefined ? {} : { aiLevel: command.aiLevel }),
                  ...(command.keepOut === undefined ? {} : { keepOut: command.keepOut }),
                  ...(command.noticeSeen === true ? { noticeSeen: true as const } : {}),
                },
                now,
              );
              // A summary that already read their words must not keep them (D-169): it is erased, and not written again.
              if (command.keepOut === true)
                await p.summaries.markStale(entered.lock, { byAccount: entered.owner.accountId });
              return RoomPreferencesAcceptanceSchema.parse({
                ...receiptBase(scope, now, command.commandId),
                operation: 'room.preferences',
                roomId: command.roomId,
                you: youOf(member),
              });
            }),
          );
        },
      });
    },

    /** The member has read their "while you were away": it is not shown again. The same command again is accepted. */
    dismissAway(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof AwayDismissalSchema>>> {
      const parsed = DismissAwaySchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.away-dismiss',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: AwayDismissalSchema,
        requires: 'member',
        mode: 'read',
        decide({ scope, entered, now }) {
          return Promise.resolve(
            ok(async () => {
              await p.positions.dismissAway(entered.lock, entered.owner.accountId);
              return AwayDismissalSchema.parse({
                ...receiptBase(scope, now, command.commandId),
                operation: 'room.away-dismiss',
                roomId: command.roomId,
              });
            }),
          );
        },
      });
    },

    /**
     * The caller's device says it has the room open (`here`: starts or renews a lease of one minute) or has
     * closed it (`away`). Only the lease's start and end tell the room, so a steady heartbeat is one cheap write
     * and no hint. A person who is not a current member is told `unavailable`, as for every room read. Each beat also
     * notes, privately, when the member last had the room open; a lease that begins after a long absence to enough
     * new messages opens the window's "while you were away" (D-169).
     */
    async setPresence(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomPresenceAckSchema>>> {
      const parsed = SetRoomPresenceSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const { roomId, state } = parsed.data;
      const result = await p.withScope(
        authority,
        async (scope): Promise<Result<z.infer<typeof RoomPresenceAckSchema>>> => {
          const entered = await enterRoom(p, scope, roomId, 'read');
          if (entered?.member === undefined) return refuse('unavailable');
          const { lock, owner } = entered;
          const now = p.now();
          const previous = await p.positions.touch(lock, owner.accountId, now);
          const changed =
            state === 'here'
              ? (await p.presence.renew(lock, owner.accountId, now, ROOM_PRESENCE_LEASE_MS)) === 'began'
              : await p.presence.clear(lock, owner.accountId);
          if (changed) await p.rooms.announce(lock, now);
          // What time made due since anyone last looked (a debate's close, a constellation's name) settles with this beat (D-175).
          if (state === 'here') {
            await settleDue(p, lock, entered.standing.room.topic.id, now);
            await settleLaunches(p, lock, entered.standing.room.topic.id, now);
            await settleWatch(p, lock, now);
          }
          if (state === 'here' && changed && previous !== undefined)
            await openWindowOnReturn(
              p,
              scope,
              { lock, owner, room: entered.standing.room },
              entered.member,
              previous.hereUntil,
              now,
            );
          return ok(RoomPresenceAckSchema.parse({ ...roomEnvelope(scope), roomId, state }));
        },
      );
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
