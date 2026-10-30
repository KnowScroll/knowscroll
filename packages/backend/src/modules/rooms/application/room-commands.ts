import {
  InviteToRoomSchema,
  JoinRoomSchema,
  LeaveRoomSchema,
  ModerateRoomSchema,
  RoomInviteAcceptanceSchema,
  RoomJoinAcceptanceSchema,
  RoomLeaveAcceptanceSchema,
  RoomModerationAcceptanceSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { canRemove, defaultAiLevel, joinDecision, statusAfter } from '../domain/membership.js';
import { receiptBase, runCommand } from './command.js';
import { earlierPlaceOf, ok, refuse, type Result, type RoomPorts } from './ports.js';

/** The most friends of the caller read to learn whether a room's rule lets them in. */
const FRIEND_LOOKUP_LIMIT = 1000;

/**
 * The commands that change who is in a room and what it allows: join, leave, invite and the
 * moderator's pause, resume and removal. Each runs in the caller's personal scope and the room's
 * lock (FOR UPDATE), checks current authority, and commits its effect and receipt together. Joining
 * a room, leaving it and being invited are communication state: none is consumption evidence, and
 * joining never changes the person's universe. A member who leaves or is removed loses their presence
 * lease in the same transaction, and the room hears of it.
 */
export function makeRoomCommands(p: RoomPorts) {
  return {
    /**
     * Joins as a member. Refused (as `unavailable`) when the rule, the room's status, an earlier
     * removal or a missing sharing profile says no; the read of the room tells the person why.
     */
    join(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomJoinAcceptanceSchema>>> {
      const parsed = JoinRoomSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.room-join',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomJoinAcceptanceSchema,
        requires: 'anyone',
        mode: 'write',
        async decide({ scope, entered, member, now }) {
          if (member !== undefined) return refuse('unavailable');
          const { standing, owner, lock } = entered;
          const friends =
            standing.room.joinRule === 'friends_of_members' && !standing.invited
              ? await p.friends.accounts(scope, owner.accountId, FRIEND_LOOKUP_LIMIT)
              : [];
          const decision = joinDecision({
            rule: standing.room.joinRule,
            status: standing.room.status,
            earlier: earlierPlaceOf(standing.own),
            hasProfile: await p.people.hasProfile(scope, owner.accountId),
            invited: standing.invited,
            friendOfMember: friends.length > 0 && (await p.rooms.anyMember(lock, friends)),
          });
          if (!decision.allowed) return refuse('unavailable');
          return ok(async () => {
            const role = await p.rooms.join(lock, owner.accountId, defaultAiLevel(standing.room.joinRule), now);
            return RoomJoinAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.join',
              roomId: command.roomId,
              role,
            });
          });
        },
      });
    },

    /** Ends the caller's place. They can join again if the rule allows. Their messages stay. */
    leave(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomLeaveAcceptanceSchema>>> {
      const parsed = LeaveRoomSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.room-leave',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomLeaveAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        decide({ scope, entered, now }) {
          return Promise.resolve(
            ok(async () => {
              await p.rooms.end(entered.lock, entered.owner.accountId, 'left', now);
              await p.presence.clear(entered.lock, entered.owner.accountId);
              await p.rooms.announce(entered.lock, now);
              return RoomLeaveAcceptanceSchema.parse({
                ...receiptBase(scope, now, command.commandId),
                operation: 'room.leave',
                roomId: command.roomId,
              });
            }),
          );
        },
      });
    },

    /**
     * A member invites a current friend. The friend sees the invitation in their room list and may
     * join; nothing joins them. Every failure (not friends, already in, removed, room not open)
     * is the same `unavailable`, so it says nothing about the friend.
     */
    invite(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomInviteAcceptanceSchema>>> {
      const parsed = InviteToRoomSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.room-invite',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomInviteAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (standing.room.status !== 'open') return refuse('unavailable');
          const friendAccountId = await p.friends.byPerson(scope, owner.accountId, command.friendPersonId);
          if (friendAccountId === undefined) return refuse('unavailable');
          const earlier = await p.rooms.memberOf(lock, friendAccountId);
          if (earlier !== undefined && (earlier.endedBy === null || earlier.endedBy === 'removed'))
            return refuse('unavailable');
          return ok(async () => {
            await p.rooms.invite(lock, { inviteeAccountId: friendAccountId, inviterAccountId: owner.accountId, now });
            return RoomInviteAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.invite',
              roomId: command.roomId,
            });
          });
        },
      });
    },

    /**
     * A moderator pauses the room (members can read, nobody can post), resumes it, or removes an
     * ordinary member, who can then read nothing more and cannot join again. A pause or removal
     * that changes nothing is refused so a retry never claims an effect that did not happen.
     */
    moderate(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomModerationAcceptanceSchema>>> {
      const parsed = ModerateRoomSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.room-moderate',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomModerationAcceptanceSchema,
        requires: 'moderator',
        mode: 'write',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          const action = command.action;
          const accepted = () =>
            RoomModerationAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.moderate',
              roomId: command.roomId,
              action: action.kind,
            });
          if (action.kind === 'remove_member') {
            const targetAccountId = await p.people.accountOf(scope, action.personId);
            const target = targetAccountId === undefined ? undefined : await p.rooms.memberOf(lock, targetAccountId);
            if (targetAccountId === undefined || target === undefined || target.endedBy !== null)
              return refuse('unavailable');
            if (!canRemove({ accountId: owner.accountId }, target)) return refuse('unavailable');
            return ok(async () => {
              await p.rooms.end(lock, targetAccountId, 'removed', now);
              await p.presence.clear(lock, targetAccountId);
              await p.rooms.announce(lock, now);
              return accepted();
            });
          }
          const next = statusAfter(action.kind, standing.room.status);
          if (next === undefined) return refuse('unavailable');
          return ok(async () => {
            await p.rooms.setStatus(lock, next);
            return accepted();
          });
        },
      });
    },
  };
}
