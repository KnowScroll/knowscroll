import { AskInhabitantSchema, InhabitantAskAcceptanceSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { askDecision, hourBefore, utcDayStart } from '../domain/contribution.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { receiptBase, runCommand } from './command.js';
import { hasResident, ok, refuse, type Result, type RoomPorts } from './ports.js';

/**
 * Asks a labelled AI inhabitant to contribute. An ask is one of the two ways a turn begins (the other is a
 * resident speaking on its own, `cast-due.ts`); it has its own bounds, apart from the unprompted caps, so a
 * member is always answered while the room is not full. The room is locked FOR UPDATE so the bounds (per room and
 * day, per person and hour) are exact, and the turn row and its queued job commit together; the answer arrives
 * later as an ordinary message. The command starts no production and is no evidence for anyone.
 */
export function makeInhabitantCommands(p: RoomPorts) {
  return {
    ask(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof InhabitantAskAcceptanceSchema>>> {
      const parsed = AskInhabitantSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.inhabitant-ask',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: InhabitantAskAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status) || !hasResident(standing.room, command.inhabitant))
            return refuse('unavailable');
          if ((await p.discussions.load(lock, command.discussionId)) === undefined) return refuse('unavailable');
          const [counts, open] = await Promise.all([
            p.ai.countAsks(lock, {
              accountId: owner.accountId,
              dayStart: utcDayStart(now),
              hourStart: hourBefore(now),
            }),
            p.ai.openAsks(lock, command.discussionId, now),
          ]);
          const decision = askDecision({
            roomAsksToday: counts.room,
            personAsksLastHour: counts.person,
            personRequestsLastHour: counts.personRequests,
            openAsk: open.length > 0,
          });
          if (decision === 'preparing') return refuse('unavailable');
          if (decision !== 'allowed') return refuse('rate_limited');
          return ok(async () => {
            const turnId = p.newId();
            await p.ai.insertAsk(lock, {
              turnId,
              trigger: 'asked',
              causeMessageId: null,
              held: null,
              roomId: command.roomId,
              discussionId: command.discussionId,
              inhabitant: command.inhabitant,
              requestedByAccountId: owner.accountId,
              commandId: command.commandId,
              state: 'queued',
              createdAt: now,
            });
            await p.enqueueContribution(scope, turnId);
            return InhabitantAskAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'inhabitant.ask',
              roomId: command.roomId,
              discussionId: command.discussionId,
              inhabitant: command.inhabitant,
            });
          });
        },
      });
    },
  };
}
