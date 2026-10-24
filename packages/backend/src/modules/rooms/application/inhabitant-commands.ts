import { AskInhabitantSchema, InhabitantAskAcceptanceSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { askDecision, utcDayStart } from '../domain/contribution.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { receiptBase, runCommand } from './command.js';
import { ok, refuse, type Result, type RoomPorts } from './ports.js';

/**
 * Asks a labelled AI inhabitant to contribute. The inhabitant never speaks on its own: this command
 * is the only way a contribution begins, so the room is never filled and no human activity is
 * invented. The room is locked FOR UPDATE so the daily bounds (per room and per person) are exact,
 * and the request and its queued job commit together; the answer arrives later as an ordinary
 * message. The command starts no production and is no evidence for anyone.
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
          if (!roomAcceptsPosts(standing.room.status) || !standing.room.inhabitants.includes(command.inhabitant))
            return refuse('unavailable');
          if ((await p.discussions.load(lock, command.discussionId)) === undefined) return refuse('unavailable');
          const [counts, open] = await Promise.all([
            p.ai.countAsks(lock, { accountId: owner.accountId, since: utcDayStart(now) }),
            p.ai.openAsks(lock, command.discussionId, now),
          ]);
          const decision = askDecision({
            roomAsksToday: counts.room,
            personAsksToday: counts.person,
            personRequestsToday: counts.personRequests,
            openAsk: open.length > 0,
          });
          if (decision === 'preparing') return refuse('unavailable');
          if (decision !== 'allowed') return refuse('rate_limited');
          return ok(async () => {
            const requestId = p.newId();
            await p.ai.insert(lock, {
              requestId,
              roomId: command.roomId,
              discussionId: command.discussionId,
              inhabitant: command.inhabitant,
              requestedByAccountId: owner.accountId,
              commandId: command.commandId,
              state: 'queued',
              createdAt: now,
            });
            await p.enqueueContribution(scope, requestId);
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
