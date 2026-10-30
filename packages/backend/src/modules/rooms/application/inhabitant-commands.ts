import { AskInhabitantSchema, InhabitantAskAcceptanceSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { residentForAsk, type AskKind } from '../domain/asks.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { askDecisionFor, queueAsk } from './ask-turn.js';
import { receiptBase, runCommand } from './command.js';
import { hasResident, ok, refuse, type Result, type RoomPorts } from './ports.js';

/**
 * Asks a labelled AI inhabitant to contribute: the plain ask of a discussion, or one that points at a message (a
 * challenge, the other side, a question about it; D-167). An ask is one of the ways a turn begins (a resident
 * speaking on its own, `cast-due.ts`, and an @name in a message, `discussion-commands.ts`, are the others); it has
 * its own bounds, apart from the unprompted caps, so a member is always answered while the room is not full. The
 * room is locked FOR UPDATE so the bounds (per room and day, per person and hour) are exact, and the turn row and its
 * queued job commit together; the answer arrives later as an ordinary message. The command starts no production and is
 * no evidence for anyone.
 *
 * A pointed ask must name a message of the discussion that is shown to the member and whose author they have not
 * blocked: a member cannot make a resident read what they chose not to. The kind decides the resident (the Skeptic
 * tests or argues the other side, the Explainer answers).
 */
export function makeInhabitantCommands(p: RoomPorts) {
  return {
    ask(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof InhabitantAskAcceptanceSchema>>> {
      const parsed = AskInhabitantSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      const kind: AskKind = command.about?.kind ?? 'ask';
      const inhabitant = command.about === undefined ? command.inhabitant! : residentForAsk(command.about.kind);
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
          if (!roomAcceptsPosts(standing.room.status) || !hasResident(standing.room, inhabitant))
            return refuse('unavailable');
          if ((await p.discussions.load(lock, command.discussionId)) === undefined) return refuse('unavailable');
          if (command.about !== undefined) {
            const target = await p.discussions.messageById(lock, command.discussionId, command.about.messageId);
            if (target === undefined || target.hidden || (target.text === null && target.content === null))
              return refuse('unavailable');
            if (
              target.authorAccountId !== null &&
              (await p.blocked(scope, owner.accountId, [target.authorAccountId])).has(target.authorAccountId)
            )
              return refuse('unavailable');
          }
          const decision = await askDecisionFor(p, lock, owner.accountId, command.discussionId, now);
          if (decision === 'preparing') return refuse('unavailable');
          if (decision !== 'allowed') return refuse('rate_limited');
          return ok(async () => {
            await queueAsk(p, scope, lock, {
              kind,
              inhabitant,
              roomId: command.roomId,
              discussionId: command.discussionId,
              causeMessageId: command.about?.messageId ?? null,
              accountId: owner.accountId,
              commandId: command.commandId,
              now,
            });
            return InhabitantAskAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'inhabitant.ask',
              roomId: command.roomId,
              discussionId: command.discussionId,
              inhabitant,
              kind,
            });
          });
        },
      });
    },
  };
}
